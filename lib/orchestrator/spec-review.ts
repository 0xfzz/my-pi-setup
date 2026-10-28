/**
 * spec-review.ts — one pinned DOCUMENT, one independent reviewer, one gate.
 *
 * Split reviews (a wave of work-unit specs, one reviewer per chunk) live in
 * `chunk-run.ts` + `wave.ts` + `report-v2.ts`. This module used to carry that
 * flow too — lens presets, a batch pin, a reviewer per lens — and the leftovers
 * were how the old shape kept resurfacing. What is left is the single-reviewer
 * path it is actually good at: a design document or a PRD judged by a reader who
 * did not write it.
 *
 * Three invariants, each of which is a bug in the alternative:
 *
 *   1. The unit of review is a CONTENT HASH, not a document id. An artifact id
 *      survives an edit, so "approved" would silently transfer to text nobody
 *      reviewed. The sole exception is an exact, recorded patch proposed by the
 *      independent reviewer; the whole amendment chain is replayed by the gate.
 *   2. A missing or malformed report is NEVER a clean review. Absence of evidence
 *      is the commonest way a review gate decays into a rubber stamp.
 *   3. Findings are resolved explicitly. Nothing is "closed" by a timeout, and a
 *      blocker cannot be accepted without the user saying so.
 */
import { createHash } from "node:crypto";

import { replayReviewPatches, type ReviewPatch, type ReviewPatchRevision } from "./review-patches.ts";
import type { ReviewLens } from "./review-policy.ts";
import { renderLintForReviewer, type SpecLintFinding } from "./spec-lint.ts";

/**
 * The only lens a document review has.
 *
 * The identify survives in the report and in the reviewer's evidence scope so a
 * stale session from the old panel (`comprehension`, `critic`, …) fails closed
 * instead of writing into a run it does not own.
 */
export const DOCUMENT_LENS = "gate" as const satisfies ReviewLens;

export const RUBRIC_VERSION = "egm-lite-1";

export type Severity = "blocker" | "major" | "nit";

export interface PinnedTarget {
  /** Where it came from. The id is provenance, not identity. */
  kind: "artifact" | "file";
  ref: string;
  title: string;
  /** sha256 of `snapshot`. This is the identity a verdict is bound to. */
  contentHash: string;
  /** Immutable copy. The reviewer reads this, never the live document. */
  snapshot: string;
  rubricVersion: string;
  /** Repository paths the reviewer may consult. */
  references: string[];
  /** Recorded so the review states what the source looked like when it ran. */
  repoBaseline?: { head: string | null; dirty: string[] | null };
  createdAt: string;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(String(content ?? ""), "utf8").digest("hex");
}

export interface PinTargetInput {
  kind: "artifact" | "file";
  ref: string;
  title: string;
  content: string;
  references?: string[];
  repoBaseline?: { head: string | null; dirty: string[] | null };
  now?: Date;
}

export function pinTarget(input: PinTargetInput): PinnedTarget {
  const content = String(input.content ?? "");
  if (!content.trim()) {
    throw new Error(`Cannot pin an empty ${input.kind} as a review target (${input.ref}).`);
  }
  return {
    kind: input.kind,
    ref: input.ref,
    title: input.title?.trim() || input.ref,
    contentHash: hashContent(content),
    snapshot: content,
    rubricVersion: RUBRIC_VERSION,
    references: [...new Set((input.references ?? []).map((r) => String(r).trim()).filter(Boolean))],
    ...(input.repoBaseline ? { repoBaseline: input.repoBaseline } : {}),
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}

export interface ReviewFinding {
  id: string;
  lens: ReviewLens;
  severity: Severity;
  /** Section heading or line anchor inside the pinned snapshot. */
  location: string;
  discrepancy: string;
  rationale: string;
  references?: string[];
  suggestion?: string;
  /** Chunk reviews tag a finding with the member it belongs to. */
  memberId?: string;
  /** Exact replacement proposed by the independent reviewer. */
  patch?: ReviewPatch;
}

const SEVERITIES: readonly Severity[] = ["blocker", "major", "nit"];

export interface ReviewerReport {
  version: 1;
  runId: string;
  lens: ReviewLens;
  targetHash: string;
  summary: string;
  findings: ReviewFinding[];
  /**
   * How the reviewer finished.
   *
   * `blocked` means the reviewer could not complete its lens; it is not a clean
   * report with zero findings. Absent on reports written before this field
   * existed, which are treated as completed.
   */
  verdict?: "clean" | "findings" | "blocked";
  /** Context the reviewer could not find in the document, reported as evidence. */
  missingContext?: string[];
  /**
   * What this lens checked and found adequate.
   *
   * Required for an empty findings array. Without it the cheapest satisfying
   * report is the empty one — the equilibrium that turns a review gate into a
   * rubber stamp — and a "clean" verdict carries no evidence that anything was
   * read.
   */
  coverage?: string[];
  submittedAt: string;
}

export interface ParseResult {
  ok: boolean;
  report?: ReviewerReport;
  problems: string[];
}

/**
 * Coerce one untrusted finding.
 *
 * Ids are synthesised only when absent. Both reviewers share this parser: a
 * document report is one flat list, a chunk report is one list per member, so
 * the same validation (severity, location, rationale, patch shape) applies.
 */
export function parseFindingEntry(
  raw: any,
  idPrefix: string,
  index: number,
  options: { memberId?: string; lens?: ReviewFinding["lens"] } = {},
): { finding?: ReviewFinding; problem?: string } {
  if (!raw || typeof raw !== "object") return { problem: `finding ${index + 1} is not an object` };
  const severity = String(raw.severity ?? "").toLowerCase();
  if (!(SEVERITIES as readonly string[]).includes(severity)) {
    return { problem: `finding ${index + 1} has an invalid severity: ${String(raw.severity)}` };
  }
  const location = String(raw.location ?? "").trim();
  const discrepancy = String(raw.discrepancy ?? "").trim();
  const rationale = String(raw.rationale ?? "").trim();
  if (!location) return { problem: `finding ${index + 1} has no location` };
  if (!discrepancy) return { problem: `finding ${index + 1} has no discrepancy` };
  if (!rationale) return { problem: `finding ${index + 1} has no rationale` };
  // A finding belongs to the block that contains it. A payload cannot move it to
  // a sibling member by claiming a different memberId.
  const memberId = options.memberId
    ?? (typeof raw.memberId === "string" && raw.memberId.trim() ? raw.memberId.trim() : undefined);
  if (options.memberId && typeof raw.memberId === "string" && raw.memberId.trim() && raw.memberId.trim() !== options.memberId) {
    return {
      problem: `finding ${index + 1} names member "${raw.memberId.trim()}" inside the "${options.memberId}" block`,
    };
  }
  const references = Array.isArray(raw.references)
    ? raw.references.filter((value: unknown): value is string => typeof value === "string" && value.trim() !== "")
    : undefined;
  if (raw.patch !== undefined && (!raw.patch || typeof raw.patch.oldText !== "string" || !raw.patch.oldText
      || typeof raw.patch.newText !== "string" || raw.patch.oldText.length + raw.patch.newText.length > 128 * 1024)) {
    return { problem: `finding ${index + 1} has an invalid or oversized patch` };
  }
  return {
    finding: {
      ...(memberId ? { memberId } : {}),
      ...(raw.patch ? { patch: { oldText: raw.patch.oldText, newText: raw.patch.newText } } : {}),
      id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim().slice(0, 80) : `F-${idPrefix}-${index + 1}`,
      lens: options.lens ?? (typeof raw.lens === "string" && raw.lens.trim() ? raw.lens.trim() : DOCUMENT_LENS),
      severity: severity as Severity,
      location,
      discrepancy,
      rationale,
      ...(references?.length ? { references } : {}),
      ...(typeof raw.suggestion === "string" && raw.suggestion.trim() ? { suggestion: raw.suggestion.trim() } : {}),
    },
  };
}

/**
 * Validate a submitted document report.
 *
 * Identity fields are checked against the run, not trusted from the payload: a
 * reviewer that reports on a different target (or a resumed session replaying an
 * older answer) must fail here rather than be stitched into this run.
 */
export function parseReviewerReport(
  raw: unknown,
  expected: { runId: string; lens: ReviewLens; targetHash: string },
): ParseResult {
  let value: any = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch (error: any) {
      return { ok: false, problems: [`report is not valid JSON: ${error?.message ?? error}`] };
    }
  }
  if (!value || typeof value !== "object") return { ok: false, problems: ["report is not an object"] };

  const problems: string[] = [];
  if (value.version !== 1) problems.push(`unsupported report version: ${String(value.version)}`);
  if (value.runId !== expected.runId) problems.push(`report runId "${String(value.runId)}" does not match ${expected.runId}`);
  if (value.lens !== expected.lens) problems.push(`report lens "${String(value.lens)}" does not match ${expected.lens}`);
  if (value.targetHash !== expected.targetHash) {
    problems.push("report targetHash does not match the pinned target — it reviews a different revision");
  }
  const summary = String(value.summary ?? "").trim();
  if (!summary) problems.push("report has no summary");
  const verdict = value.verdict;
  if (verdict !== undefined && !["clean", "findings", "blocked"].includes(verdict)) {
    problems.push(`report has an invalid verdict: ${String(verdict)}`);
  }

  const rawFindings = Array.isArray(value.findings) ? value.findings : [];
  if (!Array.isArray(value.findings)) problems.push("report has no findings array");
  const findings: ReviewFinding[] = [];
  rawFindings.forEach((entry: any, index: number) => {
    const parsed = parseFindingEntry(entry, expected.lens, index, { lens: expected.lens });
    if (parsed.problem) problems.push(parsed.problem);
    else if (parsed.finding) findings.push(parsed.finding);
  });
  // Duplicate ids would make a disposition ambiguous: which finding was fixed?
  const seen = new Set<string>();
  for (const finding of findings) {
    if (seen.has(finding.id)) problems.push(`duplicate finding id: ${finding.id}`);
    seen.add(finding.id);
  }

  const missingContext = Array.isArray(value.missingContext)
    ? value.missingContext.filter((item: unknown): item is string => typeof item === "string" && item.trim() !== "")
    : undefined;
  const coverage = Array.isArray(value.coverage)
    ? value.coverage.filter((item: unknown): item is string => typeof item === "string" && item.trim() !== "")
    : undefined;
  // A `blocked` report is not claiming the document is clean — it is saying the
  // lens could not complete, which already blocks readiness. Every other empty
  // report has to state what it looked at, or "nothing found" is indistinguishable
  // from "nothing looked at".
  if (findings.length === 0 && verdict !== "blocked" && !coverage?.length) {
    problems.push(
      "an empty findings array needs coverage[]: state what this lens checked and found adequate, "
        + "otherwise \"nothing found\" is indistinguishable from \"nothing looked at\"",
    );
  }

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    problems: [],
    report: {
      version: 1,
      runId: expected.runId,
      lens: expected.lens,
      targetHash: expected.targetHash,
      summary,
      findings,
      ...(verdict ? { verdict } : {}),
      ...(missingContext?.length ? { missingContext } : {}),
      ...(coverage?.length ? { coverage } : {}),
      submittedAt: typeof value.submittedAt === "string" && value.submittedAt ? value.submittedAt : new Date().toISOString(),
    },
  };
}

export type ReviewerStatus = "pending" | "running" | "submitted" | "failed" | "blocked";

export interface ReviewerSlot {
  lens: ReviewLens;
  scope: string;
  status: ReviewerStatus;
  childId?: string;
  sessionFile?: string;
  paneId?: string;
  /** Set once a valid report is accepted; the file it was read from. */
  reportPath?: string;
  reason?: string;
  updatedAt: string;
}

export type DispositionAction = "fix" | "contested" | "accepted" | "unresolved";

export interface Disposition {
  action: DispositionAction;
  rationale: string;
  at: string;
  /** Which target hash the decision was made against. */
  targetHash: string;
  userConfirmed?: boolean;
  /** A replayable reviewer-authored patch closed this finding without another reader. */
  patched?: boolean;
  /** The document content before and after an orchestrator fix. */
  beforeHash?: string;
  afterHash?: string;
}

export type ReviewStatus = "collecting" | "collected" | "ready" | "blocked" | "cancelled";

export interface ReviewRun {
  id: string;
  target: PinnedTarget;
  patchRevisions?: ReviewPatchRevision[];
  /** Exactly one document reviewer; a chunk wave is a different record entirely. */
  reviewers: ReviewerSlot[];
  /** Full reports, keyed by lens. Only valid reports are stored. */
  reports: Partial<Record<ReviewLens, ReviewerReport>>;
  /** Dispositions keyed by finding id. */
  dispositions: Record<string, Disposition>;
  status: ReviewStatus;
  createdAt: string;
  updatedAt: string;
  /** Why readiness was last refused, so a status call does not re-derive an excuse. */
  readiness: {
    ready: boolean;
    decidedAt: string;
    reasons: string[];
    counts: { blocker: number; major: number; nit: number; open: number };
  };
  /** Rewrites observed after the pin; the run is then stale by definition. */
  supersededBy?: string;
  /**
   * Machine-detected defects computed at pin time, quoted into the ticket.
   *
   * A calibration aid, not a verdict: the reviewer must confirm or refute them,
   * and an empty list never means the document is good.
   */
  lint?: SpecLintFinding[];
}

export function reviewRunId(target: PinnedTarget, salt = ""): string {
  const digest = hashContent(`${target.kind}:${target.ref}:${target.contentHash}:${salt}`).slice(0, 10);
  return `sr-${digest}`;
}

export function reviewerScope(runId: string): string {
  return `review-${runId}-${DOCUMENT_LENS}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 64);
}

export function openReviewRun(input: { target: PinnedTarget; now?: Date; salt?: string }): ReviewRun {
  const now = (input.now ?? new Date()).toISOString();
  const id = reviewRunId(input.target, input.salt);
  return {
    id,
    target: input.target,
    reviewers: [
      {
        lens: DOCUMENT_LENS,
        scope: reviewerScope(id),
        status: "pending",
        updatedAt: now,
      },
    ],
    reports: {},
    dispositions: {},
    status: "collecting",
    createdAt: now,
    updatedAt: now,
    readiness: {
      ready: false,
      decidedAt: now,
      reasons: ["no reviewer report collected yet"],
      counts: { blocker: 0, major: 0, nit: 0, open: 0 },
    },
  };
}

export function allFindings(run: ReviewRun): ReviewFinding[] {
  return Object.values(run.reports)
    .flatMap((report) => report?.findings ?? [])
    .sort((a, b) => {
      const rank = (severity: Severity) => (severity === "blocker" ? 0 : severity === "major" ? 1 : 2);
      return rank(a.severity) - rank(b.severity) || a.id.localeCompare(b.id);
    });
}

/** Counts are what the parent reads: the full findings stay in the run record. */
export function findingCounts(findings: readonly ReviewFinding[]): { blocker: number; major: number; nit: number; open: number } {
  const counts = { blocker: 0, major: 0, nit: 0, open: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

export interface ReadinessVerdict {
  ready: boolean;
  reasons: string[];
  counts: { blocker: number; major: number; nit: number; open: number };
  /** True when a finding was resolved by editing the target. */
  requiresReReview: boolean;
}

/**
 * The gate.
 *
 * Every reason is reported, so a parent sees "report missing AND a blocker"
 * rather than fixing one and re-discovering the other.
 */
export function evaluateReadiness(run: ReviewRun, options: { now?: Date } = {}): ReadinessVerdict {
  const reasons: string[] = [];
  const findings = allFindings(run);
  const counts = findingCounts(findings);

  if (run.status === "cancelled") reasons.push("the review run was cancelled");

  const slot = run.reviewers[0];
  const report = run.reports[DOCUMENT_LENS];
  if (!report) {
    reasons.push(`no valid report from the reviewer (${slot?.status ?? "missing"})`);
  } else {
    if (report.targetHash !== run.target.contentHash) {
      reasons.push("the report reviews a different target revision");
    }
    // A reviewer that could not finish has not reviewed the document. Zero
    // findings from a blocked or context-starved pass is not a clean result.
    if (report.verdict === "blocked") reasons.push(`the reviewer is blocked: ${report.summary}`);
    if (report.missingContext?.length) {
      reasons.push(
        `the reviewer reported missing context: ${report.missingContext.slice(0, 3).join("; ")}`
          + (report.missingContext.length > 3 ? ` (+${report.missingContext.length - 3} more)` : ""),
      );
    }
  }
  if (slot?.status !== "submitted") reasons.push("the reviewer report is not in yet");

  let open = 0;
  let requiresReReview = false;
  for (const finding of findings) {
    const disposition = run.dispositions[finding.id];
    // Nits never gate readiness. They are still counted by severity so the parent
    // can see them, but an undisposed nit must not hold a work unit hostage.
    if (finding.severity === "nit") continue;
    if (!disposition) {
      open += 1;
      reasons.push(`unresolved ${finding.severity}: ${finding.id} (${finding.location})`);
      continue;
    }
    if (disposition.action === "unresolved" || disposition.action === "contested") {
      open += 1;
      reasons.push(`${finding.severity} ${finding.id} is ${disposition.action}`);
      continue;
    }
    if (disposition.action === "fix" && disposition.patched) {
      try {
        const recorded = run.patchRevisions?.some((revision) =>
          revision.changes.some((change) => change.findingId === finding.id
            && finding.patch && change.patch.oldText === finding.patch.oldText
            && change.patch.newText === finding.patch.newText));
        if (!recorded) throw new Error("missing reviewer patch receipt");
        replayReviewPatches(run.target.snapshot, run.target.ref, run.patchRevisions);
      } catch {
        open += 1;
        reasons.push(`invalid patch receipt for ${finding.id}`);
      }
      continue;
    }
    if (disposition.action === "fix") {
      // A fix edits the document, so the pinned target no longer exists as text.
      // The finding is resolved; the *approval* is not, because nobody has read
      // the replacement yet.
      requiresReReview = true;
      continue;
    }
    // accepted: a trade-off, but authority depends on severity.
    if (finding.severity === "blocker" && disposition.userConfirmed !== true) {
      open += 1;
      reasons.push(`blocker ${finding.id} is accepted as a trade-off but the user has not confirmed it`);
    } else if (!disposition.rationale.trim()) {
      open += 1;
      reasons.push(`${finding.severity} ${finding.id} is accepted without a rationale`);
    }
  }
  counts.open = open;

  if (requiresReReview) {
    reasons.push("the specification was revised to resolve findings; a fresh review of the new content is required");
  }

  const ready = reasons.length === 0;
  return {
    ready,
    reasons: [...new Set(reasons)],
    counts,
    requiresReReview,
  };
}

/** Apply the gate to the run record. Pure apart from the injected clock. */
export function settleReadiness(run: ReviewRun, options: { now?: Date } = {}): ReviewRun {
  const verdict = evaluateReadiness(run, options);
  const decidedAt = (options.now ?? new Date()).toISOString();
  return {
    ...run,
    status: verdict.ready ? "ready" : run.status === "cancelled" ? "cancelled" : "blocked",
    updatedAt: decidedAt,
    readiness: { ready: verdict.ready, decidedAt, reasons: verdict.reasons, counts: verdict.counts },
  };
}

export interface DispositionInput {
  findingId: string;
  action: DispositionAction;
  rationale?: string;
  userConfirmed?: boolean;
}

export interface ApplyResult {
  ok: boolean;
  run: ReviewRun;
  problems: string[];
}

/**
 * Record dispositions, then re-settle readiness.
 *
 * Refusals are returned rather than thrown so the caller can show every problem
 * at once: an orchestrator that fixes one finding per round because the tool
 * failed fast on the first is a cost multiplier.
 */
export function applyDispositions(
  run: ReviewRun,
  inputs: readonly DispositionInput[],
  options: { now?: Date } = {},
): ApplyResult {
  const now = (options.now ?? new Date()).toISOString();
  const problems: string[] = [];
  const known = new Map(allFindings(run).map((finding) => [finding.id, finding]));
  const dispositions = { ...run.dispositions };
  let changed = false;

  if (!inputs.length) problems.push("no dispositions were supplied");

  for (const input of inputs) {
    const finding = known.get(input.findingId);
    if (!finding) {
      problems.push(`unknown finding id: ${input.findingId}`);
      continue;
    }
    if (!["fix", "contested", "accepted", "unresolved"].includes(input.action)) {
      problems.push(`${input.findingId} has an invalid action: ${String(input.action)}`);
      continue;
    }
    const rationale = String(input.rationale ?? "").trim();
    if ((input.action === "accepted" || input.action === "contested") && !rationale) {
      problems.push(`${input.findingId} is ${input.action} and needs a rationale`);
      continue;
    }
    if (input.action === "accepted" && finding.severity === "blocker" && input.userConfirmed !== true) {
      problems.push(`${input.findingId} is a blocker; accepting it needs the user's confirmation`);
      continue;
    }
    dispositions[input.findingId] = {
      action: input.action,
      rationale,
      at: now,
      targetHash: run.target.contentHash,
      ...(input.userConfirmed === true ? { userConfirmed: true } : {}),
    };
    changed = true;
  }

  if (problems.length) return { ok: false, run, problems };
  const next: ReviewRun = { ...run, dispositions, updatedAt: now };
  return { ok: true, run: changed ? settleReadiness(next, options) : next, problems: [] };
}

/**
 * A target that no longer hashes to what was reviewed cannot stay ready.
 *
 * `currentContent` is whatever the caller can read now. Returning a reason
 * instead of mutating the run keeps the history honest: the old verdict stays
 * attached to the old hash, and a new run is opened for the new text.
 */
export function stalenessProblem(run: ReviewRun, currentContent: string | null): string | undefined {
  if (run.status === "cancelled") return "the review run was cancelled";
  if (currentContent === null) return "the pinned target could not be read back, so its content cannot be confirmed";
  const currentHash = hashContent(currentContent);
  let expected: string;
  try {
    expected = effectiveReviewTarget(run).contentHash;
  } catch {
    return "the reviewer patch chain is invalid";
  }
  if (currentHash !== expected) {
    return `the document changed since it was reviewed (reviewed ${expected.slice(0, 12)}, now ${currentHash.slice(0, 12)})`;
  }
  return undefined;
}

/** The `designRef` a handoff carries, so spawn can refuse a stale approval. */
export interface DesignRef {
  runId: string;
  targetHash: string;
  memberId?: string;
}

/** Reports remain bound to the original pin; the gate uses replay-verified amendments. */
export function effectiveReviewTarget(run: ReviewRun): PinnedTarget {
  const snapshot = replayReviewPatches(run.target.snapshot, run.target.ref, run.patchRevisions);
  return { ...run.target, snapshot, contentHash: hashContent(snapshot) };
}

export function designRefProblem(
  ref: DesignRef | undefined,
  lookup: (runId: string) => ReviewRun | undefined,
  currentContent: string | null,
): string | undefined {
  if (!ref) return "this handoff has no designRef, so no independent specification review backs it";
  const run = lookup(ref.runId);
  if (!run) return `design review ${ref.runId} is not known to this orchestrator`;
  let target: PinnedTarget;
  try {
    target = effectiveReviewTarget(run);
  } catch (error) {
    return String(error);
  }
  if (target.contentHash !== ref.targetHash) {
    return `design review ${ref.runId} covered ${target.contentHash.slice(0, 12)}, not ${ref.targetHash.slice(0, 12)}`;
  }
  if (!run.readiness.ready) {
    return `design review ${ref.runId} is not ready: ${run.readiness.reasons.join("; ") || "no reason recorded"}`;
  }
  if (currentContent === null) return "the pinned target could not be read back, so its content cannot be confirmed";
  if (run.status === "cancelled") return "the review run was cancelled";
  return hashContent(currentContent) === target.contentHash ? undefined : "the document changed since it was reviewed";
}

/**
 * The document rubric.
 *
 * The former lens panel is gone; this is the merged text a single reviewer
 * applies. A second opinion is a chunk split, not a second reader of this text.
 */
export const GATE_RUBRIC = `Judge whether a competent engineer who has never spoken to the author could implement this as written, and whether the result could be verified.
Flag every term, service, file, interface or prerequisite that is not defined in the document or reachable from the permitted repository paths.
Flag hand-waving ("the system handles it"), assumed workflow steps, and any requirement whose acceptance cannot be observed.
Check that named paths, modules, functions and interfaces exist or are created by this plan; that dependencies and migrations are named; and that a verification command could plausibly fail.
Report contradictions between sections as findings, not as questions.`;

export function renderReviewerTicket(input: {
  runId: string;
  target: PinnedTarget;
  /** Extra instruction from the parent (still no author reasoning). */
  focus?: string;
  /** Machine-detected defects to confirm or refute. Never a verdict. */
  lint?: readonly SpecLintFinding[];
  policy: { roots: string[] };
}): string {
  const { target } = input;
  const references = target.references.length
    ? target.references.map((reference) => `- \`${reference}\``).join("\n")
    : "- (none supplied — judge the document on its own text)";
  return `# Independent specification review

You are reviewing a specification you did not write. You have no history with its
author and cannot ask them anything. A gap you cannot close from the document or
the permitted files below is a finding, not something to infer.

## Isolation (facts about your session)
- You did not inherit any parent conversation and you cannot pull one.
- You have no write tool. The document is quoted below; you cannot change it.
- If something is unclear, report it. Do not reconstruct the author's intent.

## Rubric
${GATE_RUBRIC}

## Permitted reference paths
${references}
${input.focus ? `\n## Focus requested by the orchestrator\n${input.focus}\n` : ""}
## Pinned document (${target.kind}: ${target.ref})
Version: ${target.contentHash.slice(0, 12)} · rubric: ${target.rubricVersion} · pinned: ${target.createdAt}
The text between the markers is the exact revision under review. Any difference from
the live document is out of scope; if you find one, report it as a finding.

<<<PINNED_TARGET_START ${target.contentHash}>>>
${target.snapshot}
<<<PINNED_TARGET_END>>>
${renderLintForReviewer(input.lint ?? [])}
## How to report
Call \`orch_spec_review_submit\` exactly once, with:
- verdict-level \`summary\` (2-4 sentences, plain English, no praise);
- \`findings[]\` — each with \`severity\` (blocker | major | nit), \`location\`
  (section heading or line number inside the pinned text), \`discrepancy\`
  (what is wrong), \`rationale\` (why it matters), optional \`references\`,
  optional \`suggestion\`;
- \`coverage[]\` — what you checked and found adequate. REQUIRED when your
  findings array is empty: a clean report has to say what it looked at, or
  "nothing found" cannot be told apart from "nothing looked at";
- \`missingContext[]\` for anything you needed and could not find.

Blockers are reserved for defects that make implementation unsafe or impossible.
Do not file style opinions as blockers. Do not report a finding you cannot tie to
a location. If the document is genuinely adequate, submit an empty findings array
WITH coverage, and say in the summary what makes you confident.
`;
}

export function renderRunSummary(run: ReviewRun): string {
  const counts = run.readiness.counts;
  const slot = run.reviewers[0];
  const lines = [
    `Spec review ${run.id} · target ${run.target.contentHash.slice(0, 12)} (${run.target.kind}: ${run.target.ref})`,
    `Status: ${run.status}${run.readiness.ready ? " — READY" : ""}`,
    `Findings: ${counts.blocker} blocker, ${counts.major} major, ${counts.nit} nit · ${counts.open} open`,
    `Reviewer: ${slot ? `${slot.lens}=${slot.status}` : "none"}`,
  ];
  if (run.readiness.reasons.length) {
    lines.push(`Not ready:`, ...run.readiness.reasons.map((reason) => `- ${reason}`));
  }
  const findings = allFindings(run);
  if (findings.length) {
    lines.push(`Findings by id:`);
    for (const finding of findings) {
      const disposition = run.dispositions[finding.id];
      lines.push(
        `- ${finding.id} [${finding.severity}] ${finding.location} — ${finding.discrepancy}`
          + (disposition ? ` → ${disposition.action}${disposition.rationale ? ` (${disposition.rationale})` : ""}` : ""),
      );
    }
  }
  if (run.target.references.length) lines.push(`References: ${run.target.references.join(", ")}`);
  return lines.join("\n");
}
