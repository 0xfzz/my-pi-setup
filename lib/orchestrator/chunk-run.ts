/**
 * chunk-run.ts — one split review: K chunks, N work-unit specs, per-member state.
 *
 * This is the parent-side record for the flow the orchestrator is supposed to run:
 *
 *   PRD + N specs → K chunks → one reviewer per chunk → fix specs → spawn workers
 *
 * It is deliberately NOT the document `ReviewRun`: that one has one pinned target
 * and a reviewer per lens, which is the shape that made a 5-spec wave either cost
 * one reviewer for everything or a full re-review after every fix. A chunk run has
 * many members, K reviewers, and readiness per member.
 *
 * Pure: no panes, no filesystem, no pi imports. The extension owns launching and
 * artifact writes; this module owns what the record means.
 */
import { createHash } from "node:crypto";

import { hashContent, type Disposition, type ReviewFinding } from "./spec-review.ts";
import { chunkContentHash, chunkMemberFacts, parseChunkReport, type ChunkMemberPin, type ChunkReport } from "./report-v2.ts";
import {
  MAX_MEMBER_RE_REVIEWS,
  evaluateWave,
  planSpecChunks,
  type MemberReportFacts,
  type SpecChunk,
  type WaveEvaluation,
  type WaveMember,
} from "./wave.ts";

export const CHUNK_RUN_KIND = "split" as const;

export interface ChunkSlot {
  /** `review-1` … `review-K`. Also the reviewer's artifact scope. */
  chunkId: string;
  scopes: string[];
  /** Hash of the pinned chunk content, so the report cannot be stitched elsewhere. */
  targetHash: string;
  status: "pending" | "running" | "submitted" | "failed";
  childId?: string;
  sessionFile?: string;
  paneId?: string;
  report?: ChunkReport;
  reason?: string;
  updatedAt: string;
}

export interface ChunkRun {
  kind: typeof CHUNK_RUN_KIND;
  id: string;
  chunks: ChunkSlot[];
  members: WaveMember[];
  dispositions: Record<string, Disposition>;
  status: "collecting" | "collected" | "ready" | "cancelled";
  /** The PRD every chunk is judged against, pinned when the run opens. */
  prd?: { ref: string; title: string; contentHash: string; snapshot: string };
  createdAt: string;
  updatedAt: string;
}

/** Deterministic: same members, same revision, same split → same run id. */
export function chunkRunId(input: { scopes: readonly string[]; memberHashes: Record<string, string>; salt?: string }): string {
  const body = [...input.scopes]
    .sort()
    .map((scope) => `${scope}:${input.memberHashes[scope] ?? ""}`)
    .join("\n");
  return `cr-${createHash("sha256").update(`${body}\n${input.salt ?? ""}`, "utf8").digest("hex").slice(0, 10)}`;
}

/** Hash of one member's pinned content: what a report and a designRef bind to. */
export function memberContentHash(content: string): string {
  return hashContent(content);
}

/** Hash over the whole chunk, matching `chunkContentHash` on the reviewer's side. */
export function slotTargetHash(pins: readonly ChunkMemberPin[]): string {
  return chunkContentHash(pins);
}

export function openChunkRun(input: {
  id: string;
  chunks: readonly SpecChunk[];
  members: readonly WaveMember[];
  prd?: ChunkRun["prd"];
  now?: Date;
}): ChunkRun {
  const now = (input.now ?? new Date()).toISOString();
  return {
    kind: CHUNK_RUN_KIND,
    id: input.id,
    chunks: input.chunks.map((chunk) => ({
      chunkId: chunk.id,
      scopes: [...chunk.scopes],
      targetHash: "",
      status: "pending",
      updatedAt: now,
    })),
    members: input.members.map((member) => ({
      ...member,
      amendments: [...member.amendments],
      ...(member.chunkId ? { chunkId: member.chunkId } : {}),
    })),
    dispositions: {},
    status: "collecting",
    ...(input.prd ? { prd: input.prd } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

export function slotFor(run: ChunkRun, chunkId: string): ChunkSlot | undefined {
  return run.chunks.find((slot) => slot.chunkId === chunkId);
}

export function memberFor(run: ChunkRun, scope: string): WaveMember | undefined {
  return run.members.find((member) => member.scope === scope);
}

export function allRunFindings(run: ChunkRun): ReviewFinding[] {
  return run.chunks.flatMap((slot) => slot.report?.members.flatMap((block) => block.findings) ?? []);
}

/**
 * Ingest one chunk report.
 *
 * Validation is against the slot's own member set and hash, so a reviewer cannot
 * file a report for a chunk it was not given. A failed report marks the slot
 * failed with the reasons; it never partially applies findings.
 */
export function ingestChunkReport(
  run: ChunkRun,
  chunkId: string,
  raw: unknown,
  options: { now?: Date } = {},
): { ok: true; run: ChunkRun } | { ok: false; run: ChunkRun; problems: string[] } {
  const now = (options.now ?? new Date()).toISOString();
  const slot = slotFor(run, chunkId);
  if (!slot) return { ok: false, run, problems: [`unknown chunk ${chunkId}`] };
  const parsed = parseChunkReport(raw, {
    runId: run.id,
    chunkId,
    targetHash: slot.targetHash,
    memberIds: slot.scopes,
  });
  if (!parsed.ok || !parsed.report) {
    const failed: ChunkRun = {
      ...run,
      updatedAt: now,
      chunks: run.chunks.map((entry) =>
        entry.chunkId === chunkId ? { ...entry, status: "failed", reason: parsed.problems.join("; "), updatedAt: now } : entry,
      ),
    };
    return { ok: false, run: failed, problems: parsed.problems };
  }
  const next: ChunkRun = {
    ...run,
    updatedAt: now,
    chunks: run.chunks.map((entry) =>
      entry.chunkId === chunkId
        ? { ...entry, status: "submitted", report: parsed.report, reason: undefined, updatedAt: now }
        : entry,
    ),
  };
  return { ok: true, run: next };
}

export interface ChunkRunEvaluation extends WaveEvaluation {
  counts: { blocker: number; major: number; nit: number; open: number };
  /** Slots whose reviewer has not filed a valid report yet. */
  waiting: string[];
  findings: ReviewFinding[];
}

/** The run's state, derived from its reports and dispositions. */
export function evaluateChunkRun(run: ChunkRun): ChunkRunEvaluation {
  const reports: Record<string, MemberReportFacts> = {};
  for (const slot of run.chunks) {
    if (slot.report) Object.assign(reports, chunkMemberFacts(slot.report));
  }
  const findings = allRunFindings(run);
  const evaluation = evaluateWave({
    members: run.members,
    findings,
    dispositions: run.dispositions,
    reports,
    started: true,
    closed: run.status === "cancelled",
  });
  const counts = { blocker: 0, major: 0, nit: 0, open: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  for (const member of evaluation.members) counts.open += member.open.length;
  return {
    ...evaluation,
    counts,
    waiting: run.chunks.filter((slot) => slot.status !== "submitted").map((slot) => slot.chunkId),
    findings,
  };
}

/**
 * Record the orchestrator's own fix of one member.
 *
 * `structural` is decided by the caller from the parsed document (see
 * `structuralChanges`). A prose fix keeps the approval and binds `afterHash`; a
 * structural fix records the amendment but marks the member as needing a fresh
 * review, for that member only.
 */
export function recordMemberFix(
  run: ChunkRun,
  input: {
    findingId: string;
    memberId: string;
    beforeHash: string;
    afterHash: string;
    rationale: string;
    revision: number;
    structural: string[];
    now?: Date;
  },
): { ok: true; run: ChunkRun } | { ok: false; run: ChunkRun; problems: string[] } {
  const now = (input.now ?? new Date()).toISOString();
  const member = memberFor(run, input.memberId);
  if (!member) return { ok: false, run, problems: [`unknown member ${input.memberId}`] };
  const finding = allRunFindings(run).find((entry) => entry.id === input.findingId);
  if (!finding) return { ok: false, run, problems: [`unknown finding id: ${input.findingId}`] };
  if (finding.memberId !== input.memberId) {
    return { ok: false, run, problems: [`finding ${input.findingId} belongs to ${finding.memberId ?? "no member"}, not ${input.memberId}`] };
  }
  const structural = input.structural.length > 0;
  const next: ChunkRun = {
    ...run,
    updatedAt: now,
    dispositions: {
      ...run.dispositions,
      [input.findingId]: {
        action: "fix",
        rationale: input.rationale,
        at: now,
        targetHash: member.reviewedHash,
        beforeHash: input.beforeHash,
        afterHash: input.afterHash,
      },
    },
    members: run.members.map((entry) =>
      entry.scope === input.memberId
        ? {
            ...entry,
            currentHash: input.afterHash,
            revision: input.revision,
            amendments: [
              ...entry.amendments,
              {
                findingId: input.findingId,
                beforeHash: input.beforeHash,
                afterHash: input.afterHash,
                rationale: input.rationale,
                at: now,
              },
            ],
            ...(structural ? { needsReReview: { findingId: input.findingId, reason: input.structural.join(", ") } } : {}),
          }
        : entry,
    ),
  };
  return { ok: true, run: next };
}

/**
 * A fresh review round covering one member, after a structural change.
 *
 * Clears `needsReReview`, bumps that member's own re-review count, and rebinds the
 * reviewed hash. Only the affected member is re-reviewed; siblings keep theirs.
 */
export function recordMemberReReview(
  run: ChunkRun,
  input: { memberId: string; reviewedHash: string; chunkId: string; now?: Date },
): ChunkRun {
  const now = (input.now ?? new Date()).toISOString();
  return {
    ...run,
    updatedAt: now,
    members: run.members.map((member) =>
      member.scope === input.memberId
        ? {
            ...member,
            reviewedHash: input.reviewedHash,
            currentHash: input.reviewedHash,
            chunkId: input.chunkId,
            reReviewRounds: Math.min(MAX_MEMBER_RE_REVIEWS, member.reReviewRounds + 1),
            needsReReview: undefined,
          }
        : member,
    ),
  };
}

export function markStatus(run: ChunkRun, status: ChunkRun["status"], now = new Date()): ChunkRun {
  return { ...run, status, updatedAt: now.toISOString() };
}

/** Reviewer progress line for the parent, one per chunk. */
export function renderChunkProgress(run: ChunkRun): string[] {
  return run.chunks.map(
    (slot) =>
      `${slot.chunkId} [${slot.scopes.join(", ")}] — ${slot.status}`
      + (slot.reason ? `: ${slot.reason}` : ""),
  );
}

/** Plan helpers re-exported so the extension imports one module for a split run. */
export { planSpecChunks };
