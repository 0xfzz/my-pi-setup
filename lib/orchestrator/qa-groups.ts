/**
 * How many worker panes one parent may hold at once.
 *
 * The planner/QA arithmetic that used to live here went with the pipeline. The
 * cap stays: a wave of panes still costs tokens, and the refusal names the live
 * scopes so the parent can act on it.
 */
export const MAX_ACTIVE_WORKERS = 5;

export function workerLimitRefusal(runningScopes: readonly string[]): string | undefined {
  if (runningScopes.length < MAX_ACTIVE_WORKERS) return undefined;
  return (
    `Refused: ${runningScopes.length} workers are already running (${runningScopes.join(", ")}). `
    + `The cap is ${MAX_ACTIVE_WORKERS} concurrent workers, so a wave stays reviewable. `
    + `Wait for a completion trigger, then spawn the next unit.`
  );
}
