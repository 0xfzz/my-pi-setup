import test from "node:test";
import assert from "node:assert/strict";
import {
  isDroppableEvent,
  isEventIncludedInSnapshot,
  isNestedToolExecutionEvent,
  isSystemMessageEvent,
  toClientAgentEvent,
} from "./wire.ts";

test("toClientAgentEvent drops turn markers and appended entries", () => {
  for (const type of ["turn_start", "turn_end", "entry_appended"]) {
    assert.equal(toClientAgentEvent({ type }), null, `${type} must be dropped`);
  }
});

test("toClientAgentEvent drops system messages (prompt/tool loadout)", () => {
  assert.equal(isSystemMessageEvent({ type: "message_start", message: { role: "system" } }), true);
  assert.equal(
    toClientAgentEvent({ type: "message_start", message: { role: "system", content: "big prompt" } }),
    null,
  );
  assert.equal(
    toClientAgentEvent({ type: "message_end", message: { role: "system" } }),
    null,
  );
});

test("toClientAgentEvent slims non-assistant message_start to the role", () => {
  const projected = toClientAgentEvent({
    type: "message_start",
    message: { role: "toolResult", content: [{ type: "text", text: "1 MB of output" }] },
  });
  assert.deepEqual(projected, { type: "message_start", message: { role: "toolResult" } });
});

test("toClientAgentEvent keeps assistant message_start intact", () => {
  const event = { type: "message_start", message: { role: "assistant", content: [] } };
  assert.deepEqual(toClientAgentEvent(event), event);
});

test("toClientAgentEvent strips partial and keeps toolcall metadata on message_update", () => {
  const projected = toClientAgentEvent({
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_delta",
      contentIndex: 1,
      delta: '{"cmd":',
      partial: {
        content: [
          { type: "text", text: "hello" },
          { type: "toolCall", id: "call-1", name: "bash" },
        ],
      },
    },
  });
  assert.deepEqual(projected, {
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_delta",
      contentIndex: 1,
      delta: '{"cmd":',
      id: "call-1",
      toolName: "bash",
    },
  });
});

test("toClientAgentEvent passes partial-free message_update through", () => {
  const event = {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "hi" },
  };
  assert.deepEqual(toClientAgentEvent(event), event);
});

test("toClientAgentEvent drops message_update without an object payload", () => {
  assert.equal(toClientAgentEvent({ type: "message_update", assistantMessageEvent: "junk" }), null);
});

test("nested tool execution events are slimmed", () => {
  assert.equal(
    isNestedToolExecutionEvent({ type: "tool_execution_start", parentToolCallId: "p1" }),
    true,
  );
  assert.equal(
    isNestedToolExecutionEvent({ type: "tool_execution_start", parentToolCallId: "" }),
    false,
  );

  const nestedStart = toClientAgentEvent({
    type: "tool_execution_start",
    toolCallId: "inner",
    toolName: "read",
    parentToolCallId: "outer",
    extra: "dropped",
  });
  assert.deepEqual(nestedStart, {
    type: "tool_execution_start",
    toolCallId: "inner",
    toolName: "read",
    parentToolCallId: "outer",
  });

  assert.equal(
    toClientAgentEvent({
      type: "tool_execution_update",
      toolCallId: "inner",
      toolName: "read",
      parentToolCallId: "outer",
      partialResult: { chunk: 1 },
    }),
    null,
    "nested updates are dropped",
  );

  const nestedEnd = toClientAgentEvent({
    type: "tool_execution_end",
    toolCallId: "inner",
    toolName: "read",
    parentToolCallId: "outer",
    result: "1 MB",
  });
  assert.deepEqual(nestedEnd, {
    type: "tool_execution_end",
    toolCallId: "inner",
    toolName: "read",
    isError: undefined,
    parentToolCallId: "outer",
  });
});

test("top-level tool execution events keep their shape (end drops result)", () => {
  const update = toClientAgentEvent({
    type: "tool_execution_update",
    toolCallId: "outer",
    toolName: "bash",
    partialResult: { tail: "ls" },
  });
  assert.deepEqual(update, {
    type: "tool_execution_update",
    toolCallId: "outer",
    toolName: "bash",
    partialResult: { tail: "ls" },
  });

  const end = toClientAgentEvent({
    type: "tool_execution_end",
    toolCallId: "outer",
    toolName: "bash",
    isError: false,
    result: { stdout: "…" },
  });
  assert.deepEqual(end, {
    type: "tool_execution_end",
    toolCallId: "outer",
    toolName: "bash",
    isError: false,
  });
});

test("agent_end is slimmed to its type", () => {
  assert.deepEqual(toClientAgentEvent({ type: "agent_end", extra: true }), { type: "agent_end" });
});

test("isDroppableEvent marks rebuildable deltas", () => {
  assert.equal(isDroppableEvent({ type: "tool_execution_update" }), true);
  assert.equal(
    isDroppableEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta" } }),
    true,
  );
  assert.equal(
    isDroppableEvent({ type: "message_update", assistantMessageEvent: { type: "text_end" } }),
    false,
  );
  assert.equal(isDroppableEvent({ type: "message_update" }), false);
  assert.equal(isDroppableEvent({ type: "message_end" }), false);
});

test("isEventIncludedInSnapshot matches the snapshot message object", () => {
  const snapshot = { role: "assistant", content: [] };
  assert.equal(isEventIncludedInSnapshot({ type: "message_start", message: snapshot }, snapshot), true);
  assert.equal(isEventIncludedInSnapshot({ type: "message_start", message: {} }, snapshot), false);
  assert.equal(isEventIncludedInSnapshot({ type: "message_start", message: snapshot }, undefined), false);
});
