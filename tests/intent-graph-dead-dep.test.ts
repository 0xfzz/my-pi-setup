import assert from "node:assert/strict";
import test from "node:test";

import { applyTransition, buildPlan, renderTask } from "../lib/intent-graph.ts";

test("a task blocked on a dropped dependency says it will never unblock", () => {
  let plan = buildPlan({
    goal: "g",
    scope: "committed",
    seeds: [{ title: "F0" }, { title: "F2", deps: ["F0"] }],
  });
  const [first, second] = plan.tasks;
  plan = applyTransition(plan, { taskId: first!.id, to: "dropped", by: "me", reason: "stopped" }).plan;
  const line = renderTask(plan, plan.tasks[1]!, Date.now());
  assert.match(line, new RegExp(`blocked by ${first!.id}`));
  assert.match(line, /dropped\/failed and will never finish/);
  assert.equal(second!.id, plan.tasks[1]!.id);
});
