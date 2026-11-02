/**
 * handoff-artifact.ts — the handoff as a durable, frozen document.
 *
 * The rule this module exists to enforce, in the user's words:
 *
 *   A HANDOFF is a document the PARENT sends to a CHILD (and the child's report
 *   is the document back). The child cannot modify the handoff it was given.
 *
 * Before this module the assignment was inlined into the launch ticket and
 * nothing persisted it. That made three things impossible:
 *
 *   - The parent could not cite the exact text it judged, so "the child did not
 *     do what the handoff said" was an appeal to a transcript.
 *   - A re-spawn could not say "fix the part that does not match the FIRST
 *     handoff", because there was no first handoff to compare against.
 *   - A child could implement from memory of the ticket and nothing noticed.
 *
 * So the handoff is written as a SCOPED ARTIFACT whose id starts `handoff-`:
 *
 *   - `extensions/artifacts.ts` refuses `artifact_save`/`artifact_edit` on a
 *     `handoff-*` id from a child session, which is the freeze. The refusal is
 *     in the artifact layer, not in a prompt, because a prompt is a request.
 *   - The child's ticket becomes a POINTER to that artifact plus the contract at
 *     a glance, so the child can still work if the catalog is unavailable —
 *     but the ticket says an unavailable handoff is a blocker to escalate.
 *   - Scope is enforced by the artifact layer: a child inherits only global
 *     artifacts and its own scope, so a sibling's handoff is filtered out before
 *     the child can see it. Distance in a prompt is not a boundary; absence from
 *     the catalog is.
 *
 * A handoff is never rewritten in place. A rework authors a NEW handoff that
 * quotes the original plus the defect list (see `rework-` ids), so an approval
 * or a verdict can never be transferred to text nobody read.
 */

/** The artifact id a parent hands to a child. `n` counts reworks, starting at 1. */
export function handoffArtifactId(scope: string, round = 1): string {
  return `handoff-${scope}-${Math.max(1, Math.trunc(round))}`;
}

/** The artifact id a child writes its report to. */
export function reportArtifactId(scope: string, round = 1): string {
  return `report-${scope}-${Math.max(1, Math.trunc(round))}`;
}

/** The artifact id a parent authors to re-spawn a missed handoff against the original. */
export function reworkArtifactId(scope: string, round: number): string {
  return `rework-${scope}-${Math.max(1, Math.trunc(round))}`;
}

/** True for an id a child must never rewrite. */
export function isFrozenHandoffId(id: string): boolean {
  return normalizeId(id).startsWith("handoff-");
}

/** True for a parent-authored rework brief, also never rewritten by a child. */
export function isFrozenReworkId(id: string): boolean {
  return normalizeId(id).startsWith("rework-");
}

/** Every id a child session may read but never write. */
export function isChildReadOnlyArtifact(id: string): boolean {
  return isFrozenHandoffId(id) || isFrozenReworkId(id);
}

function normalizeId(id: string): string {
  return String(id ?? "").trim().toLowerCase();
}

export interface HandoffDocumentInput {
  scope: string;
  /** 1 for the original handoff, 2+ for a rework. */
  round: number;
  /** The parent's work unit description. */
  assignment: string;
  /** Files this child owns. Empty means "no lane declared". */
  laneFiles?: readonly string[];
  /** Files the child must not touch. */
  outOfLaneFiles?: readonly string[];
  /** What "done" means. Accepting the result is judged against these. */
  acceptanceCriteria?: readonly string[];
  /** Reader vs writer, so the document states its own permissions. */
  role: "worker" | "research";
  /** Wall-clock budget in minutes, as promised to the child. */
  budgetMinutes?: number;
  /** Free-form parent notes: conventions, prior decisions, interfaces. */
  guidance?: string;
  /**
   * Rework only: the frozen original this brief answers, and the defects found
   * against it. Both are quoted so the child cannot renegotiate the contract.
   */
  rework?: {
    originalHandoffId: string;
    originalVersion?: number;
    /** The assignment the original handoff gave, quoted verbatim. */
    originalAssignment?: string;
    /** The criteria the original handoff froze. */
    originalCriteria?: readonly string[];
    defects: readonly string[];
  };
}

/**
 * Render the handoff document.
 *
 * Deliberately self-contained: the child reads this one artifact and needs
 * nothing else. The escalation ladder and the report shape are part of the
 * document rather than the ticket, because they are contract, not preamble.
 */
export function renderHandoffDocument(input: HandoffDocumentInput): string {
  const lane = input.laneFiles?.length
    ? input.laneFiles.map(file => `- \`${file}\``).join("\n")
    : "_No lane declared._ Do not modify files; report what you found and what would need to change.";
  const outOfLane = input.outOfLaneFiles?.length
    ? input.outOfLaneFiles.map(file => `- \`${file}\``).join("\n")
    : undefined;
  const criteria = input.acceptanceCriteria?.length
    ? input.acceptanceCriteria.map(criterion => `- ${criterion}`).join("\n")
    : "_No acceptance criteria declared._ Say what you verified and how.";
  const role = input.role === "research"
    ? "You are a research child: inspect, read and report. Do not modify files."
    : "You are an implementation child. Change only what this handoff and the lane allow.";
  const budget = typeof input.budgetMinutes === "number" && input.budgetMinutes > 0
    ? `You have about ${input.budgetMinutes} minutes. When the budget runs out the parent is interrupted and decides what happens next.`
    : undefined;

  const rework = input.rework
    ? `
## This is a rework (round ${input.round})

The original handoff \`${input.rework.originalHandoffId}\`${
  input.rework.originalVersion ? ` (v${input.rework.originalVersion})` : ""
} still stands. It is not negotiable and you may not rewrite it. A previous
child worked against it and the parent found these parts did NOT match:

${input.rework.defects.map((defect, index) => `${index + 1}. ${defect}`).join("\n")}
${input.rework.originalAssignment?.trim() ? `
### The original assignment (unchanged)

${input.rework.originalAssignment.trim()}
` : ""}${input.rework.originalCriteria?.length ? `
### The original criteria (unchanged)

${input.rework.originalCriteria.map(criterion => `- ${criterion}`).join("\n")}
` : ""}
Fix exactly those parts, and keep everything that already matched. If you
believe a defect is not real, escalate with \`agent_ping\` instead of paying a
round to disagree.
`
    : "";

  return `# Handoff: ${input.scope} (round ${input.round})

${role}

## Your assignment

${String(input.assignment ?? "").trim() || "(no assignment text was provided)"}

## Lane

${lane}
${outOfLane ? `
### Do NOT touch

${outOfLane}
` : ""}
## What "done" looks like

${criteria}
${budget ? `
## Budget

${budget}
` : ""}${rework}${input.guidance?.trim() ? `
## Notes from the parent

${input.guidance.trim()}
` : ""}

## If you are unsure — escalate, never guess

Use \`agent_ping\` with the question, what you already checked, and the options
you see. This pauses your session; the parent resumes you with an answer. If the
parent cannot answer, it escalates to the user. Never resolve an ambiguity by
picking the interpretation that lets you proceed.

You cannot modify this handoff. It is frozen for you. If it is wrong, that is a
blocker to report, not a document to correct.

## What to report back

Write your report to the artifact \`${reportArtifactId(input.scope, input.round)}\`
with \`artifact_save\`, and make your final message summarise it. The report must
contain:

1. A short summary of what you did.
2. For each criterion above: what you did (file:line) and how you verified it.
3. What you did not do, and why.
4. Anything you found that the parent needs to know but did not ask for.

Report honestly. An unmet criterion reported is worth more than a criterion
claimed and not verified: the parent checks, and a false claim costs a rework.
`;
}

/** The short ticket a child receives at launch: a pointer plus the contract. */
export function buildHandoffTicket(input: {
  scope: string;
  round?: number;
  handoffId: string;
  role: "worker" | "research";
  laneFiles?: readonly string[];
  acceptanceCriteria?: readonly string[];
  /** Rework only: the defect list, restated so it is impossible to miss. */
  defects?: readonly string[];
  /** Rework only: the frozen original the defects are measured against. */
  originalHandoffId?: string;
}): string {
  const round = Math.max(1, Math.trunc(input.round ?? 1));
  const lane = input.laneFiles?.length
    ? input.laneFiles.map(file => `- \`${file}\``).join("\n")
    : "_No lane declared._ Do not modify files.";
  const criteria = input.acceptanceCriteria?.length
    ? input.acceptanceCriteria.map(criterion => `- ${criterion}`).join("\n")
    : "_No acceptance criteria declared._ Say what you verified and how.";
  const defects = input.defects?.length
    ? `\n## Defects this rework must fix\n\n${input.defects.map((defect, index) => `${index + 1}. ${defect}`).join("\n")}\n`
    : "";
  const role = input.role === "research"
    ? "You are a research child: inspect, read and report. Do not modify files."
    : "You are an implementation child. Change only what the handoff and the lane allow.";

  return `# Work unit: ${input.scope} (round ${round})

${role}

**Read your handoff first:** \`artifact_recall({ id: "${input.handoffId}" })\`${input.originalHandoffId
    ? `, then the original it fixes: \`artifact_recall({ id: "${input.originalHandoffId}" })\``
    : ""}.

That artifact is your whole brief and it is FROZEN: you may read it, you may not
rewrite it. If it is missing or wrong, \`agent_ping\` the parent — an unavailable
handoff is a blocker to escalate, never something to infer.

## Lane at a glance
${lane}

## Done means
${criteria}
${defects}
## If you are unsure — escalate, never guess
Use \`agent_ping\` with the question, what you already checked, and the options you see.
This pauses your session; the parent resumes you with an answer.

## Report
Write \`${reportArtifactId(input.scope, round)}\` with \`artifact_save\`, then report it
in your final message: per criterion, what you did (file:line) and how you verified it.
`;
}
