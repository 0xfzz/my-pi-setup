import test from "node:test";
import assert from "node:assert/strict";
import { slimBridgeEvent } from "../lib/bridge-event-slim.ts";

const partial = { role: "assistant", content: [{ type: "text", text: "so far" }] };
const message = { role: "assistant", content: [{ type: "text", text: "so far" }] };

test("a text delta crosses the bridge without the cumulative message or partial", () => {
  const slim = slimBridgeEvent({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial },
  });
  assert.deepEqual(slim, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
  });
});

test("every delta kind drops the cumulative partial", () => {
  for (const type of ["text_delta", "thinking_delta", "toolcall_delta"]) {
    const slim = slimBridgeEvent({
      type: "message_update",
      message,
      assistantMessageEvent: { type, contentIndex: 1, delta: "d", partial },
    }) as { assistantMessageEvent: Record<string, unknown> };
    assert.equal("partial" in slim.assistantMessageEvent, false, type);
    assert.equal(slim.assistantMessageEvent.delta, "d", type);
  }
});

test("block starts and ends keep their partial, because the tracker builds the block from it", () => {
  for (const type of ["text_start", "thinking_start", "toolcall_start", "text_end", "thinking_end", "toolcall_end"]) {
    const event = {
      type: "message_update",
      message,
      assistantMessageEvent: { type, contentIndex: 0, partial },
    };
    assert.deepEqual(slimBridgeEvent(event), { type: "message_update", assistantMessageEvent: { type, contentIndex: 0, partial } }, type);
  }
});

test("a message_update without a partial is only stripped of its top-level message", () => {
  assert.deepEqual(
    slimBridgeEvent({ type: "message_update", message, assistantMessageEvent: { type: "done" } }),
    { type: "message_update", assistantMessageEvent: { type: "done" } },
  );
});

test("message_start and message_end keep their message: they are the commit points", () => {
  for (const type of ["message_start", "message_end"]) {
    const event = { type, message };
    assert.deepEqual(slimBridgeEvent(event), event, type);
  }
});

test("events that are not message updates pass through unchanged, including non-objects", () => {
  const toolEvent = { type: "tool_execution_update", toolCallId: "c", partialResult: { stdout: "x" } };
  assert.equal(slimBridgeEvent(toolEvent), toolEvent);
  assert.equal(slimBridgeEvent(null), null);
  assert.equal(slimBridgeEvent("text"), "text");
});

test("a malformed assistantMessageEvent is passed through rather than guessed at", () => {
  const event = { type: "message_update", message, assistantMessageEvent: "oops" };
  assert.deepEqual(slimBridgeEvent(event), { type: "message_update", assistantMessageEvent: "oops" });
});
