import test from "node:test";
import assert from "node:assert/strict";

import {
  RESEARCH_LIMITS,
  budgetProblem,
  consumeBudget,
  createBudget,
  remainingBudget,
} from "../../lib/orchestrator/research-budget.ts";

test("the caps are the documented ones", () => {
  assert.equal(RESEARCH_LIMITS.web_research, 6);
  assert.equal(RESEARCH_LIMITS.web_page, 20);
  assert.equal(RESEARCH_LIMITS.web_chars, 200_000);
  assert.equal(RESEARCH_LIMITS.code_search, 50);
  assert.equal(RESEARCH_LIMITS.code_read, 100);
  assert.equal(RESEARCH_LIMITS.code_bytes, 2_000_000);
});

test("the seventh web search is refused and says why", () => {
  const budget = createBudget();
  for (let i = 0; i < 6; i += 1) {
    assert.equal(consumeBudget(budget, "web_research"), undefined, `search ${i + 1}`);
  }
  const refusal = consumeBudget(budget, "web_research");
  assert.ok(refusal);
  assert.match(refusal!, /6 of 6 web searches/);
  assert.match(refusal!, /fresh review/);
  assert.equal(remainingBudget(budget, "web_research"), 0);
});

test("a call costs only when it fits, so a refusal does not drain the budget", () => {
  const budget = createBudget();
  assert.equal(consumeBudget(budget, "web_page", 19), undefined);
  assert.equal(remainingBudget(budget, "web_page"), 1);
  assert.ok(budgetProblem(budget, "web_page", 2), "2 pages do not fit in 1");
  assert.equal(budget.used.web_page, 19, "the refused call consumed nothing");
  assert.equal(consumeBudget(budget, "web_page", 1), undefined);
});

test("actions are budgeted independently", () => {
  const budget = createBudget();
  consumeBudget(budget, "web_research", 6);
  assert.ok(budgetProblem(budget, "web_research"));
  assert.equal(consumeBudget(budget, "code_search"), undefined);
  assert.equal(consumeBudget(budget, "code_read"), undefined);
});

test("a huge single request is refused rather than partially consumed", () => {
  const budget = createBudget();
  const refusal = consumeBudget(budget, "web_chars", 500_000);
  assert.ok(refusal);
  assert.equal(budget.used.web_chars, 0);
});
