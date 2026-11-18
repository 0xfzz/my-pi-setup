/** Regressions for the capability/handshake bugs found in the bridge recheck. */
import test from "node:test";
import assert from "node:assert/strict";

import { parseCapability, type Capability } from "../../plugin-contracts/kernel/capabilities.ts";
import { lookupMessage } from "../catalog.ts";
import { parseEnvelope, type BridgeEnvelope } from "../envelope.ts";
import { BRIDGE_PROTOCOL, BRIDGE_PROTOCOL_VERSION, type Hello } from "../version.ts";
import { attributedSource, gate, handshakeFor, isGrantedCapability } from "./shared.ts";
import type { BindingOptions } from "./types.ts";

function capability(value: string): Capability {
  const parsed = parseCapability(value);
  if (!parsed.ok) assert.fail(parsed.error);
  return parsed.value;
}

function envelope(source: BridgeEnvelope["source"]): BridgeEnvelope {
  const parsed = parseEnvelope({
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_PROTOCOL_VERSION,
    kind: "query",
    name: "settings.read",
    messageId: "handshake-test",
    source,
    timestamp: 0,
    payload: {},
  });
  if (!parsed.ok) assert.fail(parsed.error.message);
  return parsed.envelope;
}

function hello(capabilities: string[] = [], version = BRIDGE_PROTOCOL_VERSION): Hello {
  return {
    version,
    bindings: ["http-sse"],
    clientId: "browser-client",
    capabilities,
  } as Hello;
}

function options(grants: string[] = []): BindingOptions {
  return {
    name: "http-sse",
    sessionId: "session-1",
    cwd: "/tmp",
    grantedCapabilities: grants,
  };
}

test("grantCovers globs honour protocol.invoke:* and events.subscribe:* grants", () => {
  const grants = ["protocol.invoke:*", "events.subscribe:tools", "session.read"].map(capability);
  assert.equal(isGrantedCapability(grants, capability("protocol.invoke:settings.read")), true);
  assert.equal(isGrantedCapability(grants, capability("events.subscribe:tools")), true);
  assert.equal(isGrantedCapability(grants, capability("events.subscribe:models")), false);
  // A grant without an argument covers every argument of its own kind.
  assert.equal(isGrantedCapability(["commands"].map(capability), capability("commands")), true);
  assert.equal(isGrantedCapability(grants, capability("session.write")), false);
});

test("a browser with a negotiated grant is admitted; one without it is denied and audited", () => {
  const state = handshakeFor(hello(["protocol.invoke:settings.read"]), options(["protocol.invoke:settings.read"]));
  assert.equal(state.ok, true);
  if (!state.ok) return;
  const message = lookupMessage("settings.read");
  assert.ok(message);
  const browser = envelope({ type: "browser", id: "browser-client" });
  assert.equal(gate(message, browser, state.value), undefined);

  const audited: Array<{ source: string; capability: string; message: string }> = [];
  const ungranted = handshakeFor(hello([]), options([]));
  assert.equal(ungranted.ok, true);
  if (!ungranted.ok) return;
  const refusal = gate(message, browser, ungranted.value, (entry) => { audited.push(entry); });
  assert.equal(refusal?.code, "CAPABILITY_DENIED");
  assert.deepEqual(audited, [{
    source: "browser-client",
    capability: "protocol.invoke:settings.read",
    message: "settings.read",
  }]);
});

test("the browser transport cannot claim a core or host source", () => {
  const state = handshakeFor(hello(), options());
  assert.equal(state.ok, true);
  if (!state.ok) return;
  const spoofed = envelope({ type: "core", id: "pi-kernel" });
  assert.deepEqual(attributedSource(spoofed, state.value, "http-sse").source, {
    type: "browser", id: "browser-client",
  });
  const hostSpoof = envelope({ type: "host", id: "protocol-host" });
  assert.deepEqual(attributedSource(hostSpoof, state.value, "http-sse").source, {
    type: "browser", id: "browser-client",
  });
  const inProcess = attributedSource(spoofed, state.value, "in-process");
  assert.deepEqual(inProcess.source, spoofed.source);
});

test("hello negotiates only requested capabilities that the host grants", () => {
  const ack = handshakeFor(hello(["session.read", "session.write", "exec"]), options(["session.read", "commands"]));
  assert.equal(ack.ok, true);
  if (!ack.ok) return;
  assert.deepEqual(ack.value.capabilities, ["session.read"]);
  assert.equal(ack.value.sessionId, "session-1");
  assert.equal(ack.value.cursor, "0");
});

test("a future version is a named VERSION_MISMATCH, before any command", () => {
  const ack = handshakeFor(hello([], BRIDGE_PROTOCOL_VERSION + 1), options(["session.read"]));
  assert.equal(ack.ok, false);
  if (ack.ok) return;
  assert.equal(ack.error.code, "VERSION_MISMATCH");
  assert.match(ack.error.message, new RegExp(`v${BRIDGE_PROTOCOL_VERSION + 1}`));
});

test("an invalid Hello payload is a VALIDATION_FAILED, not an implicit grant", () => {
  const invalid = { version: BRIDGE_PROTOCOL_VERSION, bindings: [], clientId: "", capabilities: [] };
  const ack = handshakeFor(invalid as unknown as Hello, options(["session.read"]));
  assert.equal(ack.ok, false);
  if (ack.ok) return;
  assert.equal(ack.error.code, "VALIDATION_FAILED");
});
