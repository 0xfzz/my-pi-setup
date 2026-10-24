/**
 * handoff.ts — the orchestrator's only product, and the child's only input.
 *
 * The design rule this module enforces:
 *
 *   The orchestrator authors ONE handoff spec per work unit and saves it as a
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
 * can audit it and the review can cite it. That copy is orchestrator-side evidence
 * and is never handed to the child.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

export interface HandoffSpec {
  /** Work-unit slug. Unique per concurrent child. */
  scope: string;
  /** Human-readable one-line goal. */
  goal: string;
  /** What "done" means. Each must be evidenced in the child's report. */
  acceptanceCriteria: string[];
  /** Files this child owns. The review gate checks the diff against this. */
  laneFiles: string[];
  /** Files this child must not touch, even if it believes it should. */
  outOfLaneFiles?: string[];
  /** What the report must contain beyond a prose summary. */
  reportShape?: string;
  /** Orchestrator notes: conventions, interfaces, prior decisions. */
  guidance?: string;
  /** Interfaces this scope must conform to (consumed by other scopes). */
  interfaces?: string[];
  /** Global vision this scope refines. Never contradicts it. */
  vision?: string;
}

export interface HandoffRecord extends HandoffSpec {
  /** Deterministic, scope-derived id. Stable across respawns of the same scope. */
  id: string;
  /**
   * Id of the scoped artifact holding this spec. This is what the child recalls;
   * the ticket carries only this pointer, not the document body.
   */
  artifactId: string;
  revision: number;
  authoredAt: string;
  /** Session that authored it. */
  parentSessionId: string;
}

/** Artifact type the handoff is stored under, so review can cite a spec. */
export const HANDOFF_ARTIFACT_TYPE = "spec" as const;

/** Deterministic id: the same scope always names the same handoff. */
export function handoffIdFor(scope: string): string {
  const clean = sanitizeScope(scope);
  const digest = createHash("sha256").update(clean).digest("hex").slice(0, 8);
  return `${clean}-${digest}`;
}

/**
 * Artifact id for a handoff. Derived from the handoff id, so re-authoring the same
 * scope updates the same artifact instead of littering the catalog with clones.
 * Artifact ids are capped at 64 chars; the scope digest sits at the end of the
 * handoff id, so truncation keeps two long sibling scopes distinct.
 */
export function handoffArtifactId(handoff: { id: string }): string {
  return `handoff-${handoff.id}`.slice(0, 64);
}

export function validateHandoff(spec: HandoffSpec): HandoffRecord & { revision: number } {
  const scope = sanitizeScope(spec.scope);

  if (!spec.goal || !String(spec.goal).trim()) {
    throw new HandoffError("A handoff spec needs a goal: one line stating what this work unit achieves.");
  }
  const criteria = (spec.acceptanceCriteria ?? []).map((c) => String(c).trim()).filter(Boolean);
  if (criteria.length === 0) {
    throw new HandoffError(
      "A handoff spec needs at least one acceptance criterion. Without one the review gate has nothing to check and the child has no definition of done.",
    );
  }
  const lane = (spec.laneFiles ?? []).map((f) => String(f).trim()).filter(Boolean);
  if (lane.length === 0) {
    throw new HandoffError(
      "A handoff spec needs at least one lane file. An empty lane means the child owns the whole repository, which makes lane-based steering and the review gate impossible.",
    );
  }
  const overlap = new Set(lane) ;
  for (const out of spec.outOfLaneFiles ?? []) {
    if (overlap.has(out)) {
      throw new HandoffError(`"${out}" is both in-lane and out-of-lane. Resolve the contradiction before delegating.`);
    }
  }

  return {
    id: handoffIdFor(scope),
    artifactId: handoffArtifactId({ id: handoffIdFor(scope) }),
    scope,
    goal: String(spec.goal).trim(),
    acceptanceCriteria: criteria,
    laneFiles: lane,
    ...(spec.outOfLaneFiles?.length ? { outOfLaneFiles: spec.outOfLaneFiles.map(String) } : {}),
    ...(spec.reportShape ? { reportShape: String(spec.reportShape).trim() } : {}),
    ...(spec.guidance ? { guidance: String(spec.guidance).trim() } : {}),
    ...(spec.interfaces?.length ? { interfaces: spec.interfaces.map(String) } : {}),
    ...(spec.vision ? { vision: String(spec.vision).trim() } : {}),
    revision: 1,
    authoredAt: new Date().toISOString(),
    parentSessionId: "",
  };
}

/** Directory per handoff, so a human can audit without reading another scope's work. */
export function handoffDir(artifactsBaseDir: string, parentSessionId: string, handoffId: string): string {
  return join(artifactsBaseDir, parentSessionId, "handoffs", handoffId);
}

export function handoffFilePath(artifactsBaseDir: string, parentSessionId: string, handoffId: string): string {
  return join(handoffDir(artifactsBaseDir, parentSessionId, handoffId), "spec.md");
}

/**
 * Render the spec that a child sees.
 *
 * Everything here is addressed to exactly one scope. There is deliberately no
 * sibling scope name, no run id, no parent artifact path — a child cannot leak
 * what it was never told.
 *
 * The two escalation routes are stated as the first thing after the goal because
 * the failure mode this replaces was a child inventing an answer instead of
 * asking: it had no declared, safe way to say "I do not know".
 */
export function renderHandoffForChild(spec: HandoffRecord): string {
  const criteria = spec.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const lane = spec.laneFiles.map((f) => `- \`${f}\``).join("\n");

  const outOfLane = spec.outOfLaneFiles?.length
    ? `\n## Do NOT touch\nThese belong to another work unit. If your task cannot be done without changing one, escalate (see below) — do not edit it.\n${spec.outOfLaneFiles.map((f) => `- \`${f}\``).join("\n")}\n`
    : "";

  const interfaces = spec.interfaces?.length
    ? `\n## Interfaces you must conform to\nAnother work unit consumes these. Changing the shape silently breaks it.\n${spec.interfaces.map((i) => `- ${i}`).join("\n")}\n`
    : "";

  const vision = spec.vision
    ? `\n## Project vision (this spec refines it; it must not contradict it)\n${spec.vision}\n`
    : "";

  const guidance = spec.guidance ? `\n## Notes from the orchestrator\n${spec.guidance}\n` : "";

  const reportShape = spec.reportShape
    ? spec.reportShape
    : "A short summary, then for EACH acceptance criterion: what you changed (file:line) and how you verified it. Say plainly what you did not do and why.";

  return `# Work handoff: ${spec.scope}

## Goal
${spec.goal}
${vision}${outOfLane}${interfaces}${guidance}
## Files you own (your lane)
${lane}

## Acceptance criteria — each must be evidenced in your report
${criteria}

## What to report back
${reportShape}

## Boundaries
You own the files in your lane and nothing else. Read whatever you need to
understand the code; write only inside your lane.

## If you are unsure — escalate, never guess
Two routes, in order:
1. **Ask the orchestrator** with \`caller_ping\`: state the question, what you
   already checked, and the options you see. This pauses your session; the
   orchestrator resumes you with an answer.
2. **If the orchestrator cannot answer**, it escalates to the user and resumes
   you with the decision. You do not contact the user yourself.

Never resolve an ambiguity by picking the interpretation that lets you proceed.
A wrong assumption inside your lane becomes a defect the review gate has to
catch, and a wrong assumption about another lane becomes a merge conflict.
`;
}

/** Write the orchestrator-side evidence copy. Private, per-handoff. */
export function writeHandoff(
  artifactsBaseDir: string,
  parentSessionId: string,
  spec: HandoffSpec,
): { record: HandoffRecord; path: string } {
  const validated = validateHandoff(spec);
  const record: HandoffRecord = { ...validated, parentSessionId };
  const dir = handoffDir(artifactsBaseDir, parentSessionId, record.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = handoffFilePath(artifactsBaseDir, parentSessionId, record.id);
  writeFileSync(path, renderHandoffForChild(record), { mode: 0o600 });
  return { record, path };
}

/**
 * The scoped artifact that IS the handoff.
 *
 * `scope` is what makes this safe: the artifact layer shows a child only global
 * artifacts plus its own scope, so a sibling's handoff is filtered out of the
 * catalog before the child can reach it. The body is the full spec document; the
 * child recalls it by `id`.
 */
export function handoffArtifactPayload(record: HandoffRecord): {
  id: string;
  title: string;
  type: typeof HANDOFF_ARTIFACT_TYPE;
  scope: string;
  content: string;
} {
  return {
    id: record.artifactId,
    title: `Handoff: ${record.scope} — ${record.goal}`,
    type: HANDOFF_ARTIFACT_TYPE,
    scope: record.scope,
    content: renderHandoffForChild(record),
  };
}

/**
 * Build the child's task message — a POINTER, not the document.
 *
 * The handoff lives in a scoped artifact. Repeating its body here would make every
 * child's first prompt thousands of tokens of prose before it read a line of code,
 * and would fork the spec into two authorities that drift (the artifact the review
 * cites, and the prompt the child actually followed).
 *
 * So the ticket stays short: what to recall, the assignment, and the escalation
 * ladder. Crucially it says that an unavailable spec is a blocker to escalate —
 * never something to infer, which is the exact failure that made children guess
 * their lane when `PI_SUBAGENT_SPEC` was never delivered.
 */
export function buildChildTicket(spec: HandoffRecord, task: string): string {
  const trimmed = String(task ?? "").trim();
  const assignment = trimmed
    ? `## Your assignment for this handoff\n${trimmed}\n`
    : "";

  return `# Work handoff: ${spec.scope}

## Read your spec first
Your handoff is artifact \`${spec.artifactId}\`.
Call \`artifact_recall({ id: "${spec.artifactId}" })\` before you start. It holds
your goal, the acceptance criteria the review will check, the files you own (your
lane), the files you must not touch, and the interfaces you must honour.

It is the only spec you have. If the recall fails or returns something for a
different scope, do NOT guess your lane — escalate with \`caller_ping\`.

${assignment}
## Boundaries
You own the files in your lane and nothing else. Read whatever you need to
understand the code; write only inside your lane.

## If you are unsure — escalate, never guess
Two routes, in order:
1. **Ask the orchestrator** with \`caller_ping\`: state the question, what you
   already checked, and the options you see. This pauses your session; the
   orchestrator resumes you with an answer.
2. **If the orchestrator cannot answer**, it escalates to the user and resumes
   you with the decision. You do not contact the user yourself.

Never resolve an ambiguity by picking the interpretation that lets you proceed.
A wrong assumption inside your lane becomes a defect the review gate has to
catch, and a wrong assumption about another lane becomes a merge conflict.

## What to report back
${spec.reportShape ?? "A short summary, then for EACH acceptance criterion: what you changed (file:line) and how you verified it. Say plainly what you did not do and why."}
`;
}

/**
 * Two child tickets must not share content beyond the shared preamble.
 *
 * This is the isolation assertion, expressed as data so it can be tested without
 * a running child: it returns the sibling scope names that leaked into `ticket`.
 */
export function leakedSiblingScopes(ticket: string, selfScope: string, siblingScopes: Iterable<string>): string[] {
  const leaked: string[] = [];
  for (const sibling of siblingScopes) {
    if (sibling === selfScope) continue;
    const token = new RegExp(`(?<![\\w-])${sibling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
    if (token.test(ticket)) leaked.push(sibling);
  }
  return leaked;
}
