/**
 * QA scheduling advice: the cap and the queue order the completion message uses.
 *
 * The reviewer count is derived from the wave (`floor(workers/2)`, clamped 1..3),
 * computed once, so a later completion cannot widen it mid-wave. These tests are
 * about the arithmetic and the de-duplication rules, not about panes.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { qaSchedulingAdvice } from "../../lib/orchestrator/qa-schedule.ts";

test("five workers get two reviewers, and completions queue past the cap", () => {
  const advice = qaSchedulingAdvice({
    workerCount: 5,
    completedScopes: ["w1", "w2", "w3"],
  });
  assert.equal(advice.cap, 2, "floor(5/2) reviewers, not one per unit");
  assert.equal(advice.freeSlots, 2);
  assert.deepEqual(advice.spawnNow, ["w1", "w2"], "completion order decides, not unit order");
  assert.deepEqual(advice.deferred, ["w3"]);
  assert.match(advice.reason, /spawn QA/);
});

test("a second completion of the same scope is not queued twice", () => {
  const advice = qaSchedulingAdvice({
    workerCount: 4,
    completedScopes: ["w1", "w1", "w2"],
  });
  assert.deepEqual(advice.queue, ["w1", "w2"]);
});

test("already-judged units and units under review are never re-queued", () => {
  const advice = qaSchedulingAdvice({
    workerCount: 4,
    completedScopes: ["w1", "w2", "w3"],
    reviewedScopes: ["w1"],
    runningQaScopes: ["w2"],
  });
  assert.deepEqual(advice.queue, ["w3"]);
  assert.equal(advice.active, 1);
  assert.deepEqual(advice.spawnNow, ["w3"]);
});

test("when every slot is busy, nothing spawns and the queue is preserved", () => {
  const advice = qaSchedulingAdvice({
    workerCount: 5,
    completedScopes: ["w1", "w2", "w3"],
    runningQaScopes: ["w0", "w4"],
  });
  assert.equal(advice.active, 2);
  assert.equal(advice.freeSlots, 0);
  assert.deepEqual(advice.spawnNow, []);
  assert.deepEqual(advice.deferred, ["w1", "w2", "w3"]);
  assert.match(advice.reason, /busy/);
});

test("the cap scales with the wave and never exceeds three", () => {
  assert.equal(qaSchedulingAdvice({ workerCount: 1, completedScopes: [] }).cap, 1);
  assert.equal(qaSchedulingAdvice({ workerCount: 2, completedScopes: [] }).cap, 1);
  assert.equal(qaSchedulingAdvice({ workerCount: 4, completedScopes: [] }).cap, 2);
  assert.equal(qaSchedulingAdvice({ workerCount: 10, completedScopes: [] }).cap, 3);
  assert.equal(qaSchedulingAdvice({ workerCount: 0, completedScopes: [] }).cap, 1, "a degenerate wave still gets one reviewer");
  assert.equal(qaSchedulingAdvice({ workerCount: Number.NaN, completedScopes: [] }).cap, 1);
});

test("the sequence matches the pool example: 1→a, 2→b, 3 waits for a, 4 for b, 5 for a", () => {
  // Five completions, two slots. The advice is recomputed after each event, and a
  // unit whose review finished is `reviewed` — otherwise it would be queued again.
  const step = (completed: string[], running: string[], reviewed: string[] = []) =>
    qaSchedulingAdvice({ workerCount: 5, completedScopes: completed, runningQaScopes: running, reviewedScopes: reviewed });

  const first = step(["w1"], []);                 // w1 → slot a
  assert.deepEqual(first.spawnNow, ["w1"]);
  const second = step(["w1", "w2"], ["w1"]);      // w2 → slot b
  assert.deepEqual(second.spawnNow, ["w2"]);
  const third = step(["w1", "w2", "w3"], ["w1", "w2"]); // both busy: w3 queues
  assert.deepEqual(third.spawnNow, []);
  assert.deepEqual(third.deferred, ["w3"]);
  const fourth = step(["w1", "w2", "w3"], ["w2"], ["w1"]); // a freed: w3 goes to a
  assert.deepEqual(fourth.spawnNow, ["w3"]);
  const fifth = step(["w1", "w2", "w3", "w4"], ["w3"], ["w1", "w2"]); // b freed: w4 goes to b
  assert.deepEqual(fifth.spawnNow, ["w4"]);
  const sixth = step(["w1", "w2", "w3", "w4", "w5"], ["w3", "w4"], ["w1", "w2"]); // both busy: w5 waits
  assert.deepEqual(sixth.spawnNow, []);
  assert.deepEqual(sixth.deferred, ["w5"]);
});
