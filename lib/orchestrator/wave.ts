/**
 * wave.ts — the state of one review wave, and what may happen to each of its
 * members.
 *
 * The unit of review here is a CHUNK of work-unit specs, not a document and not a
 * lens. That is a deliberate correction: fanning reviewers out by lens made every
 * reader read the whole wave (K readers × N specs), while the flow that actually
 * works is N specs → K chunks → one reader per chunk (N specs total, read once).
 *
 * Two properties this module exists to guarantee:
 *
 *   1. Readiness is PER MEMBER. A wave is not all-or-nothing: one spec can go to a
 *      worker while its sibling is still being fixed. A run-level boolean is what
 *      made "fix one spec" cost a whole review round.
 *   2. A fix is not a hole in the gate. A `fix` disposition is only settled by a
 *      recorded amendment whose `afterHash` equals the member's current content.
 *      Structural fields (lane, criteria, interfaces, report shape, vision) cannot
 *      be changed by a fix at all — those need re-authoring and a fresh review, of
 *      that member only.
 *
 * Pure: no I/O, no panes, no clock reads a test cannot inject.
 */
import { balancedChunks, chunkCount } from "./chunking.ts";
import type { Disposition, ReviewFinding, Severity } from "./spec-review.ts";

/** Beyond three specs a review stops being a review and becomes a skim. */
export const MAX_UNITS_PER_SPEC_REVIEWER = 3;
export const MAX_SPEC_REVIEWERS = 3;
/** Largest wave one review round may cover; bigger splits are two rounds. */
export const MAX_SPEC_UNITS_PER_WAVE = MAX_UNITS_PER_SPEC_REVIEWER * MAX_SPEC_REVIEWERS;

export interface SpecChunk {
  /** `review-1` … `review-K`: the reviewer's identity and artifact scope. */
  id: string;
  scopes: string[];
}

export type SpecChunkPlan =
  | { ok: true; chunks: SpecChunk[] }
  | { ok: false; problems: string[] };

/**
 * Split work-unit scopes across specification reviewers.
 *
 * Deterministic: the same set always produces the same chunks in the same order,
 * so a `plan` call is a promise the `start` call can keep.
 */
export function planSpecChunks(
  scopes: readonly string[],
  options: { reviewers?: number } = {},
): SpecChunkPlan {
  const cleaned = scopes.map((scope) => String(scope ?? "").trim()).filter(Boolean);
  const problems: string[] = [];

  if (!cleaned.length) problems.push("give at least one handoff scope to review");
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const scope of cleaned) {
    if (seen.has(scope)) duplicates.add(scope);
    seen.add(scope);
  }
  if (duplicates.size) problems.push(`listed twice: ${[...duplicates].join(", ")}`);
  // Deterministic: the same set always produces the same chunks in the same order,
  // so a `plan` call is a promise the `start` call can keep. Sorting here (not in
  // the caller) is what makes a plan shown to the user identical to the wave that
  // is launched, whatever order the handoffs were listed in.
  const ordered = [...new Set(cleaned)].sort((a, b) => a.localeCompare(b));
  if (ordered.length > MAX_SPEC_UNITS_PER_WAVE) {
    problems.push(
      `at most ${MAX_SPEC_UNITS_PER_WAVE} specs per review wave (got ${ordered.length}); split the wave or run a second round`,
    );
  }
  if (problems.length) return { ok: false, problems };

  const minimum = chunkCount(ordered.length, {
    maxPerChunk: MAX_UNITS_PER_SPEC_REVIEWER,
    maxChunks: MAX_SPEC_REVIEWERS,
  });
  let count = minimum;
  if (options.reviewers != null) {
    if (!Number.isFinite(options.reviewers) || !Number.isInteger(options.reviewers)) {
      return { ok: false, problems: ["reviewers must be a whole number"] };
    }
    if (options.reviewers < minimum) {
      return {
        ok: false,
        problems: [
          `${ordered.length} specs need at least ${minimum} reviewer(s) at ${MAX_UNITS_PER_SPEC_REVIEWER} specs each`,
        ],
      };
    }
    if (options.reviewers > MAX_SPEC_REVIEWERS) {
      return { ok: false, problems: [`the cap is ${MAX_SPEC_REVIEWERS} specification reviewers`] };
    }
    count = options.reviewers;
  }

  // Remainder on the later chunks, so five specs read as 2 + 3 — the same shape
  // the QA phase uses for five units.
  const chunks = balancedChunks(ordered, count).map((members, index) => ({
    id: `review-${index + 1}`,
    scopes: members,
  }));
  return { ok: true, chunks };
}

/** A fix the orchestrator applied to one member's handoff. */
export interface MemberAmendment {
  findingId: string;
  beforeHash: string;
  afterHash: string;
  rationale: string;
  at: string;
}

export interface WaveMember {
  scope: string;
  handoffId: string;
  artifactId: string;
  chunkId?: string;
  /** The content the reviewer actually judged. Never rewritten. */
  reviewedHash: string;
  /** The content a worker would receive now, after applied fixes. */
  currentHash: string;
  /** Handoff revision bound to `currentHash`. */
  revision: number;
  amendments: MemberAmendment[];
}

/** What the member's chunk reviewer reported about it. */
export interface MemberReportFacts {
  /** The chunk's report was collected and validated. */
  submitted: boolean;
  verdict?: "clean" | "findings" | "blocked";
  missingContext?: string[];
  /** A member block with non-empty coverage was present. */
  covered: boolean;
}

export interface OpenFinding {
  id: string;
  severity: Severity;
  location: string;
  discrepancy: string;
}

export interface MemberReadiness {
  scope: string;
  ready: boolean;
  reasons: string[];
  open: OpenFinding[];
}

/** A finding gates only when it is a blocker or major; a nit is advice. */
function gating(finding: ReviewFinding): boolean {
  return finding.severity === "blocker" || finding.severity === "major";
}

/**
 * Decide whether ONE member may go to a worker.
 *
 * Every reason is returned, not just the first: a parent that fixes one finding
 * per tool call because the gate failed fast on the first is a cost multiplier.
 */
export function evaluateMemberReadiness(input: {
  member: Pick<WaveMember, "scope" | "reviewedHash" | "currentHash">;
  findings: readonly ReviewFinding[];
  dispositions: Record<string, Disposition>;
  report: MemberReportFacts;
}): MemberReadiness {
  const { member, dispositions, report } = input;
  const reasons: string[] = [];
  const open: OpenFinding[] = [];

  if (!report.submitted) reasons.push("the chunk reviewer has not reported yet");
  if (report.verdict === "blocked") {
    reasons.push("the reviewer could not finish this chunk; a blocked report is not a clean one");
  }
  if (report.missingContext?.length) {
    reasons.push(`the reviewer reported missing context: ${report.missingContext.slice(0, 3).join("; ")}`);
  }
  if (report.submitted && !report.covered) {
    reasons.push("the reviewer filed no coverage for this member; an unread spec is not a clean one");
  }

  for (const finding of input.findings) {
    if (!gating(finding)) continue;
    const disposition = dispositions[finding.id];
    if (!disposition) {
      open.push({ id: finding.id, severity: finding.severity, location: finding.location, discrepancy: finding.discrepancy });
      reasons.push(`unresolved ${finding.severity}: ${finding.id} (${finding.location})`);
      continue;
    }
    if (disposition.action === "unresolved") {
      open.push({ id: finding.id, severity: finding.severity, location: finding.location, discrepancy: finding.discrepancy });
      reasons.push(`${finding.severity} ${finding.id} is unresolved`);
      continue;
    }
    if (disposition.action === "contested") {
      open.push({ id: finding.id, severity: finding.severity, location: finding.location, discrepancy: finding.discrepancy });
      reasons.push(`${finding.severity} ${finding.id} is contested; the user has to decide`);
      continue;
    }
    if (disposition.action === "accepted") {
      if (!String(disposition.rationale ?? "").trim()) {
        reasons.push(`${finding.severity} ${finding.id} is accepted without a rationale`);
      } else if (finding.severity === "blocker" && disposition.userConfirmed !== true) {
        reasons.push(`blocker ${finding.id} is accepted as a trade-off but the user has not confirmed it`);
      }
      continue;
    }
    // fix: settled only by an amendment whose afterHash is the content now.
    const applied = disposition.afterHash && disposition.afterHash === member.currentHash;
    if (!applied) {
      open.push({ id: finding.id, severity: finding.severity, location: finding.location, discrepancy: finding.discrepancy });
      reasons.push(
        `fix for ${finding.id} is recorded but not applied to the current spec `
          + `(spec is ${member.currentHash.slice(0, 12)})`,
      );
    }
  }

  return { scope: member.scope, ready: reasons.length === 0, reasons: [...new Set(reasons)], open };
}

export type WavePhase = "drafting" | "reviewing" | "revising" | "spawnable" | "closed";

export interface WaveEvaluation {
  phase: WavePhase;
  members: MemberReadiness[];
  /** Members a worker may be spawned against right now. */
  ready: string[];
  /** True when every member is ready; the common case for a clean wave. */
  allReady: boolean;
}

/**
 * The wave's state, derived rather than stored.
 *
 * A stored phase is a second authority that drifts from the members. Deriving it
 * means "spawnable" cannot be true while a member has an open blocker.
 */
export function evaluateWave(input: {
  members: readonly WaveMember[];
  findings: readonly ReviewFinding[];
  dispositions: Record<string, Disposition>;
  /** Member facts keyed by scope; absent means "not reported yet". */
  reports: Record<string, MemberReportFacts>;
  started: boolean;
  closed?: boolean;
}): WaveEvaluation {
  const members = input.members.map((member) =>
    evaluateMemberReadiness({
      member,
      findings: input.findings.filter((finding) => finding.memberId === member.scope),
      dispositions: input.dispositions,
      report: input.reports[member.scope] ?? { submitted: false, covered: false },
    }),
  );
  const ready = members.filter((entry) => entry.ready).map((entry) => entry.scope);
  const allReady = members.length > 0 && ready.length === members.length;

  let phase: WavePhase;
  if (input.closed) phase = "closed";
  else if (!input.started) phase = "drafting";
  else if (members.some((member) => input.reports[member.scope]?.submitted)) phase = "revising";
  else phase = "reviewing";
  // A ready member is spawnable even while its siblings are still being fixed:
  // per-member readiness is the point, not a wave-wide boolean.
  if (phase !== "closed" && ready.length > 0) phase = "spawnable";

  return { phase, members, ready, allReady };
}

export type SpawnRefusalCode = "not-ready" | "document-changed";

/**
 * Why this member may not be spawned, or `undefined` when it may.
 *
 * `currentHash` is the hash of the document a worker would receive now, computed
 * by the caller from the artifact. A mismatch with the reviewed/revised content is
 * a refusal, not a warning: approving a revision nobody read is the failure this
 * whole mechanism exists to prevent.
 */
export function spawnGateProblem(input: {
  member: WaveMember;
  readiness: MemberReadiness;
  currentHash: string;
}): { code: SpawnRefusalCode; message: string } | undefined {
  const { member, readiness, currentHash } = input;
  if (currentHash !== member.currentHash) {
    return {
      code: "document-changed",
      message:
        `the spec artifact is ${currentHash.slice(0, 12)} but the wave bound ${member.currentHash.slice(0, 12)}; `
        + `re-author the handoff or the review is approving text nobody read`,
    };
  }
  if (!readiness.ready) {
    return { code: "not-ready", message: readiness.reasons.join("; ") };
  }
  return undefined;
}

/**
 * Fields a fix may not change.
 *
 * These are the contract a reviewer judged and a worker will be held to. A prose
 * clarification (goal wording, notes) is a fix; changing the lane, the criteria,
 * the interfaces, the vision, or the required report shape is a different spec,
 * and it goes back for review — for that member only, never for the wave.
 */
export interface HandoffContractFields {
  scope: string;
  acceptanceCriteria: string[];
  laneFiles: string[];
  outOfLaneFiles: string[];
  interfaces: string[];
  reportShape: string;
  vision?: string;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const left = [...a].map((entry) => entry.trim()).filter(Boolean).sort();
  const right = [...b].map((entry) => entry.trim()).filter(Boolean).sort();
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
};
const sameList = (a: readonly string[], b: readonly string[]): boolean => {
  const left = [...a].map((entry) => entry.trim());
  const right = [...b].map((entry) => entry.trim());
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
};

/** Names of the fields a proposed edit would change. Empty means prose-only. */
export function structuralChanges(before: HandoffContractFields, after: HandoffContractFields): string[] {
  const changes: string[] = [];
  if (before.scope.trim() !== after.scope.trim()) changes.push("scope");
  if (!sameList(before.acceptanceCriteria, after.acceptanceCriteria)) changes.push("acceptance criteria");
  if (!sameSet(before.laneFiles, after.laneFiles)) changes.push("lane files");
  if (!sameSet(before.outOfLaneFiles, after.outOfLaneFiles)) changes.push("out-of-lane files");
  if (!sameList(before.interfaces, after.interfaces)) changes.push("interfaces");
  if (before.reportShape.trim() !== after.reportShape.trim()) changes.push("report shape");
  if ((before.vision ?? "").trim() !== (after.vision ?? "").trim()) changes.push("vision");
  return changes;
}
