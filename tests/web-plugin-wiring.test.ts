import test from "node:test";
import assert from "node:assert/strict";

import { HookBus } from "../lib/web-plugins/kernel/hooks.ts";
import { ServiceRegistry } from "../lib/web-plugins/kernel/services.ts";
import { PluginStorage } from "../lib/web-plugins/kernel/storage.ts";
import type { DiscoveredPlugin } from "../lib/web-plugins/kernel/discovery.ts";
import { validateManifest } from "../lib/web-plugins/kernel/manifest.ts";
import { PluginManager, type PluginLoader, type PluginRuntime } from "../lib/web-plugins/kernel/manager.ts";
import { defaultState, setPluginState, type WebPluginsState } from "../lib/web-plugins/kernel/state.ts";

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

/** Shared host-level instances, exactly as the kernel host creates them. */
function shared() {
  const hooks = new HookBus();
  const services = new ServiceRegistry();
  const storage = new PluginStorage();
  return { hooks, services, storage };
}

test("a plugin's bail veto applies while it runs and stops when it is disabled", async () => {
  const s = shared();
  const loader: PluginLoader = (): PluginRuntime => ({
    activate: (ctx) => {
      ctx.hooks.bail("session.before-delete", (payload: unknown) =>
        (payload as { pinned?: boolean }).pinned ? { deny: "Pinned sessions can't be deleted." } : undefined);
    },
  });
  const manager = new PluginManager({
    plugins: [candidate("acme.guard", ["hooks.veto:session.before-delete"])],
    state: enabled("acme.guard"),
    loader,
    ...s,
  });
  await manager.start();
  assert.deepEqual(await s.hooks.bail("session.before-delete", { pinned: true }), {
    denied: true,
    reason: "Pinned sessions can't be deleted.",
    pluginId: "acme.guard",
  });

  await manager.disable("acme.guard");
  assert.deepEqual(await s.hooks.bail("session.before-delete", { pinned: true }), { denied: false });
});

test("a transform hook rewrites the value the host passes through, and only while the plugin runs", async () => {
  const s = shared();
  const loader: PluginLoader = (): PluginRuntime => ({
    activate: (ctx) => {
      ctx.hooks.waterfall("prompt.before-send", (prompt: unknown, info: unknown) =>
        (info as { project: string }).project.endsWith("/docs") ? `${prompt}\n\nAnswer in plain language.` : prompt);
    },
  });
  const manager = new PluginManager({
    plugins: [candidate("acme.docs", ["hooks.transform:prompt.before-send"])],
    state: enabled("acme.docs"),
    loader,
    ...s,
  });
  await manager.start();
  assert.equal(await s.hooks.waterfall("prompt.before-send", "hi", { project: "/work/docs" }), "hi\n\nAnswer in plain language.");
  assert.equal(await s.hooks.waterfall("prompt.before-send", "hi", { project: "/work/app" }), "hi");
});

test("a plugin's service replacement is what the host resolves, and the base returns when it is disabled", async () => {
  const s = shared();
  s.services.register({ pluginId: "core.chat", grants: [{ kind: "services.provide", arg: "service:title-generator" }] }, "title-generator", "provide", (text: string) => `base:${text}`);
  const loader: PluginLoader = (): PluginRuntime => ({
    activate: (ctx) => {
      ctx.services.replace("title-generator", (text: string) => `zen:${text}`);
    },
  });
  const manager = new PluginManager({
    plugins: [candidate("acme.titles", ["services.replace:service:title-generator"])],
    state: enabled("acme.titles"),
    loader,
    ...s,
  });
  await manager.start();
  assert.equal(s.services.resolve<(t: string) => string>("title-generator")!("x"), "zen:x");
  await manager.disable("acme.titles");
  assert.equal(s.services.resolve<(t: string) => string>("title-generator")!("x"), "base:x");
});

test("a plugin's storage survives deactivation but its hooks and services do not", async () => {
  const s = shared();
  const loader: PluginLoader = (): PluginRuntime => ({
    activate: async (ctx) => {
      await ctx.storage.update<number>("session", "turns", (n = 0) => n + 1);
      ctx.hooks.event("session.settled", () => undefined);
    },
  });
  const manager = new PluginManager({
    plugins: [candidate("acme.count", ["storage:session", "hooks.observe:session.settled"])],
    state: enabled("acme.count"),
    loader,
    ...s,
  });
  await manager.start();
  await manager.disable("acme.count");
  assert.equal(s.storage.forPlugin({ pluginId: "acme.count", grants: [{ kind: "storage", arg: "session" }] }).get("session", "turns"), 1);
  assert.deepEqual(s.hooks.handlersFor("session.settled"), []);
});

test("a hook that keeps throwing trips the breaker and the plugin is quarantined (PRD §6.5)", async () => {
  const s = shared();
  const loader: PluginLoader = (): PluginRuntime => ({
    activate: (ctx) => {
      ctx.hooks.waterfall("prompt.before-send", () => {
        throw new Error("bad transform");
      });
    },
  });
  const manager = new PluginManager({
    plugins: [candidate("acme.bad", ["hooks.transform:prompt.before-send"])],
    state: enabled("acme.bad"),
    loader,
    breaker: { threshold: 2, windowMs: 60_000 },
    ...s,
  });
  await manager.start();
  assert.equal(manager.snapshot()[0].state, "active");
  for (let i = 0; i < 2; i++) {
    assert.equal(await s.hooks.waterfall("prompt.before-send", "x", {}), "x", "the chain keeps the previous value");
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(manager.snapshot()[0].state, "quarantined");
  assert.deepEqual(s.hooks.handlersFor("prompt.before-send"), [], "a quarantined plugin's hooks are gone");
});
