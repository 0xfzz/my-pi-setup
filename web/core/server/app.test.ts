// Phase 1 app-factory tests: the factory builds without listening, the
// lifecycle is bounded, and the security-header policy applies to native
// routes. Behaviour shared with the pre-existing dispatcher stays covered by
// main.test.ts while routes are migrated.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { createWebApp as buildWebApp, type WebAppOptions } from "./app.ts";
import { prepareLegacyPluginReply } from "./legacy-plugin-transport.ts";

// Raw fixture routes exercise lifecycle/early-refusal without retaining a
// catch-all dispatcher in the production factory.
async function createWebApp({ delegate, ...options }: WebAppOptions & {
  delegate: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
}) {
  const app = await buildWebApp(options);
  app.all("/*", async (request, reply) => {
    prepareLegacyPluginReply(reply);
    reply.hijack();
    await delegate(request.raw, reply.raw);
  });
  return app;
}

/** A raw fixture response used to exercise the app's lifecycle. */
function jsonDelegate(body: unknown) {
  return (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ path: request.url, body }));
    return Promise.resolve();
  };
}

async function startApp(delegate: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  const app = await createWebApp({ delegate });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  assert.ok(address !== null && typeof address === "object");
  return { app, port: address.port, baseUrl: `http://127.0.0.1:${address.port}` };
}

/** Reject when `promise` has not settled within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
    }),
  ]);
}

test("constructing the app does not listen", async () => {
  const app = await createWebApp({ delegate: jsonDelegate({}) });
  assert.equal(app.server.address(), null);
  await app.close();
});

test("listen on port 0 yields an ephemeral port and serves the delegated path", async () => {
  const { app, port, baseUrl } = await startApp(jsonDelegate({ ok: true }));
  try {
    assert.ok(port > 0);
    const res = await fetch(`${baseUrl}/api/anything`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { path: "/api/anything", body: { ok: true } });
  } finally {
    await app.close();
  }
});

test("app onClose releases resources after force-close has destroyed stream sockets", async () => {
  let socket: Socket | null = null;
  let cleanups = 0;
  const app = await buildWebApp({ onClose: () => {
    assert.ok(socket);
    assert.equal(socket.destroyed, true);
    cleanups += 1;
  } });
  app.get("/live", async (_request, reply) => {
    socket = reply.raw.socket;
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream" });
    reply.raw.write("data: ready\n\n");
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address !== null && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/live`);
    await response.body!.getReader().read();
    await withTimeout(app.close(), 3_000, "stream socket shutdown");
    assert.equal(cleanups, 1);
  } finally {
    await app.close();
  }
});

test("a busy port rejects listen and releases the app", async () => {
  const { app: first, port } = await startApp(jsonDelegate({}));
  const second = await createWebApp({ delegate: jsonDelegate({}) });
  await assert.rejects(
    second.listen({ port, host: "127.0.0.1" }),
    (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE",
  );
  await first.close();
  await second.close();
});

test("close is bounded with a live stream and repeated close is safe", async () => {
  // An SSE-style response that never ends: forceCloseConnections must tear it
  // down so close() cannot hang on the open socket.
  const delegate = (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" });
    response.write("data: {\"type\":\"heartbeat\"}\n\n");
    return new Promise(() => {});
  };
  const { app, baseUrl } = await startApp(delegate);

  const res = await fetch(`${baseUrl}/events`);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body?.getReader();
  assert.ok(reader);
  await reader.read();

  await withTimeout(app.close(), 3_000, "bounded close");
  await withTimeout(app.close(), 3_000, "repeated close");
});

test("the security-header policy applies to native routes", async () => {
  const app = await createWebApp({ delegate: jsonDelegate({}) });
  app.get("/native", async () => ({ ok: true }));
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  assert.ok(address !== null && typeof address === "object");
  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/native`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    // Helmet's defaults must not add a CSP, HSTS or COEP to a localhost server.
    assert.equal(res.headers.get("content-security-policy"), null);
    assert.equal(res.headers.get("strict-transport-security"), null);
  } finally {
    await app.close();
  }
});

test("a thrown native error is answered with a sanitized 500", async () => {
  const app = await createWebApp({ delegate: jsonDelegate({}) });
  app.get("/boom", async () => {
    throw new Error("secret detail that must not leak");
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  assert.ok(address !== null && typeof address === "object");
  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/boom`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "internal error" });
  } finally {
    await app.close();
  }
});

test("an oversize JSON body is a client 400 with the historical message, not a logged 500", async () => {
  const app = await createWebApp({ delegate: jsonDelegate({}) });
  // The root parser is a deliberate no-op; a scope that really parses JSON
  // with a tiny limit is what production routes do.
  await app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => done(null, body));
    scope.post("/small", { bodyLimit: 16 }, async () => ({ ok: true }));
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  assert.ok(address !== null && typeof address === "object");
  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/small`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(64) }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { error: "request body too large" });
  } finally {
    await app.close();
  }
});

test("an unclaimed path still reaches the delegate (no HTML shell for the API)", async () => {
  const app = await createWebApp({
    delegate: (_request, response) => {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "not found" }));
      return Promise.resolve();
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  assert.ok(address !== null && typeof address === "object");
  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/api/missing`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await res.json(), { error: "not found" });
  } finally {
    await app.close();
  }
});

test("a refusing gate answers before the body is parsed", async () => {
  const app = await createWebApp({
    delegate: jsonDelegate({}),
    authorize: (request, reply) => {
      if (request.url.startsWith("/api/guarded")) {
        void reply.code(401).send({ error: "unauthenticated" });
        return false;
      }
      return true;
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  assert.ok(address !== null && typeof address === "object");
  try {
    // Invalid JSON: a parsed body would answer 400, so 401 proves the gate ran
    // first. Helmet must also apply to early native gate replies.
    const res = await fetch(`http://127.0.0.1:${address.port}/api/guarded`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthenticated" });
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");

    const open = await fetch(`http://127.0.0.1:${address.port}/open`);
    assert.equal(open.status, 200);
  } finally {
    await app.close();
  }
});

test("node:http remains available for socket fixtures", async () => {
  const server = createServer((_req, res) => {
    res.end("ok");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  assert.equal(await (await fetch(`http://127.0.0.1:${address.port}/`)).text(), "ok");
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});
