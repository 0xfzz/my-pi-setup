/**
 * spawn-policy.ts — which spawn shapes a mode admits, and what a child gets.
 *
 * Delegation is not a mode. Every mode reaches the same `agent_spawn`, so
 * "may this spawn happen?" is answered from (mode, purpose) rather than from
 * which tool name happens to be registered.
 * Keeping the table here means a mode cannot drift from the spawn tool: both
 * read one function.
 *
 * Two invariants:
 *
 *   1. Purpose is resolved BEFORE any registry row or pane exists, so a refused
 *      spawn leaves no trace.
 *   2. Plan mode is read-only for the PARENT. Delegating research or review is
 *      not implementation; delegating work that writes files is.
 */

import { MAX_DELEGATION_DEPTH, type SpawnPurpose } from "./delegation-tools.ts";

/**
 * Purposes this mode admits.
 *
 * - Normal: everything, including an ad-hoc child with no handoff.
 * - Plan: research, review and spec work. Implementation and ad-hoc spawns are
 *   refused because the parent is read-only; an explicit execution approval
 *   lifts that for this call.
 * - Supervise/Orchestrator: handoff-backed implementation plus the two reader
 *   shapes the mode itself needs. `research` is how the parent investigates
 *   without its own shell; `review` is the QA child that judges a worker's
 *   result. Both are read-only, so admitting them cannot produce a diff nobody
 *   owns. An ad-hoc child still has no lane and stays refused.
 *   `implementation` is the same spawn shape as `spec` when a handoff backs it:
 *   `registryPurpose` already stores both as "implementation", so refusing the
 *   explicit spelling only taught callers to omit a correct argument.
 */
export function allowedSpawnPurposes(
  _modeId: string | undefined,
  _executionApproved = false,
  _hasHandoff = false,
): SpawnPurpose[] {
  return ["adhoc", "research"];
}

/** The refusal text, or undefined when the spawn is admitted. */
export function spawnRefusal(
  _modeId: string | undefined,
  purpose: SpawnPurpose,
  _executionApproved = false,
  _hasHandoff = false,
): string | undefined {
  if (purpose === "adhoc" || purpose === "research") return undefined;
  return `Spawn purpose "${purpose}" was removed: delegation is ad-hoc only (adhoc or research).`;
}

/**
 * A research child is a reader. It gets no write/edit/patch tool and no parent
 * surface; the launcher appends the mandatory child control tools (agent_done,
 * agent_ping, agent_progress) so the child can still report and escalate.
 *
 * `undefined` means "canonical worker allowlist", which is the spec/adhoc shape.
 */
const RESEARCH_TOOLS: readonly string[] = [
  "read", "grep", "find", "ls", "ffgrep", "fffind", "shell_read",
  "web_read", "web_search", "google_search", "web_research", "vcc_recall",
  // Evidence artifacts only, scoped to the research unit; discovery stays denied.
  "artifact_save", "artifact_edit", "artifact_recall",
];

export function childToolsForPurpose(purpose: SpawnPurpose): string | undefined {
  // Research and QA are readers. A QA child that could write would be able to
  // "fix" the defect it is judging, which ends the independence the review
  // exists to provide. Both get the reader allowlist; the launcher still appends
  // the child control tools so they can report and escalate.
  return purpose === "research" || purpose === "review" ? RESEARCH_TOOLS.join(",") : undefined;
}

/**
 * The reading role a purpose implies, for the launcher's environment marker.
 *
 * A separate function keeps the comparison honest at call sites where the
 * compiler has already narrowed the local `purpose` (for example after the
 * `review` redirect), which would otherwise make `purpose === "review"` look
 * unreachable to TypeScript.
 */
export function readerPurpose(purpose: SpawnPurpose): "research" | "review" | undefined {
  return purpose === "research" || purpose === "review" ? purpose : undefined;
}

/** The value stored on the registry row. `spec` is implemented by a worker. */
export function registryPurpose(purpose: SpawnPurpose): "implementation" | "review" | "research" | "adhoc" {
  return purpose === "spec" ? "implementation" : purpose;
}

type Env = Readonly<Record<string, string | undefined>>;

function positiveInt(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** How many delegation hops above this process; the top-level session is 0. */
export function currentSpawnDepth(env: Env = process.env): number {
  return positiveInt(env.PI_SUBAGENT_DEPTH) ?? 0;
}

/** `PI_SUBAGENT_MAX_DEPTH`, then the capability table's default. */
export function maxSpawnDepth(env: Env = process.env): number {
  return positiveInt(env.PI_SUBAGENT_MAX_DEPTH) ?? MAX_DELEGATION_DEPTH;
}

/** A hard stop before any registry row or pane exists. */
export function depthProblem(
  depth: number = currentSpawnDepth(),
  max: number = maxSpawnDepth(),
): string | undefined {
  if (depth < max) return undefined;
  return `Delegation depth limit reached (this session is ${depth} hops deep, max-depth ${max}). `
    + `A delegated child may not spawn again; do this work yourself.`;
}

// The former breadth guard (maxChildren/capacityProblem) was absorbed by the
// occupancy-aware admission in lib/orchestrator/admission.ts: one occupancy
// count (running + blocked + results awaiting parent review) against one set
// of configured ceilings, instead of three overlapping caps.
