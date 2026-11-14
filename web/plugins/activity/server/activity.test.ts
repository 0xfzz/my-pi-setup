import test from "node:test";
import assert from "node:assert/strict";

import type { TapEvent } from "../../../core/plugin-contracts/kernel/events.ts";
import {
  MAX_RECENT_TOOLS,
  activityView,
  applyActivity,
  emptyActivity,
  formatDuration,
  statusLine,
} from "./activity.ts";

function toolEvent(type: string, payload: Record<string, unknown>): TapEvent {
  return { channel: "session.tool", sessionId: "s1", project: "/repo", type, payload };
}

test("a tool's start and end become one row carrying its duration", () => {
  const started = applyActivity(emptyActivity(), toolEvent("tool_execution_start", { toolCallId: "c1", toolName: "bash" }), 1_000);
  const ended = applyActivity(started, toolEvent("tool_execution_end", { toolCallId: "c1", toolName: "bash" }), 2_500);
  assert.equal(ended.tools, 1);
  assert.deepEqual(ended.recent, [{ label: "bash", durationMs: 1_500, isError: false }]);
  assert.deepEqual(ended.running, {}, "the started call is no longer running");
  assert.deepEqual(activityView(ended).items, [{ text: "bash · 1.5s", status: "done" }]);
});

test("an end without its start still counts, with no duration", () => {
  const state = applyActivity(emptyActivity(), toolEvent("tool_execution_end", { toolCallId: "c9", toolName: "read" }), 10);
  assert.equal(state.tools, 1);
  assert.deepEqual(state.recent, [{ label: "read", durationMs: null, isError: false }]);
  assert.deepEqual(activityView(state).items, [{ text: "read", status: "done" }]);
});

test("a failed tool is counted and rendered as a failure", () => {
  const state = applyActivity(emptyActivity(), toolEvent("tool_execution_end", { toolCallId: "c1", toolName: "bash", isError: true }), 10);
  assert.equal(state.failures, 1);
  assert.deepEqual(activityView(state).items, [{ text: "bash", status: "failed" }]);
  assert.equal(statusLine(state), "1 tool · 1 failed");
});

test("a bash execution entry becomes a row, and a non-zero exit is a failure", () => {
  const entry = (command: string, exitCode: number | undefined): TapEvent => ({
    channel: "session.tool",
    sessionId: "s1",
    project: "/repo",
    type: "entry_appended",
    payload: { command, exitCode, cancelled: false },
  });
  const ok = applyActivity(emptyActivity(), entry("ls -la", 0), 10);
  assert.deepEqual(ok.recent, [{ label: "bash: ls -la", durationMs: null, isError: false }]);

  const failed = applyActivity(ok, entry("false", 2), 20);
  assert.equal(failed.tools, 2);
  assert.equal(failed.failures, 1);
  assert.equal(failed.recent[0]?.isError, true);
});

test("the recent list is bounded and reports what it left out", () => {
  let state = emptyActivity();
  for (let i = 0; i < MAX_RECENT_TOOLS + 3; i++) {
    state = applyActivity(state, toolEvent("tool_execution_end", { toolCallId: `c${i}`, toolName: `tool-${i}` }), i);
  }
  const view = activityView(state);
  assert.equal(view.items.length, MAX_RECENT_TOOLS);
  assert.equal(view.omitted, 3);
  assert.deepEqual(view.items[0], { text: `tool-${MAX_RECENT_TOOLS + 2}`, status: "done" }, "newest first");
});

test("a message is counted and repaints nothing else", () => {
  const state = applyActivity(emptyActivity(), {
    channel: "session.message",
    sessionId: "s1",
    type: "message_end",
    payload: { role: "assistant", blockTypes: ["text"] },
  }, 10);
  assert.equal(state.messages, 1);
  assert.equal(state.tools, 0);
  assert.deepEqual(activityView(state).items, []);
});

test("an event this plugin does not track returns the same state, so the caller can skip the publish", () => {
  const state = emptyActivity();
  for (const type of ["agent_start", "agent_settled", "session_info_changed", "tool_execution_start"]) {
    const next = applyActivity(state, { channel: "session.lifecycle", sessionId: "s1", type, payload: {} }, 10);
    assert.equal(next, state, type);
  }
});

test("a tool event without its identity leaves the state alone", () => {
  const state = emptyActivity();
  assert.equal(applyActivity(state, toolEvent("tool_execution_start", { toolName: "bash" }), 1), state);
  assert.equal(applyActivity(state, toolEvent("tool_execution_end", { toolCallId: "c1" }), 1), state);
});

test("the status line is silent until something happened, then counts and pluralizes", () => {
  assert.equal(statusLine(emptyActivity()), null);
  const one = applyActivity(emptyActivity(), toolEvent("tool_execution_end", { toolCallId: "c1", toolName: "bash" }), 1);
  assert.equal(statusLine(one), "1 tool");
  const two = applyActivity(one, toolEvent("tool_execution_end", { toolCallId: "c2", toolName: "read" }), 2);
  assert.equal(statusLine(two), "2 tools");
});

test("durations read as milliseconds below a second and seconds above", () => {
  assert.equal(formatDuration(0), "0ms");
  assert.equal(formatDuration(999), "999ms");
  assert.equal(formatDuration(1_000), "1.0s");
  assert.equal(formatDuration(12_345), "12.3s");
});

test("a long bash command is a label, not a transcript line", () => {
  const state = applyActivity(emptyActivity(), {
    channel: "session.tool",
    sessionId: "s1",
    type: "entry_appended",
    payload: { command: `echo ${"x".repeat(200)}`, exitCode: 0 },
  }, 1);
  const label = state.recent[0]?.label ?? "";
  assert.ok(label.length <= 60, label);
  assert.ok(label.endsWith("…"), label);
});
