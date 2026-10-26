import test from "node:test";
import assert from "node:assert/strict";
import { resolveBudget } from "../lib/vcc/budget.ts";
import {
  estimateFixedOverhead,
  hasCompleteToolPairs,
  planBudgetedCompaction,
  planLegacyCompaction,
  type ProjectedEntryLike,
} from "../lib/vcc/plan.ts";

function textEntry(id: string, role: "user" | "assistant", text: string): ProjectedEntryLike {
  return { sourceEntry: { id, type: "message" }, messages: [{ role, content: text }] };
}

function toolCallEntry(id: string, ids: string[]): ProjectedEntryLike {
  return {
    sourceEntry: { id, type: "message" },
    messages: [{
      role: "assistant",
      content: ids.map((callId) => ({ type: "toolCall", id: callId, name: "read", arguments: { path: `${callId}.ts` } })),
    }],
  };
}

function toolResultEntry(id: string, callId: string): ProjectedEntryLike {
  return {
    sourceEntry: { id, type: "message" },
    messages: [{
      role: "toolResult",
      toolCallId: callId,
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: `result ${callId}` }],
    }],
  };
}

function systemEntry(id: string, text: string): ProjectedEntryLike {
  return { sourceEntry: { id, type: "message" }, messages: [{ role: "system", content: text }] };
}

const filler = (n: number) => "detail ".repeat(n);

function session(): ProjectedEntryLike[] {
  return [
    systemEntry("sys", "system prompt ".repeat(200)),
    textEntry("u1", "user", `fix a.ts and keep memory low ${filler(2000)}`),
    textEntry("a1", "assistant", filler(3000)),
    textEntry("u2", "user", `also add tests ${filler(2000)}`),
    toolCallEntry("a3", ["t1", "t2"]),
    toolResultEntry("r1", "t1"),
    toolResultEntry("r2", "t2"),
  ];
}

test("budgeted planning keeps the newest batch and its complete tool pairs", () => {
  const entries = session();
  const budget = resolveBudget({ contextWindow: 32_000 })!;
  const plan = planBudgetedCompaction({
    entries,
    messageEntryId: "a3",
    toolResultEntryIds: ["r1", "r2"],
    budget,
    fixedOverheadTokens: estimateFixedOverhead(entries).tokens,
  })!;
  assert.ok(plan, "a plan is produced");
  assert.equal(plan.firstKeptEntryId, "u2", "the newest user turn plus the tool batch stay in the tail");
  assert.equal(plan.cut, 3);
  assert.ok(hasCompleteToolPairs(entries.slice(plan.cut)));
  assert.ok(hasCompleteToolPairs(entries.slice(0, plan.cut)));
  assert.ok(plan.prefixTokens > budget.summaryBudget, "there is enough to summarize");
  assert.ok(plan.newTokens >= budget.minProgressTokens);
});

test("the tail budget derives from the post-compaction target, not trigger/4", () => {
  const entries = session();
  const budget = resolveBudget({ contextWindow: 32_000 })!;
  const overhead = estimateFixedOverhead(entries).tokens;
  const plan = planBudgetedCompaction({
    entries,
    messageEntryId: "a3",
    toolResultEntryIds: ["r1", "r2"],
    budget,
    fixedOverheadTokens: overhead,
  })!;
  const expected = Math.min(
    budget.postCompactionTarget - overhead - budget.summaryBudget,
    budget.tailMax,
  );
  assert.equal(plan.tailBudget, expected);
  assert.notEqual(plan.tailBudget, Math.floor(budget.qualityTarget / 4));
});

test("a plan is refused when nothing new would be summarized", () => {
  const entries = session();
  const budget = { ...resolveBudget({ contextWindow: 32_000 })!, minProgressTokens: 1_000_000 };
  const plan = planBudgetedCompaction({
    entries,
    messageEntryId: "a3",
    toolResultEntryIds: ["r1", "r2"],
    budget,
    fixedOverheadTokens: 0,
  });
  assert.equal(plan, undefined);
});

test("a plan is refused when the cut would span a tool pair or drop a fresh result", () => {
  const entries = session();
  const budget = resolveBudget({ contextWindow: 32_000 })!;
  assert.equal(planBudgetedCompaction({
    entries,
    messageEntryId: "a3",
    toolResultEntryIds: ["r1", "missing"],
    budget,
    fixedOverheadTokens: 0,
  }), undefined);
  assert.equal(planBudgetedCompaction({
    entries,
    messageEntryId: "not-an-entry",
    budget,
    fixedOverheadTokens: 0,
  }), undefined);
});

test("protected overhead above the soft target falls back to capacity and says so", () => {
  const entries = session();
  const budget = resolveBudget({ contextWindow: 32_000 })!;
  const overhead = budget.postCompactionTarget - budget.summaryBudget - 64;
  const plan = planBudgetedCompaction({
    entries,
    messageEntryId: "a3",
    toolResultEntryIds: ["r1", "r2"],
    budget,
    fixedOverheadTokens: overhead,
  })!;
  assert.ok(plan);
  assert.equal(plan.exception, "capacity");
  assert.ok(plan.tailBudget > budget.tailMin);
  assert.ok(plan.tailBudget <= budget.inputAllowance - overhead - budget.summaryBudget);
});

test("impossible capacity refuses instead of dropping mandatory context", () => {
  const entries = session();
  const budget = resolveBudget({ contextWindow: 8_000 })!;
  const plan = planBudgetedCompaction({
    entries,
    messageEntryId: "a3",
    toolResultEntryIds: ["r1", "r2"],
    budget,
    fixedOverheadTokens: budget.inputAllowance,
  });
  assert.equal(plan, undefined);
});

test("legacy planning still reproduces the old threshold/4 tail", () => {
  const entries = session();
  for (const threshold of [6_400, 25_600, 40_000]) {
    const plan = planLegacyCompaction({
      entries,
      messageEntryId: "a3",
      toolResultEntryIds: ["r1", "r2"],
      threshold,
    })!;
    assert.ok(plan, `threshold ${threshold} must plan`);
    assert.equal(plan.tailBudget, Math.min(20_000, Math.floor(threshold / 4)));
    assert.ok(hasCompleteToolPairs(entries.slice(plan.cut)));
  }
  // A tail budget larger than the whole conversation has nothing to cut.
  assert.equal(planLegacyCompaction({
    entries,
    messageEntryId: "a3",
    toolResultEntryIds: ["r1", "r2"],
    threshold: 200_000,
  }), undefined);
});

test("the legacy planner still bails when there is too little new work", () => {
  const entries = [systemEntry("sys", "s"), textEntry("u1", "user", "short"), toolCallEntry("a1", ["t1"]), toolResultEntry("r1", "t1")];
  assert.equal(planLegacyCompaction({
    entries,
    messageEntryId: "a1",
    toolResultEntryIds: ["r1"],
    threshold: 6_400,
  }), undefined);
});

test("orphaned or missing tool results are rejected", () => {
  assert.equal(hasCompleteToolPairs([toolResultEntry("r1", "t1")]), false);
  assert.equal(hasCompleteToolPairs([toolCallEntry("a1", ["t1", "t2"]), toolResultEntry("r1", "t1")]), false);
  assert.equal(hasCompleteToolPairs([toolCallEntry("a1", ["t1"]), toolResultEntry("r1", "t2")]), false);
  assert.equal(hasCompleteToolPairs([toolCallEntry("a1", ["t1"]), toolResultEntry("r1", "t1")]), true);
  assert.equal(hasCompleteToolPairs([textEntry("u1", "user", "hi"), toolCallEntry("a1", ["t1"]), toolResultEntry("r1", "t1")]), true);
});

test("fixed overhead counts system prompts and queued messages", () => {
  const entries = [systemEntry("sys", "a".repeat(350)), textEntry("u1", "user", "x".repeat(700))];
  const overhead = estimateFixedOverhead(entries, [{ role: "user", content: "b".repeat(350) }]);
  assert.equal(overhead.systemEntries, 1);
  assert.equal(overhead.tokens, 100 + overhead.pendingTokens);
  assert.equal(overhead.pendingTokens, 100);
});
