import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_ACTIVE_QA,
  MAX_ACTIVE_WORKERS,
  MAX_UNITS_PER_QA,
  planQaGroups,
  qaGroupCount,
  qaLimitRefusal,
  workerLimitRefusal,
} from "../../lib/orchestrator/qa-groups.ts";

const scopes = (n: number): string[] => Array.from({ length: n }, (_, i) => `unit-${i + 1}`);
const sizes = (n: number): number[] => {
  const plan = planQaGroups(scopes(n));
  assert.equal(plan.ok, true, `expected ${n} units to plan`);
  return (plan as { groups: { scopes: string[] }[] }).groups.map((group) => group.scopes.length);
};

test("the caps are the ones the lifecycle promises", () => {
  assert.equal(MAX_ACTIVE_WORKERS, 5);
  assert.equal(MAX_ACTIVE_QA, 3);
  assert.equal(MAX_UNITS_PER_QA, 3);
});

test("reviewer count is the smallest that respects three units each, capped at three", () => {
  assert.equal(qaGroupCount(0), 0);
  assert.equal(qaGroupCount(1), 1);
  assert.equal(qaGroupCount(3), 1);
  assert.equal(qaGroupCount(4), 2);
  assert.equal(qaGroupCount(5), 2);
  assert.equal(qaGroupCount(6), 2);
  assert.equal(qaGroupCount(7), 3);
  assert.equal(qaGroupCount(9), 3);
});

test("five units split as 2 + 3, which is the shape the user asked for", () => {
  const plan = planQaGroups(["a", "b", "c", "d", "e"]);
  assert.equal(plan.ok, true);
  const groups = (plan as { groups: { label: string; scopes: string[] }[] }).groups;
  assert.deepEqual(groups, [
    { label: "qa-1", scopes: ["a", "b"] },
    { label: "qa-2", scopes: ["c", "d", "e"] },
  ]);
});

test("partitions are balanced with the remainder on the later groups", () => {
  assert.deepEqual(sizes(1), [1]);
  assert.deepEqual(sizes(3), [3]);
  assert.deepEqual(sizes(4), [2, 2]);
  assert.deepEqual(sizes(6), [3, 3]);
  assert.deepEqual(sizes(7), [2, 2, 3]);
  assert.deepEqual(sizes(9), [3, 3, 3]);
});

test("unit order and labels are stable", () => {
  const plan = planQaGroups(scopes(7));
  assert.equal(plan.ok, true);
  const groups = (plan as { groups: { label: string; scopes: string[] }[] }).groups;
  assert.deepEqual(groups.map((group) => group.label), ["qa-1", "qa-2", "qa-3"]);
  assert.deepEqual(groups.flatMap((group) => group.scopes), scopes(7), "every unit is reviewed exactly once");
});

test("an oversized or duplicated batch is refused with a reason", () => {
  const tooMany = planQaGroups(scopes(MAX_ACTIVE_QA * MAX_UNITS_PER_QA + 1));
  assert.equal(tooMany.ok, false);
  assert.match((tooMany as { problems: string[] }).problems[0]!, /at most 9 units/);

  const empty = planQaGroups([]);
  assert.equal(empty.ok, false);
  assert.match((empty as { problems: string[] }).problems[0]!, /at least one/);

  const duplicate = planQaGroups(["a", "a", "b"]);
  assert.equal(duplicate.ok, false);
  assert.match((duplicate as { problems: string[] }).problems[0]!, /listed twice: a/);
});

test("a reviewer hint may raise the count but never exceed the caps", () => {
  const three = planQaGroups(scopes(3), { reviewers: 3 });
  assert.equal(three.ok, true);
  assert.deepEqual(
    (three as { groups: { scopes: string[] }[] }).groups.map((group) => group.scopes.length),
    [1, 1, 1],
  );

  const belowMinimum = planQaGroups(scopes(5), { reviewers: 1 });
  assert.equal(belowMinimum.ok, false);
  assert.match((belowMinimum as { problems: string[] }).problems[0]!, /need at least 2 reviewer/);

  const aboveCap = planQaGroups(scopes(3), { reviewers: MAX_ACTIVE_QA + 1 });
  assert.equal(aboveCap.ok, false);
  assert.match((aboveCap as { problems: string[] }).problems[0]!, /cap is 3/);

  const fractional = planQaGroups(scopes(3), { reviewers: 1.5 });
  assert.equal(fractional.ok, false);
  assert.match((fractional as { problems: string[] }).problems[0]!, /whole number/);
});

test("the worker cap refuses the sixth worker and names the running ones", () => {
  assert.equal(workerLimitRefusal(["a", "b", "c", "d"]), undefined);
  const refusal = workerLimitRefusal(["a", "b", "c", "d", "e"]);
  assert.ok(refusal);
  assert.match(refusal!, /5 workers are already running \(a, b, c, d, e\)/);
  assert.match(refusal!, /cap is 5/);
});

test("the QA cap accounts for reviewers a batch would add", () => {
  assert.equal(qaLimitRefusal(["qa-1", "qa-2"]), undefined);
  const atCap = qaLimitRefusal(["qa-1", "qa-2", "qa-3"]);
  assert.ok(atCap);
  assert.match(atCap!, /cap is 3/);

  assert.equal(qaLimitRefusal(["qa-1"], 2), undefined, "1 + 2 fits exactly");
  const overBatch = qaLimitRefusal(["qa-1", "qa-2"], 2);
  assert.ok(overBatch);
  assert.match(overBatch!, /adds 2/);
});
