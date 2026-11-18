import test from "node:test";
import assert from "node:assert/strict";
import { startWebServer } from "./main.ts";
import { clearSessionsForTests, registerSession, type SessionCore, type SessionStateLite } from "./sessions.ts";
import { createStreamTracker } from "./stream-tracker.ts";
import { attachSessionPlugins, type MinimalEventBus } from "./plugin-sessions.ts";
import { clearWebPluginStateForTests } from "./plugin-fixtures.ts";
import { WEB_PLUGIN_VIEW_EVENT } from "../plugin-contracts/view.ts";
import { parseEnvelope } from "../protocol/envelope.ts";

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
  const tracker = createStreamTracker();
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
    isStreaming: () => tracker.snapshot().started,
    getState: () => state,
    getStreamSnapshot: () => tracker.snapshot(),
  };
  return {
    core,
    emit: (event: unknown) => {
      // The host taps raw events into the tracker, then fans them out —
      // the same order the bridge and in-process cores use.
      tracker.feed(event);
      listener?.(event);
    },
  };
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

function sseDataFrames(text: string): unknown[] {
  return text
    .split("\n\n")
    .flatMap((block) => block.split("\n"))
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as unknown);
}

function assertSessionEnvelope(frame: unknown, payloadType: string): void {
  const parsed = parseEnvelope(frame);
  assert.ok(parsed.ok, `frame must be a protocol envelope: ${JSON.stringify(frame).slice(0, 300)}`);
  assert.equal(parsed.envelope.name, "session.events");
  assert.equal((parsed.envelope.payload as { type?: unknown }).type, payloadType);
}

test("every agent stream frame is a protocol envelope, including startup errors", async () => {
  const handle = await startWebServer({ port: 0, host: "127.0.0.1" });
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/agent/definitely-not/events`);
    assert.equal(res.status, 200);
    const frames = sseDataFrames(await res.text());
    assert.ok(frames.length > 0, "the stream must explain why it could not start");
    for (const frame of frames) assertSessionEnvelope(frame, "startup_error");
  } finally {
    await handle.close();
  }
});

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
    assertSessionEnvelope(sseDataFrames(connected)[0], "connected");

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

test("a stream attaching mid-turn replays the in-flight partial after connected", async () => {
  const { core, emit } = sseLiveCore();
  registerSession(core, "/tmp/project");
  const handle = await startWebServer({ port: 0, host: "127.0.0.1" });
  try {
    // The turn starts BEFORE any browser stream exists — exactly the
    // reload-mid-stream case: message_start already happened.
    emit({ type: "message_start", message: { role: "assistant", content: [] } });
    emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "never",
        partial: { role: "assistant", content: [{ type: "text", text: "half a reply" }] },
      },
    });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/agent/sse-live/events`);
    const reader = res.body!.getReader();
    const readUntil = createFrameReader(reader);

    const connected = await readUntil((text) => text.includes("\"type\":\"connected\""));
    assert.match(connected, /"isStreaming":true/);
    assertSessionEnvelope(sseDataFrames(connected)[0], "connected");

    // The replay: a synthetic message_start carrying the cumulative
    // partial, BEFORE any live delta — the client snapshots it and the
    // deltas that follow append instead of dropping.
    const replayed = await readUntil((text) => text.includes("half a reply"));
    assertSessionEnvelope(
      sseDataFrames(replayed).find((frame) => JSON.stringify(frame).includes("half a reply")),
      "message_start",
    );
    assert.match(replayed, /"type":"message_start"/);
    assert.match(replayed, /"role":"assistant"/);
    const replayIndex = replayed.indexOf("half a reply");
    assert.ok(replayIndex !== -1);

    // A live delta after the attach continues the same message.
    emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "!", contentIndex: 0 },
    });
    const delta = await readUntil((text) => text.includes('"delta":"!"'));
    assert.ok(delta.indexOf('"delta":"!"') > replayIndex, "the replay precedes live deltas");
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
    assertSessionEnvelope(sseDataFrames(text)[0], "startup_error");
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

    const connected = await readUntil((text) => text.includes("\"type\":\"connected\""));
    assertSessionEnvelope(sseDataFrames(connected)[0], "connected");
    // The initial plugin_state snapshot (empty views) rides right behind it.
    const initial = await readUntil((text) => text.includes("\"type\":\"plugin_state\""));
    assertSessionEnvelope(
      sseDataFrames(initial).find((frame) => JSON.stringify(frame).includes("plugin_state")),
      "plugin_state",
    );

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

test("closing the server cuts an open event stream instead of waiting on it", async () => {
  const { core } = sseLiveCore();
  registerSession(core, "/tmp/project");
  const handle = await startWebServer({ port: 0, host: "127.0.0.1" });
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/agent/sse-live/events`);
    assert.equal(res.status, 200);
    assert.ok(res.body !== null);
    reader = res.body.getReader();
    const readUntil = createFrameReader(reader);
    await readUntil((text) => text.includes("\"type\":\"connected\""));

    // close() must return promptly, not wait for the client to leave.
    const closed = Date.now();
    await handle.close();
    const elapsed = Date.now() - closed;
    assert.ok(elapsed < 2_000, `close() must not block on an open stream (took ${elapsed} ms)`);

    // ...and the stream is cut. A destroyed socket surfaces as an aborted read
    // rather than a clean EOF, so the pin is that the read settles at all.
    const outcome = await Promise.race([
      reader.read().then(read => (read.done ? "ended" : "data"), () => "aborted"),
      new Promise<string>(resolve => setTimeout(() => resolve("hung"), 2_000)),
    ]);
    assert.notEqual(outcome, "hung", "an open stream must end when the server closes");
  } finally {
    if (reader !== null) await reader.cancel().catch(() => {});
    // A second close is a no-op; the app is already down.
    await handle.close().catch(() => {});
  }
});
