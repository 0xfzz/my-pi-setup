/**
 * handoff.ts — the handoff is the parent's only product and the child's only input.
 *
 * The design rule this module enforces:
 *
 *   The parent authors ONE handoff spec per work unit and saves it as a
 *   SCOPED ARTIFACT. The child recalls that artifact by id and sees nothing
 *   else: no sibling scope name, no sibling path, no directory it could
 *   enumerate.
 *
 * Why an artifact rather than a large inlined prompt:
 *
 *   - A spec is a document. Inlining it made every child's first prompt carry
 *     several thousand tokens of prose before it had read a single line of code.
 *   - An artifact has an id, a version, and an audit trail, so the review can
 *     cite the exact revision it judged instead of quoting a prompt that no
 *     longer exists.
 *   - Scope is enforced by the artifact layer itself: a child inherits only
 *     global artifacts plus its own scope, so a sibling's spec is filtered out
 *     before the child can see it (see `visibleToScope` in
 *     pi-workflow-extensions/lib/artifact-state.ts). Distance in a prompt is not
 *     a boundary; absence from the catalog is.
 *
 * Why not a file path the child opens:
 *
 *   `PI_SUBAGENT_SPEC` used to be exported into every child's environment while no
 *   code ever read it, so specs were silently never delivered and children guessed
 *   their lane. Handing over a *path* only trades that bug for a worse one: all
 *   children share a UID, so a path given to one child is a path its siblings can
 *   open by guessing.
 *
 * The child's ticket therefore stays SHORT — a pointer, the contract at a glance,
 * and the escalation ladder — and says explicitly that an unavailable spec is a
 * blocker to escalate, never something to infer.
 *
 * A per-handoff copy is still written to disk under a private directory so a human
 * can audit it and the review can cite it. That copy is parent-side evidence
 * and is never handed to the child.
 */

export class HandoffError extends Error {}

/** A scope is a work-unit slug. It is the isolation key, so it must be exact. */
export function sanitizeScope(scope: string): string {
  const cleaned = String(scope ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!cleaned) {
    throw new HandoffError(`Invalid scope identifier: "${scope}". Must be a non-empty alphanumeric slug.`);
  }
  if (cleaned === "global") {
    throw new HandoffError(
      `Invalid scope identifier: "global" is reserved for artifacts every scope can see. Pick a work-unit name instead.`,
    );
  }
  return cleaned;
}

/**
 * The ticket for a spawn with no handoff spec.
 *
 * An ad-hoc child still gets the escalation ladder and an explicit statement of
 * what it owns. What it does NOT get is a fabricated spec: telling it to recall
 * an artifact that does not exist is exactly how it would learn to guess a lane.
 */
export function buildAdhocTicket(input: {
  scope: string;
  purpose: "adhoc" | "research" | "implementation";
  task: string;
  laneFiles?: readonly string[];
  acceptanceCriteria?: readonly string[];
}): string {
  const assignment = String(input.task ?? "").trim();
  const lane = input.laneFiles?.length
    ? input.laneFiles.map((file) => `- \`${file}\``).join("\n")
    : "_No lane declared._ Do not modify files; report what you found and what would need to change.";
  const criteria = input.acceptanceCriteria?.length
    ? input.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")
    : "_No acceptance criteria declared._ Say what you verified and how.";
  const role = input.purpose === "research"
    ? "You are a research child: inspect, read and report. Do not modify files."
    : input.purpose === "implementation"
      ? "You are an implementation child. Change only what the assignment and the lane allow."
      : "You are an ad-hoc worker. You have no handoff spec; this ticket is your whole brief.";

  return `# Ad-hoc work unit: ${input.scope}

${role}

## Your assignment
${assignment || "(no assignment text was provided)"}

## Lane
${lane}

## What "done" looks like
${criteria}

## If you are unsure — escalate, never guess
Use \`agent_ping\` with the question, what you already checked, and the options you see.
This pauses your session; the parent resumes you with an answer. If the
parent cannot answer, it escalates to the user. Never resolve an ambiguity
by picking the interpretation that lets you proceed.

## What to report back
A short summary, then for each criterion above: what you did (file:line) and how
you verified it. Say plainly what you did not do and why.
`;
}
