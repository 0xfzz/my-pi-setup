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

test("toClientAgentEvent normalizes pi toolCall blocks to the browser shape", () => {
  const projected = toClientAgentEvent({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "text", text: "run it" },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
      ],
    },
  });
  assert.deepEqual(projected, {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "text", text: "run it" },
        { type: "toolCall", toolCallId: "call-1", toolName: "bash", rawInput: '{"command":"ls"}' },
      ],
    },
  });
});

test("toClientAgentEvent keeps already-normalized toolCall blocks and empty arguments", () => {
  const projected = toClientAgentEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", toolCallId: "c9", toolName: "read", rawInput: '{"path":"a"}' },
        { type: "toolCall", id: "c10", name: "bash", arguments: {} },
      ],
    },
  });
  const message = projected?.message as { content: unknown[] } | undefined;
  assert.deepEqual(message?.content, [
    { type: "toolCall", toolCallId: "c9", toolName: "read", rawInput: '{"path":"a"}' },
    { type: "toolCall", toolCallId: "c10", toolName: "bash", rawInput: "" },
  ]);
});

test("toClientAgentEvent keeps user message content (text and image blocks)", () => {
  const event = {
    type: "message_end",
    message: {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
      ],
    },
  };
  assert.deepEqual(toClientAgentEvent(event), event);
});

test("entry_appended projects only bash executions, capped", () => {
  assert.equal(toClientAgentEvent({ type: "entry_appended", entry: { type: "message", message: { role: "assistant" } } }), null);
  const projected = toClientAgentEvent({
    type: "entry_appended",
    entry: {
      type: "message",
      message: {
        role: "bashExecution",
        command: "ls",
        output: "x".repeat(9_000),
        exitCode: 0,
        cancelled: false,
        truncated: true,
      },
    },
  });
  assert.equal(projected?.type, "bash_execution_end");
  const bash = projected as unknown as {
    output: string;
    command: string;
    exitCode: number;
    cancelled: boolean;
    truncated: boolean;
  };
  assert.equal(bash.output.length, 8_001);
  assert.deepEqual(
    { command: bash.command, exitCode: bash.exitCode, cancelled: bash.cancelled, truncated: bash.truncated },
    { command: "ls", exitCode: 0, cancelled: false, truncated: true },
  );
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

test("toClientAgentEvent bounds a compaction's start and end", () => {
  assert.deepEqual(
    toClientAgentEvent({ type: "compaction_start", reason: "manual" }),
    { type: "compaction_start", reason: "manual" },
  );
  // The summary and the preparation never cross the wire; the token counts,
  // the reason and the failure text do.
  assert.deepEqual(
    toClientAgentEvent({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      result: {
        summary: "x".repeat(50_000),
        firstKeptEntryId: "entry-1",
        tokensBefore: 120_000,
        estimatedTokensAfter: 9_000,
        usage: { input: 1 },
        details: { readFiles: ["a.ts"] },
      },
    }),
    {
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      tokensBefore: 120_000,
      tokensAfter: 9_000,
    },
  );
});

test("toClientAgentEvent keeps a failed compaction's reason and message", () => {
  assert.deepEqual(
    toClientAgentEvent({
      type: "compaction_end",
      reason: "overflow",
      aborted: false,
      willRetry: false,
      errorMessage: "Context overflow recovery failed: session too small",
    }),
    {
      type: "compaction_end",
      reason: "overflow",
      aborted: false,
      willRetry: false,
      errorMessage: "Context overflow recovery failed: session too small",
    },
  );
  // A cancelled compaction carries no message: aborted is the signal.
  assert.deepEqual(
    toClientAgentEvent({ type: "compaction_end", reason: "manual", aborted: true, willRetry: false }),
    { type: "compaction_end", reason: "manual", aborted: true, willRetry: false },
  );
});

test("toClientAgentEvent announces a compaction entry a custom compactor appended", () => {
  // VCC commits its compaction as a `turn_end` boundary draft, so pi announces
  // it as an appended entry rather than compaction_start/compaction_end. The
  // browser needs the signal to re-read the transcript; the summary stays off
  // the wire and comes from the session file.
  assert.deepEqual(
    toClientAgentEvent({
      type: "entry_appended",
      entry: {
        type: "compaction",
        id: "c1",
        summary: "x".repeat(40_000),
        firstKeptEntryId: "c1",
        tokensBefore: 99_000,
        details: { compactor: "pi-vcc" },
      },
    }),
    { type: "compaction_applied" },
  );
  // Other custom entries still project to nothing (only bash has a projection).
  assert.equal(
    toClientAgentEvent({ type: "entry_appended", entry: { type: "custom", id: "x" } }),
    null,
  );
});
