// Plugin-owned backend routes: a plugin extends the API without a core edit.
// These tests pin the contract (namespace, capability gate, budget, teardown)
// and the HTTP dispatcher (/api/p/<pluginId>/…), including the failure answers
// a broken plugin must never turn into a server crash.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginRouteRegistry } from "../web/core/plugin-contracts/kernel/routes.ts";
import { PluginManager, type PluginLoader, type PluginRuntime } from "../web/core/plugin-contracts/kernel/manager.ts";
import { validateManifest } from "../web/core/plugin-contracts/kernel/manifest.ts";
import { defaultState, setPluginState, type WebPluginsState } from "../web/core/plugin-contracts/kernel/state.ts";
import type { DiscoveredPlugin } from "../web/core/plugin-contracts/kernel/discovery.ts";
import { parsePluginRoutePath } from "../web/core/server/plugin-routes.ts";

const owner = { pluginId: "acme.metrics", grants: [{ kind: "routes" } as const] };

function candidate(id: string, capabilities: string[]): DiscoveredPlugin {
  const result = validateManifest({
    id,
    name: id,
    version: "1.0.0",
    engines: { piWeb: "^1.0.0", sdk: "^1.0.0" },
    trust: "trusted",
    main: { server: "./server.ts" },
    capabilities,
  });
  if (!result.ok) throw new Error(result.error);
  return { id, source: "user", dir: `/plugins/${id}`, manifest: result.manifest };
}

function enabled(...ids: string[]): WebPluginsState {
  return ids.reduce((state, id) => setPluginState(state, id, { enabled: true }), defaultState());
}

test("a route is mounted in the plugin's own namespace and resolves with params", () => {
  const routes = new PluginRouteRegistry();
  routes.register(owner, "GET", "summary/:id", () => ({ body: { ok: true } }));

  const resolved = routes.resolve("acme.metrics", "GET", "summary/42");
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.deepEqual(resolved.params, { id: "42" });
  assert.deepEqual(routes.list(), [{ pluginId: "acme.metrics", method: "GET", path: "summary/:id" }]);
});

test("the mount root is the plugin id itself", () => {
  const routes = new PluginRouteRegistry();
  routes.register(owner, "GET", "", () => ({ body: "root" }));
  const resolved = routes.resolve("acme.metrics", "GET", "");
  assert.equal(resolved.ok, true);
  assert.deepEqual(routes.list()[0], { pluginId: "acme.metrics", method: "GET", path: "" });
});

test("an unknown path is 404 and a known path with the wrong method is 405", () => {
  const routes = new PluginRouteRegistry();
  routes.register(owner, "POST", "approve", () => ({ body: "ok" }));

  assert.deepEqual(routes.resolve("acme.metrics", "GET", "nope"), { ok: false, error: "not found" });
  assert.deepEqual(routes.resolve("acme.metrics", "GET", "approve"), { ok: false, error: "method not allowed" });
  assert.deepEqual(routes.resolve("acme.other", "POST", "approve"), { ok: false, error: "no routes registered" });
});

test("registration refuses a missing routes grant, a bad path, a bad method and a duplicate", () => {
  const routes = new PluginRouteRegistry();
  assert.throws(
    () => routes.register({ pluginId: "acme.nogrant", grants: [] }, "GET", "x", () => ({})),
    /lacks capability "routes"/,
  );
  assert.throws(() => routes.register(owner, "GET", "../escape", () => ({})), /invalid route path/);
  assert.throws(() => routes.register(owner, "GET", "a//b", () => ({})), /invalid route path/);
  assert.throws(() => routes.register(owner, "TRACE", "x", () => ({})), /unsupported route method/);
  assert.throws(() => routes.register(owner, "GET", ":1bad", () => ({})), /invalid route path/);

  routes.register(owner, "GET", "dup", () => ({}));
  assert.throws(() => routes.register(owner, "GET", "dup", () => ({})), /already registered/);
});

test("removeOwner drops every route a plugin mounted", () => {
  const routes = new PluginRouteRegistry();
  routes.register(owner, "GET", "a", () => ({}));
  routes.register(owner, "GET", "b", () => ({}));
  assert.equal(routes.hasRoutes("acme.metrics"), true);
  assert.equal(routes.removeOwner("acme.metrics"), 2);
  assert.equal(routes.hasRoutes("acme.metrics"), false);
});

test("a handler that throws or exceeds its budget becomes an error outcome, never a throw", async () => {
  const routes = new PluginRouteRegistry({ budgetMs: 20 });
  const request = { method: "GET" as const, path: "boom", params: {}, query: new URLSearchParams(), body: undefined };

  const thrown = await routes.invoke(() => {
    throw new Error("plugin exploded");
  }, request);
  assert.equal(thrown.ok, false);
  if (!thrown.ok) assert.match(thrown.message, /plugin exploded/);

  const slow = await routes.invoke(() => new Promise(() => undefined), request);
  assert.equal(slow.ok, false);
  if (!slow.ok) {
    assert.equal(slow.reason, "timeout");
    assert.match(slow.message, /budget/);
  }

  const fine = await routes.invoke(() => ({ status: 201, body: { ok: true } }), request);
  assert.deepEqual(fine, { ok: true, response: { status: 201, body: { ok: true } } });
});

test("a plugin's routes go live on activate and disappear on disable", async () => {
  const routes = new PluginRouteRegistry();
  const loader: PluginLoader = (): PluginRuntime => ({
    setup: (ctx) => {
      ctx.routes.get("summary", () => ({ body: { sessions: 3 } }));
    },
  });
  const manager = new PluginManager({
    plugins: [candidate("acme.metrics", ["routes"])],
    state: enabled("acme.metrics"),
    loader,
    routes,
  });
  await manager.start();
  assert.deepEqual(routes.list(), [{ pluginId: "acme.metrics", method: "GET", path: "summary" }]);

  await manager.disable("acme.metrics");
  assert.deepEqual(routes.list(), [], "a disabled plugin serves nothing");
});

test("a route registered without the routes capability fails activation", async () => {
  const routes = new PluginRouteRegistry();
  const loader: PluginLoader = (): PluginRuntime => ({
    setup: (ctx) => {
      ctx.routes.get("summary", () => ({ body: {} }));
    },
  });
  const manager = new PluginManager({
    plugins: [candidate("acme.sneaky", [])],
    state: enabled("acme.sneaky"),
    loader,
    routes,
    breaker: { threshold: 9, windowMs: 60_000 },
  });
  await manager.start();
  const status = manager.snapshot()[0];
  assert.equal(status.state, "failed");
  assert.match(status.lastError ?? "", /lacks capability "routes"/);
  assert.deepEqual(routes.list(), []);
});

test("parsePluginRoutePath splits the plugin id from its mount path", () => {
  assert.deepEqual(parsePluginRoutePath("/api/p/files/read"), { pluginId: "files", path: "read" });
  assert.deepEqual(parsePluginRoutePath("/api/p/files"), { pluginId: "files", path: "" });
  assert.deepEqual(parsePluginRoutePath("/api/p/acme.metrics/summary/42"), {
    pluginId: "acme.metrics",
    path: "summary/42",
  });
  assert.equal(parsePluginRoutePath("/api/plugins"), null);
  assert.equal(parsePluginRoutePath("/api/p/"), null);
  assert.equal(parsePluginRoutePath("/api/agent/x/files"), null);
});

// ── The HTTP surface: a plugin's own endpoint, served by the real server ───

test("a plugin route answers over HTTP with its body, status and headers", async () => {
  const { registerWebPlugins, clearWebPluginStateForTests } = await import("../web/core/server/plugin-host.ts");
  const { startWebServer } = await import("../web/core/server/main.ts");
  const { WEB_PLUGINS } = await import("../web/plugins/index.ts");
  const dir = mkdtempSync(join(tmpdir(), "pi-plugin-routes-"));
  process.env.PI_WEB_PLUGIN_STATE = join(dir, "plugins.json");
  const host = registerWebPlugins(WEB_PLUGINS);
  await host.ready;
  // Mount a fixture route on the booted host, as a plugin's setup would.
  const unregister = host.routes.register(
    { pluginId: "todo", grants: [{ kind: "routes" }] },
    "GET",
    "fixture/:id",
    (request) => ({
      status: 200,
      body: { id: request.params.id, q: request.query.get("q") },
      headers: { "X-Plugin": "todo" },
    }),
  );

  const server = await startWebServer({ port: 0, host: "127.0.0.1" });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/p/todo/fixture/7?q=hi`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-plugin"), "todo");
    assert.deepEqual(await res.json(), { id: "7", q: "hi" });

    const wrongMethod = await fetch(`http://127.0.0.1:${server.port}/api/p/todo/fixture/7`, { method: "POST" });
    assert.equal(wrongMethod.status, 405);

    const unknown = await fetch(`http://127.0.0.1:${server.port}/api/p/todo/nope`);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).pluginId, "todo");
  } finally {
    unregister();
    await server.close();
    await host.shutdown();
    delete process.env.PI_WEB_PLUGIN_STATE;
    clearWebPluginStateForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});
