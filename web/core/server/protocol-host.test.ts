import test from "node:test";
import assert from "node:assert/strict";
import { createPluginMessageRegistry } from "@pi-web/bridge";

import { catalogCapabilities, lookupMessage } from "../protocol/catalog.ts";
import { parseEnvelope, type BridgeEnvelope } from "../protocol/envelope.ts";
import { BRIDGE_PROTOCOL, BRIDGE_PROTOCOL_VERSION, HELLO } from "../protocol/version.ts";
import type { CapabilityAuditEntry } from "../protocol/bindings/types.ts";
import { createDirectoryProtocolHost } from "./protocol-host.ts";

function envelope(
  name: string,
  source: BridgeEnvelope["source"],
  payload: unknown = {},
  options: { kind?: BridgeEnvelope["kind"]; allowedNames?: readonly string[] } = {},
): BridgeEnvelope {
  const parsed = parseEnvelope({
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_PROTOCOL_VERSION,
    kind: options.kind ?? lookupMessage(name)?.kind ?? "command",
    name,
    messageId: `${source.id}-${name}`,
    source,
    timestamp: 0,
    payload,
  }, options.allowedNames);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.envelope;
}

function hello(clientId: string, source: BridgeEnvelope["source"]): BridgeEnvelope {
  return envelope(HELLO, source, {
    version: BRIDGE_PROTOCOL_VERSION,
    bindings: ["http-sse"],
    clientId,
    capabilities: [],
  });
}

test("the host allows declared messages and audits an undeclared one exactly once", async () => {
  const audits: CapabilityAuditEntry[] = [];
  const host = createDirectoryProtocolHost({
    cwd: "/tmp",
    grantedCapabilities: catalogCapabilities(),
    pluginGrants: catalogCapabilities(),
    bridgeSlices: new Map([["acme.plugin", ["session.list"]]]),
    onAudit: (entry) => { audits.push(entry); },
  });
  const source: BridgeEnvelope["source"] = { type: "plugin", id: "acme.plugin" };

  const handshaken = await host.handle(hello("acme.plugin", source));
  assert.equal(handshaken.ok, true);
  const allowed = await host.handle(envelope("session.list", source));
  assert.equal(allowed.ok, true);

  const denied = await host.handle(envelope("session.search", source));
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.error.code, "BRIDGE_MESSAGE_DENIED");
    assert.deepEqual(denied.error.details, { plugin: "acme.plugin", message: "session.search" });
  }
  assert.deepEqual(audits, [{
    source: "acme.plugin", capability: "BRIDGE_MESSAGE_DENIED", message: "session.search",
  }]);
  assert.deepEqual(host.denials(), audits);
  await host.close();
});

test("a declared custom command is relayed and a bad payload is audited once", async () => {
  const registry = createPluginMessageRegistry();
  registry.register("acme.plugin", [
    { name: "acme.plugin.do.thing", kind: "command", schema: { type: "object" } },
    { name: "acme.plugin.state.changed", kind: "event", schema: { type: "object", properties: { text: { type: "string" } } } },
  ]);
  const allowedNames = registry.names().map((entry) => entry.name);
  const commands: string[] = [];
  const audits: CapabilityAuditEntry[] = [];
  const host = createDirectoryProtocolHost({
    cwd: "/tmp",
    grantedCapabilities: registry.capabilities(),
    bridgeSlices: new Map(),
    messageRegistry: registry,
    pluginCommand: async ({ name }) => {
      commands.push(name);
      return { ok: true, value: { relayed: true } };
    },
    onAudit: (entry) => { audits.push(entry); },
  });
  const source: BridgeEnvelope["source"] = { type: "browser", id: "pi-web" };
  assert.equal((await host.handle(hello("pi-web", source))).ok, true);

  const command = envelope("acme.plugin.do.thing", source, {}, { allowedNames });
  assert.equal((await host.handle(command)).ok, true);
  assert.deepEqual(commands, ["acme.plugin.do.thing"]);

  const bad = envelope("acme.plugin.state.changed", source, { text: 42 }, { kind: "event", allowedNames });
  const denied = await host.handle(bad);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, "VALIDATION_FAILED");
  assert.deepEqual(audits, [{
    source: "pi-web", capability: "VALIDATION_FAILED", message: "acme.plugin.state.changed",
  }]);
  await host.close();
});

test("the first-party client keeps the full catalog with no slice entry", async () => {
  const host = createDirectoryProtocolHost({
    cwd: "/tmp",
    grantedCapabilities: catalogCapabilities(),
    bridgeSlices: new Map(),
  });
  const source: BridgeEnvelope["source"] = { type: "browser", id: "pi-web" };

  const handshaken = await host.handle(hello("pi-web", source));
  assert.equal(handshaken.ok, true);
  const outcome = await host.handle(envelope("session.search", source));
  assert.equal(outcome.ok, true);
  await host.close();
});
