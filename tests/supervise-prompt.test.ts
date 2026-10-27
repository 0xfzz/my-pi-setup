import test from "node:test";
import assert from "node:assert/strict";

import { GENERAL_ORCHESTRATOR_GUIDANCE, SUPERVISOR_MODE_GUIDANCE, supervisorGuidance } from "../lib/supervise-mode.ts";

/**
 * The briefings ride on every request, so their size is a per-turn cost.
 *
 * These budgets are deliberately tight: the previous text was ~3x this and
 * repeated what the review gate already enforces. The assertions below are the
 * contract — if a rule is mechanically enforced, it does not need a paragraph.
 */
const MAX_CHARS = 1400;
const MAX_LINES = 18;

test("the brief stays inside the prompt budget", () => {
  for (const [name, guidance] of [
    ["SDD", SUPERVISOR_MODE_GUIDANCE],
    ["General", GENERAL_ORCHESTRATOR_GUIDANCE],
  ] as const) {
    assert.ok(guidance.length <= MAX_CHARS, `${name} prompt is ${guidance.length} chars (max ${MAX_CHARS})`);
    assert.ok(guidance.split("\n").length <= MAX_LINES, `${name} prompt is ${guidance.split("\n").length} lines (max ${MAX_LINES})`);
    assert.doesNotMatch(guidance, /\n{3,}/, `${name} prompt has no blank-line padding`);
  }
});

test("the general brief keeps the review loop but drops the SDD gate", () => {
  for (const needle of ["orch_handoff", "orch_spawn", "orch_brief", "orch_check", "orch_review", "lane", "revise"]) {
    assert.ok(GENERAL_ORCHESTRATOR_GUIDANCE.includes(needle), `general prompt must mention ${needle}`);
  }
  assert.match(GENERAL_ORCHESTRATOR_GUIDANCE, /general workflow/i);
  assert.doesNotMatch(GENERAL_ORCHESTRATOR_GUIDANCE, /orch_spec_review|designRef/i);
  assert.equal(supervisorGuidance("sdd"), SUPERVISOR_MODE_GUIDANCE);
  assert.equal(supervisorGuidance("general"), GENERAL_ORCHESTRATOR_GUIDANCE);
});

test("the brief names the loop, the review tools and the verifiable-evidence rule", () => {
  for (const needle of ["orch_handoff", "orch_spawn", "orch_brief", "orch_check", "orch_review", "evidenceRefs", "lane", "revise", "bash/python/node"]) {
    assert.ok(SUPERVISOR_MODE_GUIDANCE.includes(needle), `prompt must mention ${needle}`);
  }
});

test("the brief forbids implementing and requires the user for a decision", () => {
  assert.match(SUPERVISOR_MODE_GUIDANCE, /do not implement/i);
  assert.match(SUPERVISOR_MODE_GUIDANCE, /ask_user/);
  assert.doesNotMatch(SUPERVISOR_MODE_GUIDANCE, /you may implement/i);
});
