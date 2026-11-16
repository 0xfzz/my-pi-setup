// Phase 0 feasibility spike for the Fastify migration
// (docs/prds/fastify-web-server.md). It does not touch the running server: it
// instantiates the pinned stack in isolation and proves the capabilities the
// later phases depend on, so a blocker is found here rather than mid-rewrite.
//
// Covered: native JSON body handling + limits, auth-before-parse ordering,
// live find-my-way add/remove while a listener is up, @fastify/sse framing and
// teardown/revocation, descriptor-safe range streaming with abort cleanup, and
// bounded close (plus port-0 and bind-failure).

import test from "node:test";
import assert from "node:assert/strict";
import { constants, createReadStream } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import Router from "find-my-way";
import ssePlugin from "@fastify/sse";

/** Reject when `promise` has not settled within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
    }),
  ]);
}

/** Read an SSE body until `predicate` matches, or fail after `timeoutMs`. */
async function readFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  timeoutMs = 5_000,
): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(buffer)) return buffer;
    const remaining = deadline - Date.now();
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), remaining);
      }),
    ]);
    if (chunk === null || chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
  }
  if (predicate(buffer)) return buffer;
  throw new Error(`timed out waiting for SSE frame; got ${JSON.stringify(buffer.slice(0, 400))}`);
}

// ── M5/M6: native body handling ────────────────────────────────────────────

test("fastify parses JSON, enforces bodyLimit, and a scoped parser can map an empty body to {}", async () => {
  const app = Fastify({ bodyLimit: 512 });
  // pi-web's general parser historically parsed JSON without consulting
  // Content-Type and answered {} for an empty body. Prove a scoped parser can
  // keep that contract while Fastify still owns accumulation and the cap.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = body as string;
    if (text === "") {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (error) {
      done(error as Error, undefined);
    }
  });
  app.post("/echo", async (request) => request.body ?? {});

  const ok = await app.inject({ method: "POST", url: "/echo", payload: { hello: "world" } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { hello: "world" });

  const empty = await app.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-type": "application/json" },
    payload: "",
  });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json(), {});

  const oversize = await app.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ blob: "x".repeat(2_000) }),
  });
  assert.equal(oversize.statusCode, 413);
  assert.match(oversize.json<{ code?: string }>().code ?? "", /BODY_TOO_LARGE/);

  await app.close();
});

// ── M2/M6: auth before parsing ─────────────────────────────────────────────

test("an onRequest hook answers before the body is parsed", async () => {
  const seen: string[] = [];
  const app = Fastify();
  app.addHook("onRequest", async (request, reply) => {
    if (request.headers["x-auth"] !== "ok") {
      await reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.post("/guarded", async (request) => {
    seen.push("handler");
    return request.body ?? {};
  });

  // Invalid JSON and no credential: the auth hook must win, proving it runs
  // before parsing. A parsed body would answer 400 instead.
  const unauthorized = await app.inject({
    method: "POST",
    url: "/guarded",
    headers: { "content-type": "application/json" },
    payload: "{not json",
  });
  assert.equal(unauthorized.statusCode, 401);

  const authorized = await app.inject({
    method: "POST",
    url: "/guarded",
    headers: { "content-type": "application/json", "x-auth": "ok" },
    payload: "{not json",
  });
  assert.equal(authorized.statusCode, 400);
  assert.deepEqual(seen, []);

  await app.close();
});

// ── M3: live dynamic matcher ───────────────────────────────────────────────

test("find-my-way supports live add/remove/find and allowed-method iteration", () => {
  const router = Router();
  const getHandler = (): string => "get";
  const postHandler = (): string => "post";
  router.on("GET", "/summary/:id", getHandler, { pluginId: "files" });
  router.on("POST", "/summary/:id", postHandler, { pluginId: "files" });

  const hit = router.find("GET", "/summary/abc");
  assert.ok(hit);
  assert.equal(hit.handler, getHandler);
  assert.equal(hit.params.id, "abc");
  assert.deepEqual(hit.store, { pluginId: "files" });

  // A path that exists for another method is detectable without matching
  // patterns by hand: iterate the candidate methods and probe concrete paths
  // with find(). (findRoute matches registered *patterns*, not concrete
  // paths, so it cannot answer this.)
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
  const allowed = methods.filter((method) => router.find(method, "/summary/abc") !== null);
  assert.deepEqual(allowed, ["GET", "POST"]);

  router.off("GET", "/summary/:id");
  assert.equal(router.find("GET", "/summary/abc"), null);
  assert.ok(router.find("POST", "/summary/abc"));

  assert.equal(router.find("GET", "/summary"), null);
});

// ── M10: SSE transport ─────────────────────────────────────────────────────

test("@fastify/sse manual route streams JSON data, keeps the connection open, and closes on demand", async () => {
  const app = Fastify();
  await app.register(ssePlugin, { heartbeatInterval: 0 });

  let closeStream: (() => void) | null = null;
  let closedCount = 0;

  app.get("/events", { sse: { kind: "manual", heartbeat: false } }, async (request, reply) => {
    reply.sse.keepAlive();
    reply.sse.onClose(() => {
      closedCount += 1;
    });
    await reply.sse.send({ data: { type: "connected", sessionId: "s1" } });
    closeStream = () => {
      reply.sse.close();
    };
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/events`;

  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.ok(res.body);
  const reader = res.body.getReader();
  const frames = await readFrames(reader, (text) => text.includes("\"type\":\"connected\""));
  // Byte-compatible with event-stream.ts: `data: <json>\n\n`.
  assert.match(frames, /data: \{"type":"connected","sessionId":"s1"\}\n\n/);

  // The connection is still open (keepAlive) — a revoke closes it without
  // touching the listener.
  assert.equal(closedCount, 0);
  assert.ok(closeStream !== null);
  (closeStream as () => void)();
  const after = await withTimeout(reader.read(), 2_000, "stream close after revoke");
  assert.equal(after.done, true);
  assert.equal(closedCount, 1);

  await withTimeout(app.close(), 3_000, "app.close after SSE");
});

// ── M12: descriptor-safe range transport ───────────────────────────────────

test("a descriptor-backed range reply returns 206 with exact bytes and destroys the source on abort", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fastify-spike-range-"));
  const bytes = Buffer.from("0123456789abcdef");
  const file = join(dir, "payload.bin");
  await writeFile(file, bytes);

  const app = Fastify();
  app.get("/download", async (_request, reply) => {
    // The application owns the descriptor: it validates the path, then opens
    // with O_NOFOLLOW and hands Fastify a stream over that fd. Fastify owns the
    // byte transport and the client-abort teardown.
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const size = (await handle.stat()).size;
    let handleClosed = false;
    const closeHandle = (): void => {
      if (handleClosed) return;
      handleClosed = true;
      void handle.close().catch(() => undefined);
    };
    const stream = createReadStream(file, { fd: handle.fd, start: 2, end: 5, autoClose: false });
    // With autoClose:false a normally-completed stream emits 'end' but never
    // 'close', so the response close event is the reliable cleanup trigger;
    // the stream 'close'/'error' covers the abort path.
    stream.on("close", closeHandle);
    reply.raw.on("close", closeHandle);
    reply
      .code(206)
      .header("content-type", "application/octet-stream")
      .header("content-range", `bytes 2-5/${size}`)
      .header("content-length", "4")
      .header("accept-ranges", "bytes");
    return reply.send(stream);
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/download`;

  const res = await fetch(url);
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 2-5/16");
  assert.equal(res.headers.get("content-length"), "4");
  assert.equal(await res.text(), "2345");
  await withTimeout(app.close(), 3_000, "app.close after range");

  // Abort mid-body: the client walks away after the first chunk; Fastify must
  // destroy the payload stream and close the raw response so the application's
  // descriptor cleanup runs.
  const big = join(dir, "big.bin");
  await writeFile(big, Buffer.alloc(4 * 1024 * 1024, 65));
  // forceCloseConnections mirrors the production plan: a client that aborts
  // mid-body must not keep close() waiting on a half-open socket.
  const app2 = Fastify({ forceCloseConnections: true });
  const abort = { handlerRan: false, streamClosed: false, rawClosed: false };
  app2.get("/big", async (_request, reply) => {
    abort.handlerRan = true;
    const handle = await open(big, constants.O_RDONLY | constants.O_NOFOLLOW);
    let handleClosed = false;
    const closeHandle = (): void => {
      if (handleClosed) return;
      handleClosed = true;
      void handle.close().catch(() => undefined);
    };
    const stream = createReadStream(big, { fd: handle.fd, autoClose: false });
    stream.on("close", () => {
      abort.streamClosed = true;
      closeHandle();
    });
    reply.raw.on("close", () => {
      abort.rawClosed = true;
      closeHandle();
    });
    return reply.type("application/octet-stream").send(stream);
  });
  await app2.listen({ port: 0, host: "127.0.0.1" });
  const address2 = app2.server.address();
  assert.ok(address2 && typeof address2 === "object");
  const controller = new AbortController();
  const inflight = fetch(`http://127.0.0.1:${address2.port}/big`, { signal: controller.signal });
  const streamed = await inflight;
  const body = streamed.body;
  assert.ok(body);
  const reader = body.getReader();
  await reader.read();
  controller.abort();
  await inflight.catch(() => undefined);
  const deadline = Date.now() + 2_000;
  while (!abort.streamClosed && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  assert.equal(abort.handlerRan, true);
  assert.equal(abort.rawClosed, true, "client abort must close the raw response");
  assert.equal(abort.streamClosed, true, "client abort must destroy the descriptor stream");
  await withTimeout(app2.close(), 3_000, "app2.close after abort");

  await rm(dir, { recursive: true, force: true });
});

// ── M1/M13: listener lifecycle ─────────────────────────────────────────────

test("port 0 yields an ephemeral port, a busy port rejects, and close is bounded with a live SSE client", async () => {
  const app = Fastify({ forceCloseConnections: true });
  await app.register(ssePlugin, { heartbeatInterval: 0 });
  app.get("/live", { sse: { kind: "manual", heartbeat: false } }, async (_request, reply) => {
    reply.sse.keepAlive();
    await reply.sse.send({ data: { type: "connected" } });
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  assert.ok(port > 0);

  const res = await fetch(`http://127.0.0.1:${port}/live`);
  const reader = res.body?.getReader();
  assert.ok(reader);
  await readFrames(reader, (text) => text.includes("connected"));

  // A second listener on the same port must reject rather than hang.
  const busy = Fastify();
  await assert.rejects(
    busy.listen({ port, host: "127.0.0.1" }),
    (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE",
  );

  // forceCloseConnections makes close() bounded even with an open SSE client;
  // repeated close is safe.
  await withTimeout(app.close(), 3_000, "bounded app.close");
  await withTimeout(app.close(), 3_000, "repeated app.close");
});

// Sanity: the http module is still usable for socket-level tests (the suites
// keep real listeners; nothing here replaces them).
test("node:http remains available for raw socket fixtures", async () => {
  const server = createServer((_req, res) => {
    res.end("ok");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const text = await (await fetch(`http://127.0.0.1:${address.port}/`)).text();
  assert.equal(text, "ok");
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});
