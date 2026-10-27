/**
 * spawn-policy.ts — which spawn shapes a mode admits, and what a child gets.
 *
 * Delegation is not a mode. Normal, Plan, Supervise and Orchestrator all reach
 * the same `orch_spawn`, so "may this spawn happen?" has to be answered from
 * (mode, purpose) rather than from which tool name happens to be registered.
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
import type { OrchestratorWorkflow } from "./orchestrator/workflow.ts";

export type SpawnMode = "normal" | "plan" | "supervise" | "orchestrator";

const ALL_PURPOSES: readonly SpawnPurpose[] = ["spec", "adhoc", "research", "review", "implementation"];

/** Collapse an unknown/absent mode id onto the four shapes this table knows. */
export function normalizeSpawnMode(modeId: string | undefined): SpawnMode {
  if (modeId === "plan") return "plan";
  if (modeId === "supervise") return "supervise";
  if (modeId === "orchestrator") return "orchestrator";
  return "normal";
}

/** The honest default when the caller did not name a purpose. */
export function defaultSpawnPurpose(modeId: string | undefined): SpawnPurpose {
  return normalizeSpawnMode(modeId) === "plan" ? "research" : "adhoc";
}

/**
 * Purposes this mode admits.
 *
 * - Normal: everything, including an ad-hoc child with no handoff.
 * - Plan: research, review and spec work. Implementation and ad-hoc spawns are
 *   refused because the parent is read-only; an explicit execution approval
 *   lifts that for this call.
 * - Supervise/Orchestrator: a handoff spec only. The mode's whole point is
 *   lane isolation and the review ladder, and an ad-hoc child has no lane.
 */
export function allowedSpawnPurposes(modeId: string | undefined, executionApproved = false): SpawnPurpose[] {
  const mode = normalizeSpawnMode(modeId);
  if (mode === "plan") return executionApproved ? [...ALL_PURPOSES] : ["spec", "research", "review"];
  if (mode === "supervise" || mode === "orchestrator") return ["spec"];
  return [...ALL_PURPOSES];
}

/** The refusal text, or undefined when the spawn is admitted. */
export function spawnRefusal(
  modeId: string | undefined,
  purpose: SpawnPurpose,
  executionApproved = false,
): string | undefined {
  if (allowedSpawnPurposes(modeId, executionApproved).includes(purpose)) return undefined;
  const mode = normalizeSpawnMode(modeId);

  if (mode === "plan") {
    if (purpose === "implementation") {
      return "Plan mode: implementation delegation requires leaving Plan mode (/plan off) or an explicit execution approval.";
    }
    if (purpose === "adhoc") {
      return "Plan mode: ad-hoc delegation has no handoff lane, so review cannot judge it. "
        + "Leave Plan mode (/plan off), or spawn a research/review/spec child.";
    }
    return `Plan mode: ${purpose} delegation is not admitted. Use research, review or spec.`;
  }

  if (mode === "supervise" || mode === "orchestrator") {
    return `${mode === "orchestrator" ? "Orchestrator" : "Supervise"} mode: delegation requires a handoff spec. `
      + `Author one with orch_handoff, then call orch_spawn with its handoffId. Ad-hoc spawns are a Normal-mode shape.`;
  }

  return `Spawn purpose "${purpose}" is not admitted in ${mode} mode.`;
}

/**
 * A research child is a reader. It gets no write/edit/patch tool and no parent
 * surface; the launcher appends the mandatory child control tools (orch_done,
 * orch_ping, orch_progress) so the child can still report and escalate.
 *
 * `undefined` means "canonical worker allowlist", which is the spec/adhoc shape.
 */
const RESEARCH_TOOLS: readonly string[] = [
  "read", "grep", "find", "ls", "ffgrep", "fffind", "bash",
  "web_read", "web_search", "google_search", "vcc_recall",
  "artifact_recall", "artifact_list", "artifact_search",
];

export function childToolsForPurpose(purpose: SpawnPurpose): string | undefined {
  return purpose === "research" ? RESEARCH_TOOLS.join(",") : undefined;
}

/** The value stored on the registry row. `spec` is implemented by a worker. */
export function registryPurpose(purpose: SpawnPurpose): "implementation" | "review" | "research" | "adhoc" {
  return purpose === "spec" ? "implementation" : purpose;
}

/**
 * Orchestrator/Supervise implementation is spec-driven only in the SDD workflow.
 *
 * Normal and Plan keep their existing delegation policy. General Orchestrator
 * still requires a handoff (lane and criteria), but does not require an
 * independent specification review. `workflow` defaults to SDD so callers that
 * only know the mode keep the existing safety behavior.
 */
export function requiresReviewedSpec(
  modeId: string | undefined,
  workflow: OrchestratorWorkflow = "sdd",
): boolean {
  const mode = normalizeSpawnMode(modeId);
  return (mode === "orchestrator" || mode === "supervise") && workflow === "sdd";
}

/** What `orch_brief` and `orch_check` should say when no lane was declared. */
export function laneDeclaration(purpose: SpawnPurpose, laneFiles: readonly string[]): "declared" | "not-declared" {
  if (laneFiles.length > 0) return "declared";
  return purpose === "research" || purpose === "adhoc" ? "not-declared" : "declared";
}

/** Default breadth cap for one parent. */
export const DEFAULT_MAX_CHILDREN = 8;

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

/** `PI_SUBAGENT_MAX_CHILDREN`, then 8. */
export function maxChildren(env: Env = process.env): number {
  return positiveInt(env.PI_SUBAGENT_MAX_CHILDREN) ?? DEFAULT_MAX_CHILDREN;
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

/** Breadth is a stop, not a queue: the parent must finish or close a child first. */
export function capacityProblem(running: number, max: number = maxChildren()): string | undefined {
  if (running < max) return undefined;
  return `Child limit reached (${running}/${max}). Finish or close a child before spawning another.`;
}
