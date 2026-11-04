import assert from "node:assert/strict";
import test from "node:test";

import { shouldAutoExitOnAgentEnd } from "../vendor/pi-herdr-subagents/src/auto-exit.ts";

const exit = (messages: any[] | undefined) => shouldAutoExitOnAgentEnd(false, messages, 0);

test("a clean assistant turn auto-exits", () => {
  assert.equal(exit([{ role: "user" }, { role: "assistant", stopReason: "stop" }]), true);
});

test("a run with no assistant turn is not a completion", () => {
  assert.equal(exit([]), false);
  assert.equal(exit([{ role: "toolResult" }]), false);
  assert.equal(exit([{ role: "user" }]), false);
});

test("errored or aborted turns stay open", () => {
  assert.equal(exit([{ role: "assistant", stopReason: "error" }]), false);
  assert.equal(exit([{ role: "assistant", stopReason: "aborted" }]), false);
});

test("legacy agent_end without a message list still exits", () => {
  assert.equal(exit(undefined), true);
});
