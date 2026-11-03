/**
 * budget.ts — a wall-clock budget that does not kill a child that is working.
 *
 * A flat 30 minutes interrupts a large task that is making steady progress and
 * lets a small one sit idle for the full window. The declared budget is the SOFT
 * limit: at expiry a child whose transcript is still being written is allowed to
 * continue, up to a hard cap (a multiple of the budget); a child that has gone
 * quiet is stopped at the soft limit as before. Pure so the rule is testable
 * without a clock or a pane.
 */
export const HARD_CAP_MULTIPLIER = 4;
/** A transcript write within this window counts as "making progress". */
export const ACTIVE_WINDOW_MS = 3 * 60 * 1000;

export type BudgetDecision = "ok" | "extend" | "trip";

export function decideBudget(input: {
  elapsedMs: number;
  budgetMs: number;
  /** Last transcript write (epoch ms), or null when unknown. */
  lastActivityAt: number | null;
  nowMs: number;
  hardCapMs?: number;
}): BudgetDecision {
  if (input.elapsedMs < input.budgetMs) return "ok";
  const hardCap = input.hardCapMs ?? input.budgetMs * HARD_CAP_MULTIPLIER;
  if (input.elapsedMs >= hardCap) return "trip";
  const active = input.lastActivityAt !== null && input.nowMs - input.lastActivityAt <= ACTIVE_WINDOW_MS;
  return active ? "extend" : "trip";
}
