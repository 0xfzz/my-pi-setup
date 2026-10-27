/**
 * Orchestrator workflow policy.
 *
 * SDD and general are workflows inside the one Orchestrator permission mode, not
 * separate modes. The choice is branch-local so it follows reload/resume/fork and
 * tree navigation, exactly like the Plan and Supervise branch records.
 *
 * The default is SDD: entering Orchestrator must not silently relax the reviewed
 * specification gate that already exists. General is an explicit opt-in.
 */
export const ORCHESTRATOR_WORKFLOW_TYPE = "orchestrator-workflow:v1";

export type OrchestratorWorkflow = "sdd" | "general";

export const DEFAULT_ORCHESTRATOR_WORKFLOW: OrchestratorWorkflow = "sdd";

/** Accept the user-facing "regular" spelling as an alias for general. */
export function normalizeOrchestratorWorkflow(value: unknown): OrchestratorWorkflow | undefined {
  if (value === "sdd") return "sdd";
  if (value === "general" || value === "regular") return "general";
  return undefined;
}

/** Latest valid workflow entry on the selected branch, if any. */
export function workflowFromBranch(branch: readonly any[] | undefined): OrchestratorWorkflow | undefined {
  for (let index = (branch?.length ?? 0) - 1; index >= 0; index--) {
    const entry = branch![index];
    if (entry?.type !== "custom" || entry.customType !== ORCHESTRATOR_WORKFLOW_TYPE) continue;
    const workflow = normalizeOrchestratorWorkflow(entry.data?.workflow);
    if (workflow) return workflow;
  }
  return undefined;
}

export function orchestratorWorkflow(branch: readonly any[] | undefined): OrchestratorWorkflow {
  return workflowFromBranch(branch) ?? DEFAULT_ORCHESTRATOR_WORKFLOW;
}

export function isSddWorkflow(branch: readonly any[] | undefined): boolean {
  return orchestratorWorkflow(branch) === "sdd";
}

export function workflowLabel(workflow: OrchestratorWorkflow): string {
  return workflow === "sdd" ? "SDD" : "General";
}
