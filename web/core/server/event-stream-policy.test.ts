import test from "node:test";
import assert from "node:assert/strict";
import { attachAgentEventStream, type EventStreamSession } from "./event-stream.ts";
import type { EventChannel } from "../http/sse.ts";
import { attachBridge, getBridge } from "./bridge.ts";
import { clearSessionsForTests, getSession } from "./sessions.ts";
import { clearPluginSessionState, registerSessionBusForTests } from "./plugin-sessions.ts";
import { WEB_PLUGIN_UI_SYNC_EVENT } from "../plugin-contracts/ui-event-models.ts";
import { parseEnvelope } from "../protocol/envelope.ts";

// A producer port, not a fake HTTP response. Socket/framing tests live in sse.test.ts.
function channelFixture() {
  let closed = false;
  const callbacks = new Set<() => void>();
  const frames: unknown[] = [];
  const channel: EventChannel = {
    get closed() { return closed; },
    bufferedBytes: 0,
    send: frame => { if (!closed) frames.push(frame); },
    sendEncoded: encoded => { if (!closed) frames.push(JSON.parse(encoded)); },
    checkPressure: () => {},
    onClose: callback => { if (closed) callback(); else callbacks.add(callback); },
    close: () => {
      if (closed) return;
      closed = true;
      for (const callback of callbacks) callback();
      callbacks.clear();
    },
  };
  return { channel, frames };
}

function payloadOf(frame: unknown): Record<string, unknown> {
  const parsed = parseEnvelope(frame);
  assert.ok(parsed.ok, `frame must be a protocol envelope: ${parsed.ok ? "" : parsed.error.message}`);
  assert.equal(parsed.envelope.name, "session.events");
  return parsed.envelope.payload as Record<string, unknown>;
}

function sessionFixture() {
  let listener: ((event: unknown) => void) | null = null;
  let subscriptions = 0;
  let unsubscriptions = 0;
  const session: EventStreamSession = {
    subscribe: callback => {
      subscriptions += 1;
      listener = callback;
      return () => { unsubscriptions += 1; listener = null; };
    },
    isStreaming: () => false,
    getStreamSnapshot: () => ({ started: false, message: null }),
    getState: () => ({ sessionId: "policy", sessionFile: "", isStreaming: false, isBashRunning: false, isCompacting: false, thinkingLevel: "off", model: undefined, contextUsage: null }),
  };
  return { session, emit: (event: unknown) => listener?.(event), counts: () => ({ subscriptions, unsubscriptions }) };
}

test("tool progress keeps only the latest update per call for 150 ms and a terminal event supersedes it", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { channel, frames } = channelFixture();
  const { session, emit } = sessionFixture();
  attachAgentEventStream(channel, { sessionId: "policy", sessionPromise: Promise.resolve(session) });
  await Promise.resolve();
  frames.length = 0;
  emit({ type: "tool_execution_update", toolCallId: "a", partialResult: "old" });
  emit({ type: "tool_execution_update", toolCallId: "a", partialResult: "latest" });
  emit({ type: "tool_execution_update", toolCallId: "b", partialResult: "obsolete" });
  emit({ type: "tool_execution_end", toolCallId: "b" });
  t.mock.timers.tick(149);
  assert.equal(frames.length, 1);
  assert.deepEqual(payloadOf(frames[0]), { type: "tool_execution_end", toolCallId: "b" });
  t.mock.timers.tick(1);
  assert.equal(frames.length, 2);
  assert.deepEqual(payloadOf(frames[1]), { type: "tool_execution_update", toolCallId: "a", partialResult: "latest" });
  channel.close();
});

test("agent heartbeat remains JSON at 30 seconds and cleanup stops timers/unsubscribes once", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { channel, frames } = channelFixture();
  const { session, counts } = sessionFixture();
  attachAgentEventStream(channel, { sessionId: "policy", sessionPromise: Promise.resolve(session) });
  await Promise.resolve();
  frames.length = 0;
  t.mock.timers.tick(29_999);
  assert.deepEqual(frames, []);
  t.mock.timers.tick(1);
  assert.deepEqual(frames.map(payloadOf), [{ type: "heartbeat" }]);
  channel.close();
  channel.close();
  t.mock.timers.tick(60_000);
  assert.equal(frames.length, 1);
  assert.deepEqual(counts(), { subscriptions: 1, unsubscriptions: 1 });
});

test("disconnect before startup resolution never subscribes or publishes on the late session", async () => {
  const { channel, frames } = channelFixture();
  const { session, counts } = sessionFixture();
  let resolve!: (session: EventStreamSession | null) => void;
  const sessionPromise = new Promise<EventStreamSession | null>(accept => { resolve = accept; });
  attachAgentEventStream(channel, { sessionId: "policy", sessionPromise });
  channel.close();
  resolve(session);
  await Promise.resolve();
  assert.deepEqual(frames, []);
  assert.deepEqual(counts(), { subscriptions: 0, unsubscriptions: 0 });
});

test("disconnect before startup rejection does not emit a late startup error", async () => {
  const { channel, frames } = channelFixture();
  let reject!: (error: Error) => void;
  const sessionPromise = new Promise<EventStreamSession | null>((_resolve, fail) => { reject = fail; });
  attachAgentEventStream(channel, { sessionId: "policy", sessionPromise });
  channel.close();
  reject(new Error("late startup failure"));
  await Promise.resolve();
  assert.deepEqual(frames, []);
});

test("shutdown delivered synchronously by subscribe releases the late unsubscribe once", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { channel, frames } = channelFixture();
  const { session } = sessionFixture();
  let unsubscriptions = 0;
  session.subscribe = callback => {
    callback({ type: "session_shutdown" });
    return () => { unsubscriptions += 1; };
  };
  attachAgentEventStream(channel, { sessionId: "policy", sessionPromise: Promise.resolve(session) });
  await Promise.resolve();
  assert.equal(channel.closed, true);
  assert.equal(unsubscriptions, 1);
  t.mock.timers.tick(60_000);
  assert.deepEqual(frames, []);
});

test("synchronous subscribe events follow connected instead of preceding their initial state", async () => {
  const { channel, frames } = channelFixture();
  const { session } = sessionFixture();
  session.subscribe = callback => {
    callback({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "prelude", contentIndex: 0 } });
    return () => {};
  };
  attachAgentEventStream(channel, { sessionId: "policy", sessionPromise: Promise.resolve(session) });
  await Promise.resolve();
  assert.deepEqual(payloadOf(frames[0]), { type: "connected", sessionId: "policy", isStreaming: false });
  assert.match(JSON.stringify(frames[1]), /prelude/);
  channel.close();
});

test("an oversized pre-announcement event closes and releases a synchronous subscription", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { channel, frames } = channelFixture();
  const { session } = sessionFixture();
  let unsubscriptions = 0;
  session.subscribe = callback => {
    callback({ type: "message_start", message: { content: "x".repeat(16 * 1024 * 1024) } });
    return () => { unsubscriptions += 1; };
  };
  attachAgentEventStream(channel, { sessionId: "policy", sessionPromise: Promise.resolve(session) });
  await Promise.resolve();
  assert.equal(channel.closed, true);
  assert.equal(unsubscriptions, 1);
  assert.deepEqual(frames, []);
});

test("attachment to an already-closed channel still observes rejected startup work", async () => {
  const { channel, frames } = channelFixture();
  channel.close();
  attachAgentEventStream(channel, { sessionId: "policy", sessionPromise: Promise.reject(new Error("late failure")) });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(frames, []);
});

test("a closed attach channel cannot leave a closed bridge registered or its healing timer alive", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { channel } = channelFixture();
  channel.close();
  try {
    const connection = attachBridge({ channel, metadata: { sessionId: "closed-attach", cwd: "/tmp/closed-attach" } });
    assert.equal(connection.closed, true);
    assert.equal(getBridge("closed-attach"), undefined);
    assert.equal(getSession("closed-attach"), undefined);
    t.mock.timers.tick(60_000);
    assert.equal(getSession("closed-attach"), undefined);
  } finally {
    clearSessionsForTests();
  }
});

test("eight streams on one session share a single per-second UI replay", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let syncs = 0;
  registerSessionBusForTests("policy-shared", {
    on: () => () => {},
    emit: channel => { if (channel === WEB_PLUGIN_UI_SYNC_EVENT) syncs += 1; },
  });
  const channels = Array.from({ length: 8 }, () => channelFixture());
  const { session } = sessionFixture();
  session.isStreaming = () => true;
  try {
    for (const { channel } of channels) {
      attachAgentEventStream(channel, { sessionId: "policy-shared", sessionPromise: Promise.resolve(session) });
      await Promise.resolve();
    }
    t.mock.timers.tick(5_000);
    assert.equal(syncs, 5, "subscribers must not multiply the replay");
    for (const { channel } of channels) channel.close();
    t.mock.timers.tick(5_000);
    assert.equal(syncs, 5, "the last stream releases the shared timer");
  } finally {
    for (const { channel } of channels) channel.close();
    clearPluginSessionState();
  }
});

test("coalescing does not retain a progress frame larger than the entire stream byte budget", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { channel } = channelFixture();
  const { session, emit, counts } = sessionFixture();
  attachAgentEventStream(channel, { sessionId: "policy", sessionPromise: Promise.resolve(session) });
  await Promise.resolve();
  emit({ type: "tool_execution_update", toolCallId: "large", partialResult: "x".repeat(16 * 1024 * 1024) });
  assert.equal(channel.closed, true);
  assert.equal(counts().unsubscriptions, 1);
});
