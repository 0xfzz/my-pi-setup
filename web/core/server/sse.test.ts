import test from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";
import type { ServerResponse } from "node:http";
import type { SsePressureLimits } from "../../../lib/sse-pressure.ts";
import { createWebApp } from "./app.ts";
import { openEventChannel, SSE_ROUTE_OPTIONS, type EventChannel } from "../http/sse.ts";

type ChannelFixture = { channel: EventChannel; raw: ServerResponse; response: Response };

async function withChannel(run: (fixture: ChannelFixture) => Promise<void>, limits?: SsePressureLimits): Promise<void> {
  const app = await createWebApp();
  let channel: EventChannel | undefined;
  let raw: ServerResponse | undefined;
  app.get("/stream", { sse: SSE_ROUTE_OPTIONS }, async (_request, reply) => {
    reply.header("cache-control", "no-cache, no-transform");
    raw = reply.raw;
    channel = openEventChannel(reply, limits);
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  try {
    // This resolves from flushed headers even when no data event exists yet.
    const response = await fetch(`http://127.0.0.1:${address.port}/stream`);
    assert.ok(channel && raw);
    await run({ channel, raw, response });
  } finally {
    await app.close();
  }
}

async function nextText(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(marker)) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, `stream ended before ${marker}`);
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

test("SSE flushes headers before data and carries security/cache headers", { timeout: 5_000 }, async () => {
  await withChannel(async ({ channel, response }) => {
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const reader = response.body!.getReader();
    channel.send({ type: "connected", text: "hello\n世界" });
    const text = await nextText(reader, "\n\n");
    assert.equal(text, 'data: {"type":"connected","text":"hello\\n世界"}\n\n');
    channel.close();
    assert.equal((await reader.read()).done, true);
  });
});

test("manual SSE routes accept missing, wildcard, EventSource and non-SSE Accept headers", { timeout: 5_000 }, async () => {
  const app = await createWebApp();
  app.get("/stream", { sse: SSE_ROUTE_OPTIONS }, async (_request, reply) => {
    const channel = openEventChannel(reply);
    channel.send({ type: "ready" });
    channel.close();
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  try {
    for (const accept of [undefined, "*/*", "text/event-stream", "application/json"]) {
      await new Promise<void>((resolve, reject) => {
        const request = get({ host: "127.0.0.1", port: address.port, path: "/stream", headers: accept ? { accept } : {} }, response => {
          assert.equal(response.statusCode, 200);
          response.resume();
          response.on("end", resolve);
          response.on("error", reject);
        });
        request.on("error", reject);
      });
    }
  } finally {
    await app.close();
  }
});

test("pressure accounting includes socket and formatter buffers, dropping only rebuildable frames", { timeout: 5_000 }, async () => {
  await withChannel(async ({ channel, response }) => {
    const frame = { type: "snapshot", payload: "界".repeat(40_000) };
    const bytes = Buffer.byteLength(JSON.stringify(frame)) + 8;
    channel.send(frame);
    assert.ok(channel.bufferedBytes >= bytes, "socket accounting uses UTF-8 bytes, not UTF-16 characters");
    const firstBytes = channel.bufferedBytes;
    channel.send(frame);
    assert.equal(channel.bufferedBytes, firstBytes + bytes, "paused formatter output counts too");
    channel.send({ type: "discard-me" }, { droppable: true });
    assert.equal(channel.bufferedBytes, firstBytes + bytes);
    channel.send({ type: "critical" });
    assert.ok(channel.bufferedBytes > firstBytes + bytes);
    const text = await nextText(response.body!.getReader(), "critical");
    assert.doesNotMatch(text, /discard-me/);
  }, { dropAboveBytes: 100, closeAboveBytes: 512 * 1024 });
});

test("an over-budget burst cuts an unread socket and releases pipe drain listeners exactly once", { timeout: 5_000 }, async () => {
  await withChannel(async ({ channel, raw, response }) => {
    let cleanups = 0;
    channel.onClose(() => { cleanups += 1; });
    // Leave the real response unread; do not fake writableLength or drain.
    const frame = { payload: "x".repeat(60_000) };
    for (let index = 0; index < 1_000 && !channel.closed; index += 1) {
      channel.send(frame);
      assert.ok(channel.bufferedBytes <= 256 * 1024);
    }
    assert.equal(channel.closed, true);
    assert.equal(raw.destroyed, true);
    assert.equal(cleanups, 1);
    assert.equal(raw.listenerCount("drain"), 0);
    channel.close();
    channel.send({ ignored: true });
    assert.equal(cleanups, 1);
    await response.body!.cancel().catch(() => {});
  }, { dropAboveBytes: 128 * 1024, closeAboveBytes: 256 * 1024 });
});

test("producer-reserved bytes share the drop/close budget with the formatter and socket", { timeout: 5_000 }, async () => {
  await withChannel(async ({ channel, response }) => {
    channel.send({ type: "droppable" }, { droppable: true, reservedBytes: 100 });
    assert.equal(channel.bufferedBytes, 0);
    channel.send({ type: "critical" }, { reservedBytes: 240 });
    assert.equal(channel.closed, true);
    await response.body!.cancel().catch(() => {});
  }, { dropAboveBytes: 50, closeAboveBytes: 256 });
});

test("a graceful close drains already-admitted frames before ending the response", { timeout: 5_000 }, async () => {
  await withChannel(async ({ channel, response }) => {
    channel.send({ first: "x".repeat(120_000) });
    channel.send({ last: "finish" });
    channel.close();
    const text = await response.text();
    assert.ok(text.indexOf('"first"') < text.indexOf('"last"'));
    assert.match(text, /data: \{"last":"finish"\}\n\n$/);
  });
});

test("a peer abort cancels a channel once and late cleanup registration runs immediately", { timeout: 5_000 }, async () => {
  await withChannel(async ({ channel, response }) => {
    const closed = new Promise<void>(resolve => channel.onClose(resolve));
    await response.body!.cancel();
    await closed;
    assert.equal(channel.closed, true);
    let cleanups = 0;
    channel.onClose(() => { cleanups += 1; });
    channel.close();
    assert.equal(cleanups, 1);
  });
});
