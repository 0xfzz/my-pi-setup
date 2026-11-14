import test from "node:test";
import assert from "node:assert/strict";

import { CapabilityError, type Capability } from "../web/core/plugin-contracts/kernel/capabilities.ts";
import { PluginUiRegistry, type PluginUiSink } from "../web/core/plugin-contracts/kernel/plugin-ui.ts";
import type { DiscoveredPlugin } from "../web/core/plugin-contracts/kernel/discovery.ts";
import { validateManifest } from "../web/core/plugin-contracts/kernel/manifest.ts";
import { PluginManager, type PluginLoader, type PluginRuntime } from "../web/core/plugin-contracts/kernel/manager.ts";
import { defaultState, setPluginState, type WebPluginsState } from "../web/core/plugin-contracts/kernel/state.ts";
import type { WebUiType } from "../web/core/plugin-contracts/ui-event-models.ts";

const grants = (...caps: string[]): Capability[] => caps.map((c) => {
  const i = c.indexOf(":");
  return i === -1 ? { kind: c as Capability["kind"] } : { kind: c.slice(0, i) as Capability["kind"], arg: c.slice(i + 1) };
});

interface Publish {
  sessionId: string;
  type: WebUiType;
  payload: unknown;
  sourceKey: string;
}

function recordingSink(): { sink: PluginUiSink; published: Publish[] } {
  const published: Publish[] = [];
  return {
    published,
    sink: {
      publish: (sessionId, type, payload, sourceKey) => {
        published.push({ sessionId, type, payload, sourceKey });
        return true;
      },
    },
  };
}

test("a plugin publishes its view under its own id, whatever the payload claims", () => {
  const { sink, published } = recordingSink();
  const ui = new PluginUiRegistry();
  ui.attach(sink);
  const owner = { pluginId: "acme.watch", grants: grants("ui.publish") };
  assert.equal(ui.publishView(owner, "s1", { type: "status", tone: "neutral", text: "ok" }), true);
  assert.equal(published.length, 1);
  assert.equal(published[0]?.sourceKey, "acme.watch");
  assert.deepEqual(published[0]?.payload, {
    pluginId: "acme.watch",
    view: { type: "status", tone: "neutral", text: "ok" },
  });
});

test("notify, status and widget each land on their own store type with the plugin as source", () => {
  const { sink, published } = recordingSink();
  const ui = new PluginUiRegistry();
  ui.attach(sink);
  const owner = { pluginId: "acme.watch", grants: grants("ui.publish") };

  assert.equal(ui.notify(owner, "s1", "indexed 4 files", "warning"), true);
  assert.equal(ui.setStatus(owner, "s1", "3 tools"), true);
  assert.equal(ui.setWidget(owner, "s1", ["a", "b"]), true);

  assert.deepEqual(published.map((entry) => entry.type), ["ui.notify", "ui.status.changed", "ui.widget.changed"]);
  assert.deepEqual(published[0]?.payload, { message: "indexed 4 files", level: "warning" });
  assert.deepEqual(published[1]?.payload, { key: "acme.watch", text: "3 tools" });
  assert.deepEqual(published[2]?.payload, { key: "acme.watch", lines: ["a", "b"], placement: "belowEditor" });
  assert.deepEqual(new Set(published.map((entry) => entry.sourceKey)), new Set(["acme.watch"]));
});

test("publishing needs the ui.publish grant, and a refusal names the capability", () => {
  const { sink, published } = recordingSink();
  const ui = new PluginUiRegistry();
  ui.attach(sink);
  assert.throws(
    () => ui.publishView({ pluginId: "acme.watch", grants: [] }, "s1", { type: "status", tone: "neutral", text: "x" }),
    CapabilityError,
  );
  assert.deepEqual(published, []);
});

test("without an attached store nothing is published, and no bookkeeping is kept", () => {
  const ui = new PluginUiRegistry();
  const owner = { pluginId: "acme.watch", grants: grants("ui.publish") };
  assert.equal(ui.setStatus(owner, "s1", "3 tools"), false);
  assert.equal(ui.removeOwner("acme.watch"), 0);
});

test("an empty session id is refused before it reaches the store", () => {
  const { sink, published } = recordingSink();
  const ui = new PluginUiRegistry();
  ui.attach(sink);
  assert.equal(ui.notify({ pluginId: "acme.watch", grants: grants("ui.publish") }, "", "hello"), false);
  assert.deepEqual(published, []);
});

test("deactivation tombstones the status and widget the plugin set, and forgets a cleared one", () => {
  const { sink, published } = recordingSink();
  const ui = new PluginUiRegistry();
  ui.attach(sink);
  const owner = { pluginId: "acme.watch", grants: grants("ui.publish") };

  ui.setStatus(owner, "s1", "3 tools");
  ui.setWidget(owner, "s1", ["a"]);
  ui.setStatus(owner, "s2", "other session");
  // Clearing a status is not something teardown must do again.
  ui.setStatus(owner, "s2", null);
  published.length = 0;

  assert.equal(ui.removeOwner("acme.watch"), 2);
  assert.deepEqual(published.map((entry) => [entry.sessionId, entry.type]), [
    ["s1", "ui.status.changed"],
    ["s1", "ui.widget.changed"],
  ]);
  assert.deepEqual(published[0]?.payload, { key: "acme.watch", text: null });
  assert.deepEqual(published[1]?.payload, { key: "acme.watch", lines: null, placement: "belowEditor" });
  assert.equal(ui.removeOwner("acme.watch"), 0, "bookkeeping is gone after the first removal");
});

test("a view leaves no tombstone: the host only serves a descriptor for a live plugin", () => {
  const { sink, published } = recordingSink();
  const ui = new PluginUiRegistry();
  ui.attach(sink);
  ui.publishView({ pluginId: "acme.watch", grants: grants("ui.publish") }, "s1", { type: "status", tone: "neutral", text: "x" });
  assert.equal(ui.removeOwner("acme.watch"), 0);
  assert.equal(published.length, 1, "only the original view publish");
});

test("a sink that throws during teardown does not fail the removal", () => {
  const ui = new PluginUiRegistry();
  let calls = 0;
  ui.attach({
    publish: () => {
      calls++;
      throw new Error("store gone");
    },
  });
  const owner = { pluginId: "acme.watch", grants: grants("ui.publish") };
  // The first publish throws before bookkeeping, so seed it through a working sink.
  ui.attach({
    publish: (_sessionId, type) => type !== "ui.status.changed",
  });
  ui.setWidget(owner, "s1", ["a"]);
  ui.attach({
    publish: () => {
      calls++;
      throw new Error("store gone");
    },
  });
  assert.doesNotThrow(() => ui.removeOwner("acme.watch"));
  assert.equal(calls, 1);
});

/**
 * An outside plugin whose sensitive capabilities the operator already
 * confirmed — the grant policy is settled elsewhere, these tests pin the seam.
 */
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

function confirmed(plugin: DiscoveredPlugin): WebPluginsState {
  const granted = plugin.manifest.capabilities.map((capability) =>
    capability.arg === undefined ? capability.kind : `${capability.kind}:${capability.arg}`);
  return setPluginState(defaultState(), plugin.id, { enabled: true, grants: granted });
}

test("a plugin's ctx.ui reaches the host sink while active and is tombstoned when disabled", async () => {
  const plugin = candidate("acme.panel", ["ui.publish"]);
  const { sink, published } = recordingSink();
  const ui = new PluginUiRegistry();
  ui.attach(sink);
  const loader: PluginLoader = (): PluginRuntime => ({
    activate: (ctx) => {
      ctx.ui.view("s1", { type: "status", tone: "accent", text: "live" });
      ctx.ui.status("s1", "2 tools");
    },
  });
  const manager = new PluginManager({ plugins: [plugin], state: confirmed(plugin), loader, ui });
  await manager.start();
  assert.deepEqual(published.map((entry) => entry.type), ["ui.view.changed", "ui.status.changed"]);

  await manager.disable("acme.panel");
  assert.equal(published.length, 3, "the status is tombstoned on deactivate");
  assert.deepEqual(published[2]?.payload, { key: "acme.panel", text: null });
});

test("a plugin without ui.publish fails activation instead of silently painting nothing", async () => {
  const plugin = candidate("acme.nosy", []);
  const loader: PluginLoader = (): PluginRuntime => ({
    activate: (ctx) => {
      ctx.ui.view("s1", { type: "status", tone: "accent", text: "live" });
    },
  });
  const manager = new PluginManager({ plugins: [plugin], state: confirmed(plugin), loader, ui: new PluginUiRegistry() });
  const report = await manager.start();
  assert.match(report.failed["acme.nosy"] ?? "", /lacks capability "ui\.publish"/);
});
