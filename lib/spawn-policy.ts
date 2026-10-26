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

import type { SpawnPurpose } from "./delegation-tools.ts";

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

/** What `orch_brief` and `orch_check` should say when no lane was declared. */
export function laneDeclaration(purpose: SpawnPurpose, laneFiles: readonly string[]): "declared" | "not-declared" {
  if (laneFiles.length > 0) return "declared";
  return purpose === "research" || purpose === "adhoc" ? "not-declared" : "declared";
}
