// Real sockets pin the new stream result and the sole legacy raw adapter.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { registerWebPlugins } from "./plugin-host.ts";
import { clearWebPluginStateForTests } from "../../plugins/fixture-e2e/server/fixtures.ts";
import { startWebServer } from "./main.ts";
import { WEB_PLUGINS } from "../../plugins/index.ts";
import type { PluginRouteHandler } from "../plugin-contracts/kernel/routes.ts";

const directory = await mkdtemp(join(tmpdir(), "pi-plugin-stream-"));
const previousState = process.env.PI_WEB_PLUGIN_STATE;
process.env.PI_WEB_PLUGIN_STATE = join(directory, "plugins.json");
const host = registerWebPlugins(WEB_PLUGINS);
await host.ready;
const server = await startWebServer({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${server.port}/api/p/todo/`;

test.after(async () => {
  await server.close();
  await host.shutdown();
  clearWebPluginStateForTests();
  if (previousState === undefined) delete process.env.PI_WEB_PLUGIN_STATE;
  else process.env.PI_WEB_PLUGIN_STATE = previousState;
  await rm(directory, { recursive: true, force: true });
});

function completion() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function withRoute(path: string, handler: PluginRouteHandler, check: (url: string) => Promise<void>): Promise<void> {
  const unregister = host.routes.register({ pluginId: "todo", grants: [{ kind: "routes" }] }, "GET", path, handler);
  try {
    await check(base + path);
  } finally {
    unregister();
  }
}

test("stream results preserve bytes, status, cache/security headers and release once", { timeout: 5_000 }, async () => {
  const released = completion();
  const bytes = Buffer.from([0, 1, 255, 128, 10]);
  let releases = 0;
  await withRoute("bytes", () => ({ stream: {
    status: 206,
    headers: { "content-type": "application/octet-stream", "cache-control": "private, no-store", "content-length": String(bytes.length) },
    stream: Readable.from([bytes]),
    close: () => { releases += 1; released.resolve(); },
  } }), async url => {
    const response = await fetch(url);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    await released.promise;
    assert.equal(releases, 1);
  });
});

test("a client abort destroys the returned source and releases its resources", { timeout: 5_000 }, async () => {
  const released = completion();
  const source = new Readable({ read() { this.push(Buffer.alloc(64 * 1024)); } });
  await withRoute("abort", () => ({ stream: { stream: source, close: released.resolve } }), async url => {
    const response = await fetch(url);
    const reader = response.body!.getReader();
    assert.equal((await reader.read()).done, false);
    await reader.cancel();
    await released.promise;
    assert.equal(source.destroyed, true);
  });
});

test("a source error after headers terminates the response and releases resources", { timeout: 5_000 }, async () => {
  const released = completion();
  const source = new Readable({ read() {} });
  source.push("first chunk");
  await withRoute("source-error", () => ({ stream: { stream: source, close: released.resolve } }), async url => {
    const response = await fetch(url);
    const reader = response.body!.getReader();
    await reader.read();
    source.destroy(new Error("fixture read failure"));
    await assert.rejects(reader.read());
    await released.promise;
  });
});

test("legacy plugins may write before returning handled without an extra response", { timeout: 5_000 }, async () => {
  await withRoute("legacy", async request => {
    const response = request.transport!.response as ServerResponse;
    response.writeHead(201, { "content-type": "text/plain", "x-legacy": "yes" });
    response.end("legacy bytes");
    await Promise.resolve();
    return { handled: true };
  }, async url => {
    const response = await fetch(url);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-legacy"), "yes");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await response.text(), "legacy bytes");
  });
});

test("a legacy throw after writing does not append a 502 or crash the host", { timeout: 5_000 }, async () => {
  await withRoute("legacy-throw", request => {
    const response = request.transport!.response as ServerResponse;
    response.writeHead(200);
    response.end("already sent");
    throw new Error("after write");
  }, async url => {
    const response = await fetch(url);
    assert.equal(await response.text(), "already sent");
    assert.equal((await fetch(base.replace(/\/api\/p\/todo\/$/, "/api/health"))).status, 200);
  });
});

test("a legacy client disconnect aborts its signal and closes the real response", { timeout: 5_000 }, async () => {
  const disconnected = completion();
  let raw: ServerResponse | undefined;
  await withRoute("legacy-disconnect", request => {
    raw = request.transport!.response as ServerResponse;
    request.signal!.addEventListener("abort", disconnected.resolve, { once: true });
    raw.writeHead(200, { "content-type": "text/plain" });
    raw.write("connected");
    return { handled: true };
  }, async url => {
    const response = await fetch(url);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await disconnected.promise;
    assert.equal(raw?.destroyed, true);
  });
});

test("a legacy timeout after partial writes terminates instead of double-sending", { timeout: 20_000 }, async () => {
  await withRoute("legacy-timeout", async request => {
    const response = request.transport!.response as ServerResponse;
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("partial");
    await new Promise<void>(resolve => request.signal!.addEventListener("abort", () => resolve(), { once: true }));
    return { handled: true };
  }, async url => {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    await assert.rejects(response.text());
    assert.equal((await fetch(base.replace(/\/api\/p\/todo\/$/, "/api/health"))).status, 200);
  });
});
