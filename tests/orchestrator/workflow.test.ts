import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ORCHESTRATOR_WORKFLOW,
  ORCHESTRATOR_WORKFLOW_TYPE,
  isSddWorkflow,
  normalizeOrchestratorWorkflow,
  orchestratorWorkflow,
  workflowFromBranch,
  workflowLabel,
} from "../../lib/orchestrator/workflow.ts";

function entry(workflow: unknown) {
  return { type: "custom", customType: ORCHESTRATOR_WORKFLOW_TYPE, data: { workflow } };
}

test("the orchestrator defaults to SDD, preserving the reviewed-spec gate", () => {
  assert.equal(DEFAULT_ORCHESTRATOR_WORKFLOW, "sdd");
  assert.equal(orchestratorWorkflow(undefined), "sdd");
  assert.equal(orchestratorWorkflow([]), "sdd");
  assert.equal(isSddWorkflow([]), true);
});

test("sdd, general and the regular alias normalize deliberately", () => {
  assert.equal(normalizeOrchestratorWorkflow("sdd"), "sdd");
  assert.equal(normalizeOrchestratorWorkflow("general"), "general");
  assert.equal(normalizeOrchestratorWorkflow("regular"), "general");
  assert.equal(normalizeOrchestratorWorkflow("SDD"), undefined, "normalization is exact, not guessy");
  assert.equal(normalizeOrchestratorWorkflow("unknown"), undefined);
});

test("the latest valid workflow entry wins; malformed entries are ignored", () => {
  const branch = [
    entry("sdd"),
    entry("general"),
    entry("nonsense"),
    { type: "custom", customType: "unrelated", data: { workflow: "general" } },
  ];
  assert.equal(workflowFromBranch(branch), "general");
  assert.equal(orchestratorWorkflow(branch), "general");
  assert.equal(isSddWorkflow(branch), false);

  // A later malformed entry must not erase the last valid decision.
  assert.equal(workflowFromBranch([entry("sdd"), entry(undefined)]), "sdd");
  assert.equal(workflowFromBranch([{ type: "custom", customType: ORCHESTRATOR_WORKFLOW_TYPE }]), undefined);
});

test("workflow labels are stable for the UI and prompt", () => {
  assert.equal(workflowLabel("sdd"), "SDD");
  assert.equal(workflowLabel("general"), "General");
});
