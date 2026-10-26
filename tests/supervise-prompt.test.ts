import test from "node:test";
import assert from "node:assert/strict";

import { SUPERVISOR_MODE_GUIDANCE } from "../lib/supervise-mode.ts";

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
  assert.ok(SUPERVISOR_MODE_GUIDANCE.length <= MAX_CHARS, `prompt is ${SUPERVISOR_MODE_GUIDANCE.length} chars (max ${MAX_CHARS})`);
  assert.ok(SUPERVISOR_MODE_GUIDANCE.split("\n").length <= MAX_LINES, `prompt is ${SUPERVISOR_MODE_GUIDANCE.split("\n").length} lines (max ${MAX_LINES})`);
  assert.doesNotMatch(SUPERVISOR_MODE_GUIDANCE, /\n{3,}/, "no blank-line padding");
});

test("the brief names the loop, the review tools and the verifiable-evidence rule", () => {
  for (const needle of ["orch_handoff", "orch_spawn", "orch_brief", "orch_check", "orch_review", "evidenceRefs", "lane", "revise"]) {
    assert.ok(SUPERVISOR_MODE_GUIDANCE.includes(needle), `prompt must mention ${needle}`);
  }
});

test("the brief forbids implementing and requires the user for a decision", () => {
  assert.match(SUPERVISOR_MODE_GUIDANCE, /do not implement/i);
  assert.match(SUPERVISOR_MODE_GUIDANCE, /ask_user/);
  assert.doesNotMatch(SUPERVISOR_MODE_GUIDANCE, /you may implement/i);
});
