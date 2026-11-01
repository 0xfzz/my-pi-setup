import test from "node:test";
import assert from "node:assert/strict";

import { buildPlanStepTicket, buildPlannerTicket, parsePlan, stripRecallFrame } from "../../lib/delegation/roles.ts";

const PLAN = "# Plan\n\n```json\n" + JSON.stringify({
  summary: "Two independent steps.",
  steps: [
    { id: "1", goal: "Build the store", files: ["src/store.ts"], acceptanceCriteria: ["persists"] },
    { id: "2", goal: "Build the UI", files: ["src/ui.tsx"], acceptanceCriteria: ["renders"] },
  ],
}) + "\n```\n";

test("a plan needs a fenced json block, and every step needs a lane and criteria", () => {
  const ok = parsePlan(PLAN);
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.plan.steps.length, 2);

  assert.equal(parsePlan("no json here").ok, false);
  const noLane = parsePlan("```json\n" + JSON.stringify({ summary: "x", steps: [{ id: "1", goal: "g", acceptanceCriteria: ["c"] }] }) + "\n```");
  assert.equal(noLane.ok, false);
  assert.match(noLane.ok ? "" : noLane.problems.join(" "), /owns no files/);
});

test("the artifact frame is stripped before parsing", () => {
  const framed = "=== Artifact: [plan-x] \"Plan\" (v1, plan, 1 KB) ===\n   1│ # Plan\n   2│ \n   3│ ```json\n" + PLAN.split("\n").slice(3, -1).map((l, i) => `   ${i + 4}│ ${l}`).join("\n") + "\n   9│ ```";
  const parsed = parsePlan(stripRecallFrame(framed));
  assert.equal(parsed.ok, true);
});

test("tickets name the plan, the step, and the lane", () => {
  const parsed = parsePlan(PLAN);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const step = parsed.plan.steps[0]!;
  const worker = buildPlanStepTicket({ scope: "store", planId: "plan-x", plan: parsed.plan, step, task: "do it" });
  assert.match(worker, /plan-x/);
  assert.match(worker, /src\/store\.ts/);
  assert.match(worker, /persists/);
  const planner = buildPlannerTicket({ scope: "x", planId: "plan-x", task: "plan it" });
  assert.match(planner, /plan-x/);
  assert.match(planner, /```json/);
});
