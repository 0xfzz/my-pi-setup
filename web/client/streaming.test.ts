import test from "node:test";
import assert from "node:assert/strict";
import {
  INITIAL_STREAMING_STATE,
  assistantEntryFromMessage,
  streamReducer,
  toAssistantBlocks,
} from "./streaming.ts";

test("run_start begins a run with no message", () => {
  assert.deepEqual(streamReducer(INITIAL_STREAMING_STATE, { type: "run_start" }), {
    isStreaming: true,
    streamingMessage: null,
  });
});

test("run_end resets to the initial state", () => {
  const streaming = streamReducer(INITIAL_STREAMING_STATE, { type: "run_start" });
  assert.deepEqual(streamReducer(streaming, { type: "run_end" }), INITIAL_STREAMING_STATE);
});

test("message_end keeps the run active — tool calls and message gaps do not blip the indicators", () => {
  // A run starts, a message streams, the message commits — but the run
  // continues (a tool call executes, another message is next). The
  // working line and the sidebar's running mark key off isStreaming and
  // must stay steady; only the streamed message clears.
  let state = streamReducer(INITIAL_STREAMING_STATE, { type: "run_start" });
  state = streamReducer(state, {
    type: "message_start",
    message: { role: "assistant", content: [{ type: "text", text: "calling a tool" }] },
  });
  assert.equal(state.isStreaming, true);
  state = streamReducer(state, { type: "message_end" });
  assert.deepEqual(
    state,
    { isStreaming: true, streamingMessage: null },
    "the message cleared but the run is still active",
  );
  // The next message in the same run streams fine.
  state = streamReducer(state, {
    type: "message_start",
    message: { role: "assistant", content: [{ type: "text", text: "" }] },
  });
  assert.equal(state.streamingMessage?.content[0]?.kind, "text");
  // Only the run's settle ends it.
  state = streamReducer(state, { type: "run_end" });
  assert.deepEqual(state, INITIAL_STREAMING_STATE);
});

test("snapshot keeps only assistant messages and normalizes blocks", () => {
  const next = streamReducer(INITIAL_STREAMING_STATE, {
    type: "snapshot",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "existing" },
        { type: "toolCall", toolCallId: "c1", name: "read", rawInput: "{}" },
      ],
    },
  });
  assert.equal(next.isStreaming, true);
  assert.deepEqual(next.streamingMessage, {
    role: "assistant",
    content: [
      { kind: "text", text: "existing" },
      { kind: "toolCall", toolCallId: "c1", toolName: "read", rawInput: "{}" },
    ],
  });

  const nonAssistant = streamReducer(INITIAL_STREAMING_STATE, {
    type: "snapshot",
    message: { role: "user", content: "hello" },
  });
  assert.deepEqual(nonAssistant, INITIAL_STREAMING_STATE);
});

test("text deltas accumulate and text_end replaces with authoritative content", () => {
  let state = streamReducer(INITIAL_STREAMING_STATE, {
    type: "snapshot",
    message: { role: "assistant", content: [] },
  });
  state = streamReducer(state, {
    type: "delta",
    event: { type: "text_start", contentIndex: 0 },
  });
  state = streamReducer(state, {
    type: "delta",
    event: { type: "text_delta", contentIndex: 0, delta: "hel" },
  });
  state = streamReducer(state, {
    type: "delta",
    event: { type: "text_delta", contentIndex: 0, delta: "lo" },
  });
  assert.deepEqual(state.streamingMessage?.content[0], { kind: "text", text: "hello" });

  state = streamReducer(state, {
    type: "delta",
    event: { type: "text_end", contentIndex: 0, content: "hello!" },
  });
  assert.deepEqual(state.streamingMessage?.content[0], { kind: "text", text: "hello!" });
});

test("thinking deltas accumulate in a separate block", () => {
  let state = streamReducer(INITIAL_STREAMING_STATE, {
    type: "snapshot",
    message: { role: "assistant", content: [] },
  });
  state = streamReducer(state, { type: "delta", event: { type: "thinking_start", contentIndex: 0 } });
  state = streamReducer(state, { type: "delta", event: { type: "thinking_delta", contentIndex: 0, delta: "hmm" } });
  assert.deepEqual(state.streamingMessage?.content[0], { kind: "thinking", thinking: "hmm" });
});

test("toolcall start, delta and end build a tool block", () => {
  let state = streamReducer(INITIAL_STREAMING_STATE, {
    type: "snapshot",
    message: { role: "assistant", content: [] },
  });
  state = streamReducer(state, {
    type: "delta",
    event: { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "bash" },
  });
  state = streamReducer(state, {
    type: "delta",
    event: { type: "toolcall_delta", contentIndex: 0, delta: '{"cmd":"ls"}' },
  });
  assert.deepEqual(state.streamingMessage?.content[0], {
    kind: "toolCall",
    toolCallId: "call-1",
    toolName: "bash",
    rawInput: '{"cmd":"ls"}',
  });

  state = streamReducer(state, {
    type: "delta",
    event: {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { id: "call-1", name: "bash", arguments: { cmd: "ls" } },
    },
  });
  // The end's parsed arguments are authoritative; an aborted mid-argument
  // call without them keeps the streamed JSON.
  assert.deepEqual(state.streamingMessage?.content[0], {
    kind: "toolCall",
    toolCallId: "call-1",
    toolName: "bash",
    rawInput: '{"cmd":"ls"}',
  });
});

test("toolcall_end without arguments keeps the streamed raw input", () => {
  let state = streamReducer(INITIAL_STREAMING_STATE, {
    type: "snapshot",
    message: { role: "assistant", content: [] },
  });
  state = streamReducer(state, {
    type: "delta",
    event: { type: "toolcall_start", contentIndex: 0, id: "call-2", toolName: "read" },
  });
  state = streamReducer(state, {
    type: "delta",
    event: { type: "toolcall_delta", contentIndex: 0, delta: '{"path":"a.ts"' },
  });
  state = streamReducer(state, {
    type: "delta",
    event: { type: "toolcall_end", contentIndex: 0, toolCall: { id: "call-2", name: "read" } },
  });
  assert.deepEqual(state.streamingMessage?.content[0], {
    kind: "toolCall",
    toolCallId: "call-2",
    toolName: "read",
    rawInput: '{"path":"a.ts"',
  });
});

test("toAssistantBlocks accepts pi's toolCall spelling and image blocks", () => {
  const blocks = toAssistantBlocks([
    { type: "text", text: "hi" },
    { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
    { type: "toolCall", id: "c2", name: "bash", arguments: {} },
    { type: "image", data: "aGk=", mimeType: "image/png" },
  ]);
  assert.deepEqual(blocks, [
    { kind: "text", text: "hi" },
    { kind: "toolCall", toolCallId: "c1", toolName: "bash", rawInput: '{"command":"ls"}' },
    { kind: "toolCall", toolCallId: "c2", toolName: "bash", rawInput: "" },
    { kind: "image", data: "aGk=", mimeType: "image/png" },
  ]);
});

test("delta events without a snapshot are ignored", () => {
  const state = streamReducer(INITIAL_STREAMING_STATE, {
    type: "delta",
    event: { type: "text_delta", contentIndex: 0, delta: "orphan" },
  });
  assert.deepEqual(state, INITIAL_STREAMING_STATE);
});

test("unknown delta types are ignored", () => {
  let state = streamReducer(INITIAL_STREAMING_STATE, {
    type: "snapshot",
    message: { role: "assistant", content: [] },
  });
  state = streamReducer(state, { type: "delta", event: { type: "something_new" } });
  assert.equal(state.isStreaming, true);
  assert.deepEqual(state.streamingMessage?.content, []);
});

test("toAssistantBlocks handles strings, arrays and junk", () => {
  assert.deepEqual(toAssistantBlocks("plain"), [{ kind: "text", text: "plain" }]);
  assert.deepEqual(toAssistantBlocks(""), []);
  assert.deepEqual(
    toAssistantBlocks([{ type: "text", text: "a" }, { type: "junk" }, null, 42]),
    [{ kind: "text", text: "a" }],
  );
  assert.deepEqual(toAssistantBlocks(undefined), []);
  assert.deepEqual(toAssistantBlocks({ not: "array" }), []);
});

test("assistantEntryFromMessage marks aborted and provider-error stop reasons", () => {
  assert.deepEqual(
    assistantEntryFromMessage({ content: [], stopReason: "aborted" }),
    { blocks: [], aborted: true },
  );
  assert.deepEqual(
    assistantEntryFromMessage({
      content: [{ type: "text", text: "reply so far" }],
      stopReason: "error",
      errorMessage: "429 rate limit exceeded",
    }),
    { blocks: [{ kind: "text", text: "reply so far" }], error: "429 rate limit exceeded" },
  );
  assert.deepEqual(
    assistantEntryFromMessage({ content: "hi", stopReason: "stop" }),
    { blocks: [{ kind: "text", text: "hi" }] },
  );
});

test("assistantEntryFromMessage falls back to a default provider error when the provider reports none", () => {
  assert.deepEqual(
    assistantEntryFromMessage({ content: [], stopReason: "error" }),
    { blocks: [], error: "provider error" },
  );
  assert.deepEqual(
    assistantEntryFromMessage({ content: [], stopReason: "error", errorMessage: "" }),
    { blocks: [], error: "provider error" },
  );
});
