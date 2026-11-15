// The plugin manager surface: the operator can see every plugin's kernel state
// and control it over HTTP. The failure mode being pinned: a quarantined or
// broken plugin had no reachable surface at all, so the only fix was editing
// ~/.pi/agent/web-plugins.json by hand.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startWebServer } from "../web/core/server/main.ts";
import { registerWebPlugins } from "../web/core/server/plugin-host.ts";
import { WEB_PLUGINS } from "../web/plugins/index.ts";
import { availableActions, groupBySource, safeModeBanner } from "../web/plugins/plugin-manager/lib/plugin-manager-api.ts";
import { KERNEL_MANAGER_ID, PLUGIN_MANAGER_ACTIONS } from "../web/core/shared/plugin-manager.ts";
import type { PluginManagerRow } from "../web/core/shared/plugin-manager.ts";
import type { PluginState } from "../web/core/plugin-contracts/kernel/lifecycle.ts";
import type { PluginSource } from "../web/core/plugin-contracts/kernel/discovery.ts";
import { PLUGIN_MANAGER_PLUGIN_ID } from "../web/plugins/plugin-manager/contract.ts";

const stateDir = mkdtempSync(join(tmpdir(), "pi-plugin-manager-"));
process.env.PI_WEB_PLUGIN_STATE = join(stateDir, "plugins.json");
const host = registerWebPlugins(WEB_PLUGINS);
await host.ready;

test.after(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = await startWebServer({ port: 0, host: "127.0.0.1" });
  try {
    await fn(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.close();
  }
}

test("the manager is a core plugin so safe mode can always reach it", () => {
  assert.equal(PLUGIN_MANAGER_PLUGIN_ID.startsWith("core."), true);
  assert.ok(WEB_PLUGINS.some((plugin) => plugin.id === PLUGIN_MANAGER_PLUGIN_ID));
});

test("GET /api/plugin-manager reports every plugin with state, grants and routes", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/plugin-manager`);
    assert.equal(res.status, 200);
    const report = (await res.json()) as {
      safeMode: boolean;
      warnings: string[];
      plugins: Array<{ id: string; title: string; state: string; routes: Array<{ method: string; path: string }> }>;
    };
    assert.equal(report.safeMode, false);
    assert.ok(Array.isArray(report.warnings));
    const ids = report.plugins.map((plugin) => plugin.id);
    for (const expected of ["todo", "modes", "files", PLUGIN_MANAGER_PLUGIN_ID]) {
      assert.ok(ids.includes(expected), `${expected} must be listed`);
    }
    const files = report.plugins.find((plugin) => plugin.id === "files");
    assert.equal(files?.state, "active");
    assert.ok(
      files?.routes.some((route) => route.method === "GET" && route.path === "download"),
      "the Files plugin's own backend routes are visible in the manager",
    );
    const todo = report.plugins.find((plugin) => plugin.id === "todo");
    assert.equal(todo?.title, "Todo");
  });
});

test("a disable/enable round trip over HTTP hides and restores the plugin", async () => {
  await withServer(async (baseUrl) => {
    const disabled = await fetch(`${baseUrl}/api/plugin-manager/todo/disable`, { method: "POST" });
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json()).state, "disabled");

    const list = (await (await fetch(`${baseUrl}/api/plugins`)).json()) as { plugins: Array<{ id: string }> };
    assert.equal(list.plugins.some((plugin) => plugin.id === "todo"), false, "a disabled plugin is not served");

    const enabled = await fetch(`${baseUrl}/api/plugin-manager/todo/enable`, { method: "POST" });
    assert.equal(enabled.status, 200);
    const after = (await (await fetch(`${baseUrl}/api/plugins`)).json()) as { plugins: Array<{ id: string }> };
    assert.ok(after.plugins.some((plugin) => plugin.id === "todo"));
  });
});

test("a capability grant over HTTP carries the capability and answers the kernel's verdict", async () => {
  await withServer(async (baseUrl) => {
    // `files` is a repo plugin, so it already holds what its manifest asks for:
    // `routes` is automatic and `exec` was never requested. Both are the
    // kernel's refusal to make, answered over HTTP with its own message.
    const unrequested = await fetch(`${baseUrl}/api/plugin-manager/files/grant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "exec" }),
    });
    assert.equal(unrequested.status, 409);
    assert.match(((await unrequested.json()) as { error: string }).error, /not requested by its manifest/);

    const automatic = await fetch(`${baseUrl}/api/plugin-manager/files/grant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "routes" }),
    });
    assert.equal(automatic.status, 409);
    assert.match(((await automatic.json()) as { error: string }).error, /granted automatically/);
  });
});

test("unknown plugins are 404 and unknown actions are 400", async () => {
  await withServer(async (baseUrl) => {
    const unknownPlugin = await fetch(`${baseUrl}/api/plugin-manager/never-heard/enable`, { method: "POST" });
    assert.equal(unknownPlugin.status, 404);

    const unknownAction = await fetch(`${baseUrl}/api/plugin-manager/todo/explode`, { method: "POST" });
    assert.equal(unknownAction.status, 400);
    assert.match((await unknownAction.json()).error, /unknown action/);

    const wrongMethod = await fetch(`${baseUrl}/api/plugin-manager/todo/enable`);
    assert.equal(wrongMethod.status, 405);
  });
});

test("clearing a quarantine on a healthy plugin is refused, not silently accepted", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/plugin-manager/modes/clear-quarantine`, { method: "POST" });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { ok: boolean; error?: string };
    assert.equal(body.ok, false);
    assert.match(body.error ?? "", /not quarantined/);
  });
});

function row(id: string, state: PluginState, source: PluginSource = "repo"): PluginManagerRow {
  return {
    id,
    title: id,
    source,
    version: "1.0.0",
    state,
    grants: [],
    pending: [],
    routes: [],
  };
}

test("clear-safe-mode is an operator action, and the banner only offers it in safe mode", async () => {
  assert.ok(PLUGIN_MANAGER_ACTIONS.includes("clear-safe-mode"));
  assert.equal(safeModeBanner({ safeMode: true }).visible, true);
  assert.equal(safeModeBanner({ safeMode: false }).visible, false);
  assert.equal(safeModeBanner({ safeMode: true }).label, "Leave safe mode");
  await withServer(async (baseUrl) => {
    // Not in safe mode here: the action is a no-op that still answers 200, so a
    // stale banner click cannot fail confusingly.
    const res = await fetch(`${baseUrl}/api/plugin-manager/${KERNEL_MANAGER_ID}/clear-safe-mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    const outcome = (await res.json()) as { ok: boolean };
    assert.equal(outcome.ok, true);
    const report = (await (await fetch(`${baseUrl}/api/plugin-manager`)).json()) as { safeMode: boolean };
    assert.equal(report.safeMode, false);
  });
});

test("availableActions follows the lifecycle state", () => {
  assert.deepEqual(availableActions("active"), ["disable", "reload"]);
  assert.deepEqual(availableActions("disabled"), ["enable"]);
  assert.deepEqual(availableActions("quarantined"), ["clear-quarantine", "disable"]);
  assert.deepEqual(availableActions("failed"), ["enable"]);
  assert.deepEqual(availableActions("unresolved"), []);
  assert.deepEqual(availableActions("rejected"), []);
  assert.deepEqual(availableActions("enabled"), ["enable"]);
});

test("groupBySource orders installed plugins before third-party ones", () => {
  const groups = groupBySource([
    row("acme.x", "active", "user"),
    row("todo", "active", "repo"),
    row("acme.y", "disabled", "user"),
  ]);
  assert.deepEqual(groups.map((group) => group.source), ["repo", "user"]);
  assert.deepEqual(groups[1].rows.map((entry) => entry.id), ["acme.x", "acme.y"]);
});
