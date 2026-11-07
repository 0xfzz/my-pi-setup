import test from "node:test";
import assert from "node:assert/strict";

import { AuditLog } from "../lib/web-plugins/kernel/audit.ts";
import { CapabilityError } from "../lib/web-plugins/kernel/capabilities.ts";
import type { DiscoveredPlugin } from "../lib/web-plugins/kernel/discovery.ts";
import { validateManifest } from "../lib/web-plugins/kernel/manifest.ts";
import { PluginManager, type PluginContext, type PluginLoader, type PluginRuntime } from "../lib/web-plugins/kernel/manager.ts";
import { defaultState, type WebPluginsState } from "../lib/web-plugins/kernel/state.ts";

type Behaviour = Partial<PluginRuntime> & { loadError?: string };

interface Harness {
  calls: string[];
  behaviour: Map<string, Behaviour>;
  loader: PluginLoader;
  persisted: WebPluginsState[];
}

function candidate(id: string, opts: { version?: string; dependsOn?: Record<string, string>; capabilities?: string[]; source?: DiscoveredPlugin["source"] } = {}): DiscoveredPlugin {
  const result = validateManifest({
    id,
    name: id,
    version: opts.version ?? "1.0.0",
    engines: { piWeb: "^1.0.0", sdk: "^1.0.0" },
    dependsOn: opts.dependsOn ?? {},
    capabilities: opts.capabilities ?? [],
  });
  if (!result.ok) throw new Error(result.error);
  return { id, source: opts.source ?? "repo", dir: `/plugins/${id}`, manifest: result.manifest };
}

function harness(): Harness {
  const calls: string[] = [];
  const behaviour = new Map<string, Behaviour>();
  const loader: PluginLoader = (plugin) => {
    const b = behaviour.get(plugin.id) ?? {};
    if (b.loadError) {
      calls.push(`${plugin.id}:load-error`);
      throw new Error(b.loadError);
    }
    calls.push(`${plugin.id}:load`);
    return {
      setup: (ctx: PluginContext) => {
        calls.push(`${plugin.id}:setup`);
        b.setup?.(ctx);
      },
      activate: async (ctx: PluginContext) => {
        calls.push(`${plugin.id}:activate`);
        await b.activate?.(ctx);
      },
      deactivate: async (ctx: PluginContext) => {
        calls.push(`${plugin.id}:deactivate`);
        await b.deactivate?.(ctx);
      },
    };
  };
  return { calls, behaviour, loader, persisted: [] };
}

function manager(h: Harness, plugins: DiscoveredPlugin[], options: { state?: WebPluginsState; env?: Record<string, string>; activateMs?: number; threshold?: number; now?: () => number } = {}) {
  const audit = new AuditLog();
  const mgr = new PluginManager({
    plugins,
    state: options.state ?? defaultState(),
    loader: h.loader,
    env: options.env ?? {},
    now: options.now,
    budgets: { activateMs: options.activateMs ?? 500, deactivateMs: 200 },
    breaker: { threshold: options.threshold ?? 3, windowMs: 60_000 },
    persist: (s) => h.persisted.push(structuredClone(s)),
    audit,
  });
  return { mgr, audit };
}

/** Operator state with the given plugins already enabled (as a previous session would leave them). */
function enabledState(...ids: string[]): WebPluginsState {
  const plugins: WebPluginsState["plugins"] = {};
  for (const id of ids) plugins[id] = { enabled: true, grants: [] };
  return { ...defaultState(), plugins };
}

test("AC1: setup and activate run dependency-first; deactivate runs dependents-first, then dispose LIFO", async () => {
  const h = harness();
  h.behaviour.set("core.messages", {
    setup: (ctx) => {
      ctx.register(() => h.calls.push("core.messages:dispose-1"));
      ctx.register(() => h.calls.push("core.messages:dispose-2"));
    },
  });
  const plugins = [candidate("acme.zen", { dependsOn: { "core.messages": "^1.0.0" } }), candidate("core.messages")];
  const { mgr } = manager(h, plugins, { state: enabledState("acme.zen", "core.messages") });
  const boot = await mgr.start();
  assert.deepEqual(boot.active, ["acme.zen", "core.messages"]);

  // Dependency first on activate.
  const activateOrder = h.calls.filter((c) => c.endsWith(":activate")).map((c) => c.split(":")[0]);
  assert.deepEqual(activateOrder, ["core.messages", "acme.zen"]);

  h.calls.length = 0;
  await mgr.shutdown();
  assert.deepEqual(h.calls, [
    "acme.zen:deactivate",
    "core.messages:deactivate",
    "core.messages:dispose-2",
    "core.messages:dispose-1",
  ]);
  assert.deepEqual(mgr.snapshot().map((s) => s.state), ["disposed", "disposed"]);
});

test("a dependency cycle leaves both plugins unresolved, named in the snapshot, and neither runs", async () => {
  const h = harness();
  const plugins = [
    candidate("acme.a", { dependsOn: { "acme.b": "^1.0.0" } }),
    candidate("acme.b", { dependsOn: { "acme.a": "^1.0.0" } }),
  ];
  const { mgr } = manager(h, plugins, { state: enabledState("acme.a", "acme.b") });
  const boot = await mgr.start();
  assert.deepEqual(boot.active, []);
  assert.deepEqual(h.calls, []);
  const a = mgr.snapshot().find((s) => s.id === "acme.a")!;
  assert.equal(a.state, "unresolved");
  assert.match(a.lastError ?? "", /dependency cycle/);
});

test("AC4: a plugin that throws in activate three times is quarantined; others keep running", async () => {
  const h = harness();
  h.behaviour.set("acme.flaky", { activate: () => { throw new Error("boom"); } });
  const plugins = [candidate("acme.flaky"), candidate("acme.steady")];
  const { mgr, audit } = manager(h, plugins, { state: enabledState("acme.flaky", "acme.steady") });
  const boot = await mgr.start();
  assert.deepEqual(boot.active, ["acme.steady"]);
  assert.equal(mgr.snapshot().find((s) => s.id === "acme.flaky")!.state, "failed");

  // The boot start was failure 1, so the first retry is failure 2 and the second trips the breaker.
  const second = await mgr.enable("acme.flaky");
  assert.equal(second.ok, false);
  assert.equal(second.state, "failed");
  const third = await mgr.enable("acme.flaky");
  assert.equal(third.state, "quarantined");
  assert.match(third.ok ? "" : third.error, /3 failures within 60s/);

  assert.deepEqual(mgr.activeIds(), ["acme.steady"], "core/other plugins stay up");
  assert.equal(audit.list({ pluginId: "acme.flaky", kind: "quarantined" }).length, 1);

  // A quarantined plugin refuses to run until cleared.
  assert.equal((await mgr.enable("acme.flaky")).ok, false);

  h.behaviour.set("acme.flaky", {});
  const cleared = await mgr.clearQuarantine("acme.flaky");
  assert.equal(cleared.ok, true);
  assert.equal(cleared.state, "active");
  assert.deepEqual(mgr.activeIds().sort(), ["acme.flaky", "acme.steady"]);
});

test("a quarantine persists across restarts until cleared, and clears itself when the version changes", async () => {
  const h = harness();
  h.behaviour.set("acme.flaky", { activate: () => { throw new Error("boom"); } });
  // Starts are a minute apart so the crash-loop guard does not trip; that guard has its own test.
  let now = 0;
  const clock = () => now;
  const { mgr } = manager(h, [candidate("acme.flaky", { version: "1.0.0" })], { state: enabledState("acme.flaky"), threshold: 1, now: clock });
  await mgr.start();
  assert.equal(mgr.snapshot()[0].state, "quarantined", "a threshold of one trips on the boot failure");
  const stored = h.persisted.at(-1)!;
  assert.equal(stored.plugins["acme.flaky"].quarantine?.version, "1.0.0");

  now += 120_000;
  const restart = manager(harness(), [candidate("acme.flaky", { version: "1.0.0" })], { state: stored, now: clock });
  await restart.mgr.start();
  assert.equal(restart.mgr.snapshot()[0].state, "quarantined");

  now += 120_000;
  const upgraded = manager(harness(), [candidate("acme.flaky", { version: "1.0.1" })], { state: stored, now: clock });
  await upgraded.mgr.start();
  assert.equal(upgraded.mgr.snapshot()[0].state, "active");
  assert.equal(upgraded.audit.list({ kind: "quarantine-cleared" }).length, 1);
});

test("AC12: safe mode starts only core plugins; the manager can still re-enable one", async () => {
  const h = harness();
  const plugins = [candidate("core.chat"), candidate("acme.extra")];
  const state = enabledState("core.chat", "acme.extra");
  const { mgr, audit } = manager(h, plugins, { state, env: { PI_WEB_SAFE_MODE: "1" } });
  const boot = await mgr.start();
  assert.equal(boot.safeMode, true);
  assert.deepEqual(boot.active, ["core.chat"]);
  assert.equal(mgr.snapshot().find((s) => s.id === "acme.extra")!.waiting, "safe mode: only core plugins start automatically");
  assert.equal(audit.list({ kind: "safe-mode" }).length, 1);

  const reenabled = await mgr.enable("acme.extra");
  assert.equal(reenabled.ok, true);
  assert.deepEqual(mgr.activeIds().sort(), ["acme.extra", "core.chat"]);
});

test("the crash-loop trigger boots in safe mode after two starts within a minute", async () => {
  const h = harness();
  let now = 1_000_000;
  const plugins = [candidate("core.chat"), candidate("acme.extra")];
  const first = new PluginManager({ plugins, state: enabledState("core.chat", "acme.extra"), loader: h.loader, now: () => now });
  await first.start();
  now += 5_000;
  const second = new PluginManager({ plugins, state: first.operatorState, loader: h.loader, now: () => now });
  const boot = await second.start();
  assert.equal(boot.safeMode, true);
  assert.deepEqual(boot.active, ["core.chat"]);
});

test("a plugin left mid-activation by a crash is reported and not auto-started", async () => {
  const h = harness();
  const state: WebPluginsState = { ...enabledState("acme.crashy"), activating: ["acme.crashy"] };
  const { mgr } = manager(h, [candidate("acme.crashy")], { state });
  const boot = await mgr.start();
  assert.deepEqual(boot.crashed, ["acme.crashy"]);
  assert.deepEqual(boot.active, []);
  assert.match(mgr.snapshot()[0].waiting ?? "", /crashed while activating/);
  assert.equal((await mgr.enable("acme.crashy")).ok, true);
});

test("disabling a required dependency deactivates its running dependents first", async () => {
  const h = harness();
  const plugins = [candidate("core.messages"), candidate("acme.zen", { dependsOn: { "core.messages": "^1.0.0" } })];
  const { mgr } = manager(h, plugins, { state: enabledState("core.messages", "acme.zen") });
  await mgr.start();
  h.calls.length = 0;
  const result = await mgr.disable("core.messages");
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls, ["acme.zen:deactivate", "core.messages:deactivate"]);
  const [zen, messages] = mgr.snapshot();
  assert.equal(zen.state, "disposed", "the dependent is stopped but stays enabled");
  assert.equal(zen.waiting, 'waiting for dependency "core.messages"');
  assert.equal(messages.state, "disabled");
});

test("a dependent waits instead of activating when its dependency is not running", async () => {
  const h = harness();
  h.behaviour.set("core.messages", { activate: () => { throw new Error("nope"); } });
  const plugins = [candidate("core.messages"), candidate("acme.zen", { dependsOn: { "core.messages": "^1.0.0" } })];
  const { mgr } = manager(h, plugins, { state: enabledState("core.messages", "acme.zen"), threshold: 9 });
  const boot = await mgr.start();
  assert.deepEqual(boot.active, []);
  assert.equal(h.calls.includes("acme.zen:load"), false);
  assert.equal(mgr.snapshot().find((s) => s.id === "acme.zen")!.waiting, 'waiting for dependency "core.messages"');
});

test("reload rolls back to the last working runtime when the new one fails to activate", async () => {
  const h = harness();
  const { mgr } = manager(h, [candidate("acme.zen")], { state: enabledState("acme.zen"), threshold: 9 });
  await mgr.start();
  assert.equal(mgr.snapshot()[0].state, "active");

  h.behaviour.set("acme.zen", { activate: () => { throw new Error("v2 is broken"); } });
  h.calls.length = 0;
  const reloaded = await mgr.reload("acme.zen");
  assert.equal(reloaded.ok, false);
  assert.equal(reloaded.rolledBack, true);
  assert.match(reloaded.error, /previous version restored/);
  assert.equal(mgr.snapshot()[0].state, "active", "the previous runtime is running again");
  assert.ok(h.calls.includes("acme.zen:deactivate"));
});

test("reload with a fresh working runtime swaps it in", async () => {
  const h = harness();
  const { mgr } = manager(h, [candidate("acme.zen")], { state: enabledState("acme.zen") });
  await mgr.start();
  h.calls.length = 0;
  const reloaded = await mgr.reload("acme.zen");
  assert.deepEqual(reloaded, { ok: true, state: "active", rolledBack: false });
  assert.deepEqual(h.calls, ["acme.zen:deactivate", "acme.zen:load", "acme.zen:setup", "acme.zen:activate"]);
});

test("a hanging activate times out within its budget and is rolled back, not left running", async () => {
  const h = harness();
  let registered = false;
  h.behaviour.set("acme.hang", {
    setup: (ctx) => {
      ctx.register(() => {
        registered = true;
      });
    },
    activate: () => new Promise(() => undefined),
  });
  const { mgr } = manager(h, [candidate("acme.hang")], { state: enabledState("acme.hang"), activateMs: 20, threshold: 9 });
  const boot = await mgr.start();
  assert.deepEqual(boot.active, []);
  assert.match(mgr.snapshot()[0].lastError ?? "", /acme\.hang activate exceeded its 20 ms budget/);
  assert.equal(registered, true, "registrations made before the timeout are disposed");
});

test("capabilities: auto grants apply, exec stays pending, and an ungranted assert is denied and audited", async () => {
  const h = harness();
  h.behaviour.set("acme.zen", {
    activate: (ctx) => {
      ctx.assert("routes");
      ctx.assert("exec");
    },
  });
  const { mgr, audit } = manager(h, [candidate("acme.zen", { capabilities: ["routes", "exec"] })], { state: enabledState("acme.zen"), threshold: 9 });
  await mgr.start();
  const status = mgr.snapshot()[0];
  assert.deepEqual(status.grants, ["routes"]);
  assert.deepEqual(status.pending, ["exec"]);
  assert.equal(status.state, "failed");
  assert.equal(audit.list({ kind: "capability-denied" })[0].detail, "exec");
});

test("CapabilityError is thrown to the plugin for an undeclared capability, naming plugin and capability", async () => {
  const h = harness();
  let caught: unknown;
  h.behaviour.set("acme.zen", {
    activate: (ctx) => {
      try {
        ctx.assert("session.write");
      } catch (error) {
        caught = error;
      }
    },
  });
  const { mgr } = manager(h, [candidate("acme.zen")], { state: enabledState("acme.zen") });
  await mgr.start();
  assert.ok(caught instanceof CapabilityError);
  assert.equal((caught as CapabilityError).plugin, "acme.zen");
  assert.equal((caught as CapabilityError).capability, "session.write");
});

test("every change to operator state is persisted, and disable turns the plugin off across restart", async () => {
  const h = harness();
  const { mgr } = manager(h, [candidate("acme.zen")], { state: enabledState("acme.zen") });
  await mgr.start();
  await mgr.disable("acme.zen");
  const stored = h.persisted.at(-1)!;
  assert.equal(stored.plugins["acme.zen"].enabled, false);
  const restart = manager(harness(), [candidate("acme.zen")], { state: stored });
  const boot = await restart.mgr.start();
  assert.deepEqual(boot.active, []);
  assert.equal(restart.mgr.snapshot()[0].state, "resolved");
});

test("unknown plugin ids are refused, not created", async () => {
  const h = harness();
  const { mgr } = manager(h, [candidate("acme.zen")], {});
  await mgr.start();
  const result = await mgr.enable("acme.ghost");
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /unknown plugin "acme\.ghost"/);
});
