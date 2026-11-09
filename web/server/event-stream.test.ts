import test from "node:test";
import assert from "node:assert/strict";
import { startWebServer } from "./main.ts";
import { clearSessionsForTests, registerSession, type SessionCore, type SessionStateLite } from "./sessions.ts";

const state: SessionStateLite = {
  sessionId: "sse-live",
  sessionFile: "",
  isStreaming: false,
  isBashRunning: false,
  isCompacting: false,
  model: undefined,
  contextUsage: null,
  thinkingLevel: "off",
};

test.afterEach(() => {
  clearSessionsForTests();
});

function sseLiveCore(): { core: SessionCore; emit: (event: unknown) => void } {
  let listener: ((event: unknown) => void) | null = null;
  const core: SessionCore = {
    sessionId: "sse-live",
    subscribe: (next: (event: unknown) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    prompt: async () => {},
    abort: async () => {},
    isStreaming: () => false,
    getState: () => state,
  };
  return { core, emit: (event: unknown) => { listener?.(event); } };
}

interface ReaderLike {
  read(): Promise<{ done?: boolean; value?: Uint8Array }>;
}

async function readUntil(
  reader: ReaderLike,
  predicate: (text: string) => boolean,
  timeoutMs = 5000,
): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
    ]);
    if (chunk === null) break;
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    if (predicate(buffer)) return buffer;
  }
  throw new Error(`timed out waiting for SSE frame; received so far: ${JSON.stringify(buffer.slice(0, 500))}`);
}

test("events stream sends connected, forwards projected events, closes on shutdown", async () => {
  const { core, emit } = sseLiveCore();
  registerSession(core, "/tmp/project");
  const handle = await startWebServer({ port: 0, host: "127.0.0.1" });
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/agent/sse-live/events`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.ok(res.body !== null, "stream body must be readable");
    const reader = res.body.getReader();

    const connected = await readUntil(reader, (text) => text.includes("\"type\":\"connected\""));
    assert.match(connected, /"sessionId":"sse-live"/);
    assert.match(connected, /"isStreaming":false/);

    // A raw session event flows through the wire projection to the client.
    emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hello", contentIndex: 0 },
    });
    const delta = await readUntil(reader, (text) => text.includes("text_delta"));
    assert.match(delta, /"delta":"hello"/);

    // Tool execution end events drop their result payload on the wire.
    emit({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      isError: false,
      result: { stdout: "one megabyte" },
    });
    const toolEnd = await readUntil(reader, (text) => text.includes("tool_execution_end"));
    assert.doesNotMatch(toolEnd, /one megabyte/);

    // session_shutdown closes the stream.
    emit({ type: "session_shutdown" });
    const finished = await reader.read();
    assert.equal(finished.done, true, "stream must end after session_shutdown");
  } finally {
    await handle.close();
  }
});

test("events stream reports unknown sessions with startup_error and ends", async () => {
  const handle = await startWebServer({ port: 0, host: "127.0.0.1" });
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/agent/definitely-not/events`);
    assert.equal(res.status, 200);
    assert.ok(res.body !== null);
    const reader = res.body.getReader();
    const text = await readUntil(reader, (chunk) => chunk.includes("startup_error"));
    assert.match(text, /Session not found/);
    const finished = await reader.read();
    assert.equal(finished.done, true);
  } finally {
    await handle.close();
  }
});
