/**
 * research-budget.ts — a bounded research loop.
 *
 * Six web searches, twenty pages, 200k characters. The caps are per process,
 * which is per delegated child: a reviewer cannot spend the whole review on the
 * web, and a runaway loop is refused with the number it hit rather than silently
 * degrading.
 *
 * Pure counters: the caller owns the state, so a test can exhaust a budget without
 * a network or a repository.
 */

export const RESEARCH_ACTIONS = [
  "web_research",
  "web_page",
  "web_chars",
] as const;

export type ResearchAction = (typeof RESEARCH_ACTIONS)[number];

export const RESEARCH_LIMITS: Readonly<Record<ResearchAction, number>> = {
  web_research: 6,
  web_page: 20,
  web_chars: 200_000,
};

const LABELS: Readonly<Record<ResearchAction, string>> = {
  web_research: "web searches",
  web_page: "pages fetched",
  web_chars: "web characters",
};

export interface ResearchBudget {
  used: Record<ResearchAction, number>;
}

export function createBudget(): ResearchBudget {
  return {
    used: {
      web_research: 0,
      web_page: 0,
      web_chars: 0,
    },
  };
}

function amountOf(amount: number | undefined): number {
  if (!Number.isFinite(amount)) return 1;
  return Math.max(0, Math.trunc(Number(amount)));
}

/** The refusal, without consuming anything. */
export function budgetProblem(budget: ResearchBudget, action: ResearchAction, amount = 1): string | undefined {
  const limit = RESEARCH_LIMITS[action];
  const used = budget.used[action];
  const wanted = amountOf(amount);
  if (used + wanted <= limit) return undefined;
  return (
    `Research budget reached: ${used} of ${limit} ${LABELS[action]} used this session, and this call needs ${wanted}. `
    + `Work with what you have, post the finding, and let the parent start a fresh review if more is needed.`
  );
}

/** Consume, or refuse without consuming. Callers check, then act. */
export function consumeBudget(budget: ResearchBudget, action: ResearchAction, amount = 1): string | undefined {
  const problem = budgetProblem(budget, action, amount);
  if (problem) return problem;
  budget.used[action] += amountOf(amount);
  return undefined;
}

export function remainingBudget(budget: ResearchBudget, action: ResearchAction): number {
  return Math.max(0, RESEARCH_LIMITS[action] - budget.used[action]);
}
