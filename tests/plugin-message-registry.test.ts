import test from "node:test";
import assert from "node:assert/strict";

import {
  createPluginMessageRegistry,
  resolveMessage,
  type PluginMessageDeclaration,
} from "@pi/web-bridge";
import { PluginManager } from "../web/core/plugin-contracts/kernel/manager.ts";
import { defaultState } from "../web/core/plugin-contracts/kernel/state.ts";
import type { DiscoveredPlugin } from "../web/core/plugin-contracts/kernel/discovery.ts";

const declaration: PluginMessageDeclaration = {
  name: "acme.plugin.state.changed",
  kind: "event",
  schema: { type: "object", required: ["text"], properties: { text: { type: "string" } }, additionalProperties: false },
};

test("registry registers owned names and derives capabilities", () => {
  const registry = createPluginMessageRegistry();
  const dispose = registry.register("acme.plugin", [
    declaration,
    { name: "acme.plugin.do.thing", kind: "command", schema: { type: "object" } },
  ]);
  assert.deepEqual(registry.names().map((entry) => entry.kind), ["event", "command"]);
  assert.deepEqual(registry.capabilities(), ["protocol.invoke:acme.plugin.do.thing", "ui.publish"]);
  assert.deepEqual(dispose(), undefined);
  assert.equal(registry.lookup(declaration.name), undefined);
});

test("registry refuses core, protected, foreign, duplicate and malformed declarations", () => {
  const registry = createPluginMessageRegistry();
  const dispose = registry.register("acme.plugin", [declaration]);
  try {
    assert.throws(() => registry.register("acme.plugin", [declaration]), /duplicate/);
    assert.throws(() => registry.register("acme.plugin", [
      { name: "session.list", kind: "event", schema: {} },
    ]), /core catalog/);
    assert.throws(() => registry.register("acme.plugin", [
      { name: "core.internal", kind: "event", schema: {} },
    ]), /protected prefix/);
    assert.throws(() => registry.register("other.plugin", [
      { name: "acme.plugin.other", kind: "event", schema: {} },
    ]), /outside namespace/);
    assert.throws(() => registry.register("acme.plugin", [
      { name: "acme.plugin.unsafe", kind: "event", schema: { $ref: "https://evil/schema" } },
    ]), /invalid plugin message declaration/);
    assert.throws(() => registry.register("core.plugin", []), /invalid plugin id/);
  } finally {
    dispose();
  }
});

test("payload validation enforces schema, depth and unsafe keys", () => {
  const registry = createPluginMessageRegistry();
  const dispose = registry.register("acme.plugin", [declaration]);
  assert.deepEqual(registry.validatePayload(declaration.name, { text: "hello" }).ok, true);
  assert.equal(registry.validatePayload(declaration.name, { text: 42 }).ok, false);
  assert.equal(registry.validatePayload(declaration.name, { text: "x", extra: true }).ok, false);
  assert.equal(registry.validatePayload(declaration.name, { text: "x", ["__proto__"]: {} }).ok, false);
  assert.equal(registry.validatePayload("acme.plugin.unknown", {}).ok, false);
  dispose();
});

test("resolveMessage keeps catalog names authoritative and adds registered names", () => {
  const registry = createPluginMessageRegistry();
  const dispose = registry.register("acme.plugin", [declaration]);
  assert.equal(resolveMessage("session.list", registry)?.kind, "query");
  assert.equal(resolveMessage(declaration.name, registry)?.capability, "ui.publish");
  assert.equal(resolveMessage("acme.plugin.unknown", registry), undefined);
  dispose();
});

test("manager registers manifest declarations on activation and unregisters on disable", async () => {
  const registry = createPluginMessageRegistry();
  const plugin: DiscoveredPlugin = {
    id: "acme.plugin",
    source: "repo",
    dir: "/tmp/acme.plugin",
    manifest: {
      id: "acme.plugin",
      name: "Acme",
      version: "1.0.0",
      engines: { piWeb: "^1.0.0", sdk: "^1.0.0" },
      main: {},
      trust: "declarative",
      capabilities: [],
      dependsOn: {},
      optionalDependsOn: {},
      activation: ["onStartup"],
      bridge: { extension: { messages: [declaration] } },
    },
  };
  const manager = new PluginManager({
    plugins: [plugin],
    state: defaultState(),
    loader: () => ({}),
    messages: registry,
    countStarts: false,
  });
  const report = await manager.start();
  assert.deepEqual(report.active, ["acme.plugin"]);
  assert.ok(registry.lookup(declaration.name) !== undefined);
  await manager.disable("acme.plugin");
  assert.equal(registry.lookup(declaration.name), undefined);
  await manager.shutdown();
});
