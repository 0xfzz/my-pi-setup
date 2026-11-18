import test from "node:test";
import assert from "node:assert/strict";

import { catalogCapabilities, lookupMessage } from "../protocol/catalog.ts";
import { parseEnvelope, type BridgeEnvelope } from "../protocol/envelope.ts";
import { BRIDGE_PROTOCOL, BRIDGE_PROTOCOL_VERSION, HELLO } from "../protocol/version.ts";
import type { CapabilityAuditEntry } from "../protocol/bindings/types.ts";
import { createDirectoryProtocolHost } from "./protocol-host.ts";

function envelope(
  name: string,
  source: BridgeEnvelope["source"],
  payload: unknown = {},
): BridgeEnvelope {
  const parsed = parseEnvelope({
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_PROTOCOL_VERSION,
    kind: lookupMessage(name)?.kind ?? "command",
    name,
    messageId: `${source.id}-${name}`,
    source,
    timestamp: 0,
    payload,
  });
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
