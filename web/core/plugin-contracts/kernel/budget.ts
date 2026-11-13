/**
 * Time budgets for plugin code (PRD §5.5, §6.2). A plugin call that does not
 * settle inside its budget is abandoned: the caller gets a `timeout` outcome,
 * the signal is aborted so cooperative work can stop, and the late result is
 * discarded. A throw is an `error` outcome, never an exception into the host.
 */

export type BudgetOutcome<T> =
  | { ok: true; value: T; elapsedMs: number }
  | { ok: false; reason: "timeout" | "error"; error: string; elapsedMs: number };

export async function runWithBudget<T>(
  label: string,
  budgetMs: number,
  work: (signal: AbortSignal) => T | PromiseLike<T>,
  clock: () => number = Date.now,
): Promise<BudgetOutcome<T>> {
  const started = clock();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BudgetOutcome<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`${label} exceeded ${budgetMs} ms`));
      resolve({ ok: false, reason: "timeout", error: `${label} exceeded its ${budgetMs} ms budget`, elapsedMs: clock() - started });
    }, budgetMs);
  });
  const run = (async (): Promise<BudgetOutcome<T>> => {
    try {
      const value = await work(controller.signal);
      return { ok: true, value, elapsedMs: clock() - started };
    } catch (error) {
      return {
        ok: false,
        reason: "error",
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: clock() - started,
      };
    }
  })();
  try {
    return await Promise.race([run, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
