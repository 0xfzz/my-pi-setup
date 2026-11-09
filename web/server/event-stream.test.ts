import test from "node:test";
import assert from "node:assert/strict";
import { startWebServer } from "./main.ts";
import { clearSessionsForTests, registerSession, type SessionCore, type SessionStateLite } from "./sessions.ts";
import {
  attachSessionPlugins,
  clearWebPluginStateForTests,
  type MinimalEventBus,
} from "./plugin-host.ts";
import { WEB_PLUGIN_VIEW_EVENT } from "../../lib/web-plugins/view.ts";

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
  clearWebPluginStateForTests();
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

/**
 * A frame reader with a persistent buffer: frames that arrive in one chunk
 * stay readable for later predicates instead of being discarded when an
 * earlier predicate matches first.
 */
function createFrameReader(reader: ReaderLike) {
  const decoder = new TextDecoder();
  let buffer = "";
  return async function readUntil(
    predicate: (text: string) => boolean,
    timeoutMs = 5000,
  ): Promise<string> {
    if (predicate(buffer)) return buffer;
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
    throw new Error(
      `timed out waiting for SSE frame; received so far: ${JSON.stringify(buffer.slice(0, 500))}`,
    );
  };
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
    const readUntil = createFrameReader(reader);

    const connected = await readUntil((text) => text.includes("\"type\":\"connected\""));
    assert.match(connected, /"sessionId":"sse-live"/);
    assert.match(connected, /"isStreaming":false/);

    // A raw session event flows through the wire projection to the client.
    emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hello", contentIndex: 0 },
    });
    const delta = await readUntil((text) => text.includes("text_delta"));
    assert.match(delta, /"delta":"hello"/);

    // Tool execution end events drop their result payload on the wire.
    emit({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      isError: false,
      result: { stdout: "one megabyte" },
    });
    const toolEnd = await readUntil((text) => text.includes("tool_execution_end"));
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
    const readUntil = createFrameReader(reader);
    const text = await readUntil((chunk) => chunk.includes("startup_error"));
    assert.match(text, /Session not found/);
    const finished = await reader.read();
    assert.equal(finished.done, true);
  } finally {
    await handle.close();
  }
});

test("events stream carries plugin_state frames for the session's views", async () => {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  const bus: MinimalEventBus = {
    on: (channel: string, handler: (data: unknown) => void) => {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
      return () => {
        handlers.set(channel, (handlers.get(channel) ?? []).filter((h) => h !== handler));
      };
    },
    emit: (channel: string, data: unknown) => {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
  };

  const pluginStreamState: SessionStateLite = {
    sessionId: "plugin-stream",
    sessionFile: "",
    isStreaming: false,
    isBashRunning: false,
    isCompacting: false,
    model: undefined,
    contextUsage: null,
    thinkingLevel: "off",
  };
  // Lifecycle recording lives on the session event listener (the stream's
  // handleEvent), not on the extension bus — capture it so the test can
  // emit agent lifecycle events the way a real session would.
  let sessionListener: ((event: unknown) => void) | null = null;
  const emitSessionEvent = (event: unknown): void => {
    sessionListener?.(event);
  };
  const core: SessionCore = {
    sessionId: "plugin-stream",
    subscribe: (next: (event: unknown) => void) => {
      sessionListener = next;
      return () => {
        sessionListener = null;
      };
    },
    prompt: async () => {},
    abort: async () => {},
    isStreaming: () => false,
    getState: () => pluginStreamState,
  };
  registerSession(core, "/tmp/project");
  attachSessionPlugins({ sessionId: "plugin-stream", inner: { resourceLoader: { eventBus: bus } } });

  const handle = await startWebServer({ port: 0, host: "127.0.0.1" });
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/agent/plugin-stream/events`);
    assert.equal(res.status, 200);
    assert.ok(res.body !== null);
    const reader = res.body.getReader();
    const readUntil = createFrameReader(reader);

    await readUntil((text) => text.includes("\"type\":\"connected\""));
    // The initial plugin_state snapshot (empty views) rides right behind it.
    await readUntil((text) => text.includes("\"type\":\"plugin_state\""));

    // A view published through the session bus reaches the stream without a reload.
    bus.emit?.(WEB_PLUGIN_VIEW_EVENT, {
      pluginId: "todo",
      view: { type: "status", tone: "accent", text: "seeded via bus" },
    });
    const frame = await readUntil(
      (text) => text.includes("\"type\":\"plugin_state\"") && text.includes("\"todo\""),
    );
    assert.match(frame, /seeded via bus/);

    // Lifecycle events arrive on the session event listener; the stream
    // records them and the running flag flips in the next plugin_state frame.
    emitSessionEvent({ type: "agent_start" });
    await readUntil(
      (text) => text.includes("\"type\":\"plugin_state\"") && text.includes("\"running\":true"),
    );
    // End the stream from the client side so close() never waits on it.
    await reader.cancel();
  } finally {
    await handle.close();
  }
});
