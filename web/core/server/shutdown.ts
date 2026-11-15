/**
 * Bounded teardown for the web server.
 *
 * Teardown is where a leak becomes an orphan. If `server.close()` waits on an
 * SSE client that never disconnects, or a plugin's `deactivate` awaits a promise
 * that never settles, an unbounded shutdown simply never finishes. The
 * supervisor then escalates to SIGKILL, and every child process the host was
 * still tracking is orphaned — the exact failure this budget prevents.
 *
 * So teardown runs against one overall deadline: a step that overruns is
 * abandoned, the remaining steps are attempted with whatever budget is left,
 * and the caller exits regardless.
 */
import { runWithBudget } from "../plugin-contracts/kernel/budget.ts";

/** The whole teardown, not one step. Long enough for a child to die, short enough to beat a supervisor. */
export const DEFAULT_SHUTDOWN_BUDGET_MS = 5_000;

export interface TeardownStep {
  /** Named in the log line that explains an abandoned step. */
  name: string;
  run(): Promise<void>;
  /**
   * This step's own cap. Defaults to an equal share of the overall budget, so
   * one hung step cannot starve the ones that still have real work to do —
   * releasing a plugin's children matters more than a stuck HTTP close.
   */
  budgetMs?: number;
}

export interface TeardownOutcome {
  /** Steps that threw, or were abandoned because the budget ran out. */
  failed: string[];
  /** True when the deadline, not an error, is why teardown did not finish. */
  timedOut: boolean;
}

export interface TeardownOptions {
  budgetMs?: number;
  clock?: () => number;
}

/**
 * Run each step in order under a shared deadline, with an equal share each so
 * one hung step cannot consume the whole budget. A failing step never stops the
 * next one: shutting the plugin host down matters more than reporting that the
 * HTTP server was already closed.
 */
export async function runTeardown(steps: readonly TeardownStep[], options: TeardownOptions = {}): Promise<TeardownOutcome> {
  const clock = options.clock ?? Date.now;
  const totalMs = options.budgetMs ?? DEFAULT_SHUTDOWN_BUDGET_MS;
  const deadline = clock() + totalMs;
  const share = steps.length === 0 ? totalMs : Math.max(1, Math.floor(totalMs / steps.length));
  const failed: string[] = [];
  let timedOut = false;

  for (const step of steps) {
    const remaining = deadline - clock();
    if (remaining <= 0) {
      // The budget is gone; abandoning the rest is the point of the deadline.
      failed.push(step.name);
      timedOut = true;
      continue;
    }
    const budget = Math.min(remaining, step.budgetMs ?? share);
    const outcome = await runWithBudget(step.name, budget, () => step.run(), clock);
    if (outcome.ok) continue;
    failed.push(step.name);
    if (outcome.reason === "timeout") timedOut = true;
  }

  return { failed, timedOut };
}

/** One log line describing what teardown managed to do. */
export function teardownNote(outcome: TeardownOutcome): string {
  if (outcome.failed.length === 0) return "";
  if (outcome.timedOut) {
    return ` (teardown exceeded its ${DEFAULT_SHUTDOWN_BUDGET_MS} ms budget: ${outcome.failed.join(", ")}; exiting anyway)`;
  }
  return ` (teardown reported: ${outcome.failed.join(", ")})`;
}
