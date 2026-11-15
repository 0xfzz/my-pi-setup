// Hot-pluggable code must not leave anything running behind it. These tests pin
// the three ways a plugin's OS resources used to outlive the plugin: a child
// process nobody killed, a timer nobody cleared, and a cleanup that was fired
// and forgotten instead of awaited.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog } from "../web/core/plugin-contracts/kernel/audit.ts";
import { CapabilityError } from "../web/core/plugin-contracts/kernel/capabilities.ts";
import type { DiscoveredPlugin } from "../web/core/plugin-contracts/kernel/discovery.ts";
import { validateManifest } from "../web/core/plugin-contracts/kernel/manifest.ts";
import { PluginManager, type PluginLoader, type PluginRuntime } from "../web/core/plugin-contracts/kernel/manager.ts";
import { createProcessRegistry, isPidAlive } from "../web/core/plugin-contracts/kernel/processes.ts";
import { defaultState, type WebPluginsState } from "../web/core/plugin-contracts/kernel/state.ts";

const HOLD = "setInterval(() => {}, 1_000)";

function candidate(id: string, capabilities: string[] = ["exec"], source: DiscoveredPlugin["source"] = "repo"): DiscoveredPlugin {
  const result = validateManifest({
    id,
    name: id,
    version: "1.0.0",
    engines: { piWeb: "^1.0.0", sdk: "^1.0.0" },
    trust: "trusted",
    main: { server: "./server.ts" },
    dependsOn: {},
    capabilities,
  });
  if (!result.ok) throw new Error(result.error);
  return { id, source, dir: `/plugins/${id}`, manifest: result.manifest };
}

/** Operator state with the plugin enabled and its sensitive grants given. */
function enabledState(id: string, grants: string[] = ["exec"]): WebPluginsState {
  return { ...defaultState(), plugins: { [id]: { enabled: true, grants } } };
}

interface Rig {
  mgr: PluginManager;
  audit: AuditLog;
  behaviour: Map<string, PluginRuntime>;
  dir: string;
  cleanup(): void;
}

function rig(plugins: readonly DiscoveredPlugin[], state: WebPluginsState, options: { activateMs?: number } = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "pi-plugin-resources-"));
  const audit = new AuditLog();
  const behaviour = new Map<string, PluginRuntime>();
  const loader: PluginLoader = (plugin) => behaviour.get(plugin.id) ?? {};
  const mgr = new PluginManager({
    plugins,
    state,
    loader,
    budgets: { activateMs: options.activateMs ?? 500, deactivateMs: 1_000 },
    audit,
    processes: createProcessRegistry({ pidFile: join(dir, "children.json"), graceMs: 200 }),
  });
  return {
    mgr,
    audit,
    behaviour,
    dir,
    cleanup: () => {
      void mgr.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function waitForExit(pid: number, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (isPidAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("a child spawned through ctx.resources dies when its plugin is disabled", async () => {
  const plugin = candidate("acme.spawner");
  const r = rig([plugin], enabledState("acme.spawner"));
  let pid: number | undefined;
  r.behaviour.set("acme.spawner", {
    activate: (ctx) => {
      const child = ctx.resources.spawn(process.execPath, ["-e", HOLD]);
      pid = child.pid;
    },
  });
  try {
    await r.mgr.start();
    assert.ok(pid !== undefined);
    assert.equal(isPidAlive(pid), true, "the child runs while the plugin is active");

    await r.mgr.disable("acme.spawner");
    await waitForExit(pid);
    assert.equal(isPidAlive(pid), false, "disabling the plugin must not leave the child running");
  } finally {
    r.cleanup();
  }
});

test("a child spawned during an activation that timed out is still released", async () => {
  const plugin = candidate("acme.slowspawn");
  const r = rig([plugin], enabledState("acme.slowspawn"), { activateMs: 50 });
  let pid: number | undefined;
  r.behaviour.set("acme.slowspawn", {
    activate: async (ctx) => {
      pid = ctx.resources.spawn(process.execPath, ["-e", HOLD]).pid;
      await sleep(400);
    },
  });
  try {
    await r.mgr.start();
    assert.ok(pid !== undefined);
    const state = r.mgr.snapshot().find((entry) => entry.id === "acme.slowspawn")?.state;
    assert.equal(state, "failed");
    await waitForExit(pid);
    assert.equal(isPidAlive(pid), false, "an abandoned activation must not keep its child alive");
  } finally {
    r.cleanup();
  }
});

test("reload kills the old runtime's child before the new runtime starts", async () => {
  const plugin = candidate("acme.reloader");
  const r = rig([plugin], enabledState("acme.reloader"));
  const pids: number[] = [];
  r.behaviour.set("acme.reloader", {
    activate: (ctx) => {
      pids.push(ctx.resources.spawn(process.execPath, ["-e", HOLD]).pid!);
    },
  });
  try {
    await r.mgr.start();
    assert.equal(pids.length, 1);
    const reloaded = await r.mgr.reload("acme.reloader");
    assert.equal(reloaded.ok, true);
    assert.equal(pids.length, 2);
    await waitForExit(pids[0]!);
    assert.equal(isPidAlive(pids[0]!), false, "the previous runtime's child must not survive the reload");
    assert.equal(isPidAlive(pids[1]!), true, "the new runtime owns its own child");
  } finally {
    r.cleanup();
  }
});

test("ctx.resources.spawn is refused without the exec grant, and the denial is audited", async () => {
  // A user-installed plugin: its sensitive grants stay pending until the operator
  // confirms them, unlike a repo plugin that runs in the host tree.
  const plugin = candidate("acme.nogrant", ["exec"], "user");
  // Enabled, but the operator never granted exec: it stays pending.
  const r = rig([plugin], enabledState("acme.nogrant", []));
  let refusal: unknown;
  r.behaviour.set("acme.nogrant", {
    activate: (ctx) => {
      try {
        ctx.resources.spawn(process.execPath, ["-e", HOLD]);
      } catch (error) {
        refusal = error;
      }
    },
  });
  try {
    await r.mgr.start();
    assert.ok(refusal instanceof CapabilityError, `expected CapabilityError, got ${String(refusal)}`);
    assert.equal(r.audit.list({ kind: "capability-denied" }).length, 1, "the denial must be audited");
  } finally {
    r.cleanup();
  }
});

test("an interval from ctx.resources stops ticking once the plugin deactivates", async () => {
  const plugin = candidate("acme.ticker");
  const r = rig([plugin], enabledState("acme.ticker"));
  let ticks = 0;
  r.behaviour.set("acme.ticker", {
    activate: (ctx) => {
      ctx.resources.interval(() => {
        ticks += 1;
      }, 20);
    },
  });
  try {
    await r.mgr.start();
    await sleep(90);
    const whileActive = ticks;
    assert.ok(whileActive > 0, "the interval runs while the plugin is active");

    await r.mgr.disable("acme.ticker");
    await sleep(90);
    assert.equal(ticks, whileActive, "a deactivated plugin's interval must be cleared");
  } finally {
    r.cleanup();
  }
});

test("deactivate waits for an async disposer instead of firing and forgetting", async () => {
  const plugin = candidate("acme.slowdispose");
  const r = rig([plugin], enabledState("acme.slowdispose"));
  const order: string[] = [];
  r.behaviour.set("acme.slowdispose", {
    activate: (ctx) => {
      ctx.register(async () => {
        await sleep(120);
        order.push("disposed");
      });
    },
  });
  try {
    await r.mgr.start();
    const started = Date.now();
    await r.mgr.disable("acme.slowdispose");
    assert.deepEqual(order, ["disposed"], "the async disposer must have completed before disable resolved");
    assert.ok(Date.now() - started >= 100, "disable must wait for it, not return early");
  } finally {
    r.cleanup();
  }
});

test("shutdown releases children of every plugin still running", async () => {
  const first = candidate("acme.one");
  const second = candidate("acme.two");
  const state: WebPluginsState = {
    ...defaultState(),
    plugins: { "acme.one": { enabled: true, grants: ["exec"] }, "acme.two": { enabled: true, grants: ["exec"] } },
  };
  const r = rig([first, second], state);
  const pids: number[] = [];
  for (const id of ["acme.one", "acme.two"]) {
    r.behaviour.set(id, {
      activate: (ctx) => {
        pids.push(ctx.resources.spawn(process.execPath, ["-e", HOLD]).pid!);
      },
    });
  }
  try {
    await r.mgr.start();
    assert.equal(pids.length, 2);
    await r.mgr.shutdown();
    for (const pid of pids) await waitForExit(pid);
    assert.deepEqual(pids.filter(isPidAlive), [], "shutdown must not leave a plugin's children behind");
  } finally {
    r.cleanup();
  }
});
