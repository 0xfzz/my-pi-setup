/**
 * The retired flow must not come back.
 *
 * The orchestrator used to review a batch with ONE reviewer, or fan readers out by
 * lens (`single`, `quick`, `architecture`), and a fix could never make a run ready.
 * Everything that carried that shape has been deleted. These assertions are the
 * tripwire: if an old prompt, an old session file, or a well-meaning refactor
 * reintroduces a preset, a lens panel, or a batch pin, this file fails.
 *
 * Deliberately shallow — it greps the public surface rather than exercising
 * behaviour. The behaviour tests live in spec-review-wave.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";

import * as review from "../../lib/orchestrator/spec-review.ts";
import * as policy from "../../lib/orchestrator/review-policy.ts";
import subagentV2 from "../../extensions/orchestrator.ts";

function registeredTools(): Map<string, any> {
  const tools = new Map<string, any>();
  const pi: any = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    on() {},
    getAllTools() { return [...tools.values()]; },
    appendEntry() {},
    sendMessage() {},
  };
  // Registration only: no pane is opened, so the client never has to be real.
  const client: any = {
    async paneStart() { return { paneId: "pane-1" }; },
    async paneRename() { return { pane_id: "pane-1" }; },
    async paneGet(paneId: string) { return { pane_id: paneId }; },
    async paneRead() { return null; },
    async paneList() { return []; },
    async paneClose() {},
    async paneSendKeys() {},
    async paneSendText() {},
  };
  subagentV2(pi, { client, stream: { watch: () => () => {}, onReconcile: () => () => {} } });
  return tools;
}

test("the retired lens/preset/batch API is deleted, not merely deprecated", () => {
  for (const name of [
    "REVIEW_PRESET_SINGLE",
    "REVIEW_PRESET_QUICK",
    "REVIEW_PRESET_ARCHITECTURE",
    "REVIEW_PRESETS",
    "isReviewPreset",
    "ReviewPreset",
    "LENS_RUBRICS",
    "ReviewMember",
    "batchReviewContent",
    "clusterFindings",
  ]) {
    assert.equal(name in review, false, `spec-review.ts must not export ${name}`);
  }
});

test("a document review has exactly one lens, and the retired panel lenses fail closed", () => {
  assert.deepEqual([...policy.REVIEW_LENSES], ["gate"]);
  assert.equal(policy.isReviewLens("gate"), true);
  for (const retired of ["comprehension", "readiness", "zoom-out", "critic", "quick", "architecture"]) {
    assert.equal(policy.isReviewLens(retired), false, `${retired} must not be a lens`);
  }
});

test("orch_spec_review offers plan and fix, and no preset to select a panel", () => {
  const tool = registeredTools().get("orch_spec_review");
  assert.ok(tool, "orch_spec_review is registered");
  const properties = tool.parameters?.properties ?? {};
  assert.equal("preset" in properties, false, "a preset parameter would bring the panel back");
  assert.equal("reviewers" in properties, true, "reviewers is a chunk-count hint, not a lens selector");

  const action = properties.action?.anyOf ?? properties.action?.oneOf ?? [];
  const literals = action.flatMap((entry: any) => (entry.const ? [entry.const] : entry.enum ?? []));
  for (const required of ["plan", "start", "collect", "fix", "resolve", "status", "cancel"]) {
    assert.ok(literals.includes(required), `action ${required} must be available: ${literals.join(", ")}`);
  }
  assert.equal(literals.includes("lint"), true, "lint stays as a free pre-flight");
});

test("the reviewer submit tool takes one block per member, never a lens", () => {
  const tool = registeredTools().get("orch_spec_review_submit");
  assert.ok(tool, "orch_spec_review_submit is registered");
  const properties = tool.parameters?.properties ?? {};
  assert.equal("members" in properties, true, "a chunk reviewer must file a block per member");
  assert.equal("lens" in properties, false, "a reviewer cannot choose a lens; the session carries its assignment");
});
