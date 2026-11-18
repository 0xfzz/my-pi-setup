import test from "node:test";
import assert from "node:assert/strict";

import { ProtocolClient } from "../web/core/client/protocol-client.ts";
import {
  BRIDGE_MESSAGE_EVENT,
  BRIDGE_VALIDATION_MARKER,
  createPluginMessageRegistry,
  parseEnvelope,
  publishBridgeMessage,
  BRIDGE_PROTOCOL,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeEnvelope,
  type PluginMessageDeclaration,
} from "@pi/web-bridge";

const declaration: PluginMessageDeclaration = {
  name: "acme.plugin.state.changed",
  kind: "event",
  schema: { type: "object", required: ["text"], properties: { text: { type: "string" } }, additionalProperties: false },
};

function bus() {
  const envelopes: BridgeEnvelope[] = [];
  return {
    envelopes,
    target: {
      events: {
        emit: (_channel: string, data: unknown) => { envelopes.push(data as BridgeEnvelope); },
      },
    },
  };
}

function setup() {
  const registry = createPluginMessageRegistry();
  registry.register("acme.plugin", [declaration]);
  return registry;
}

test("publisher accepts a registered custom name and marks the validated payload", () => {
  const sink = bus();
  const result = publishBridgeMessage(sink.target, { type: "extension", id: "acme.plugin" },
    declaration.name, { text: "ready" }, "m1", { registry: setup() });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.envelope.name, declaration.name);
  const payload = result.envelope.payload as Record<string, unknown>;
  assert.deepEqual(payload[BRIDGE_VALIDATION_MARKER], { pluginId: "acme.plugin", name: declaration.name });
  assert.equal(sink.envelopes.length, 1);
});

test("publisher refuses foreign sources and unregistered names", () => {
  const registry = setup();
  const sink = bus();
  const foreign = publishBridgeMessage(sink.target, { type: "extension", id: "other.plugin" },
    declaration.name, { text: "x" }, "m2", { registry });
  const unregistered = publishBridgeMessage(sink.target, { type: "extension", id: "acme.plugin" },
    "acme.plugin.unknown", {}, "m3", { registry });
  assert.equal(foreign.ok, false);
  assert.equal(unregistered.ok, false);
  if (!foreign.ok) assert.equal(foreign.error.code, "CAPABILITY_DENIED");
  if (!unregistered.ok) assert.equal(unregistered.error.code, "UNKNOWN_MESSAGE");
  assert.equal(sink.envelopes.length, 0);
});

test("publisher refuses a payload that fails the plugin schema", () => {
  const sink = bus();
  const result = publishBridgeMessage(sink.target, { type: "plugin", id: "acme.plugin" },
    declaration.name, { text: 42 }, "m4", { registry: setup() });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "VALIDATION_FAILED");
  assert.equal(sink.envelopes.length, 0);
});

test("ProtocolClient invokes and subscribes to declared custom names", async () => {
  const calls: Array<{ name: string }> = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { name: string };
    calls.push({ name: body.name });
    const value = body.name === "bridge.hello"
      ? { version: 1, capabilities: [], bindings: ["http-sse"], cursor: "0" }
      : { payload: { relayed: true } };
    return new Response(JSON.stringify({ ok: true, value }), { status: 200 });
  };
  class FakeEventSource {
    static last: FakeEventSource | undefined;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(_url: string) { FakeEventSource.last = this; }
    close(): void { /* no network in tests */ }
    emit(data: unknown): void { this.onmessage?.({ data: JSON.stringify(data) }); }
  }
  const client = new ProtocolClient({
    sessionId: "s1", fetch: fetcher,
    eventSource: FakeEventSource as unknown as typeof EventSource,
  });
  const release = client.registerCustomMessages([
    { name: "acme.plugin.do.thing", kind: "command" },
    { name: "acme.plugin.state.changed", kind: "event" },
  ]);

  const outcome = await client.invoke("acme.plugin.do.thing", {});
  assert.equal(outcome.ok, true);
  assert.deepEqual(calls.map((call) => call.name), ["bridge.hello", "acme.plugin.do.thing"]);
  assert.throws(() => client.subscribe("acme.plugin.unknown", () => undefined), /not an event/);

  const received: string[] = [];
  const unsubscribe = client.subscribe("acme.plugin.state.changed", (envelope) => {
    received.push(envelope.name);
  });
  const custom = parseEnvelope({
    protocol: BRIDGE_PROTOCOL, version: BRIDGE_PROTOCOL_VERSION, kind: "event",
    name: "acme.plugin.state.changed", messageId: "evt:1",
    source: { type: "extension", id: "acme.plugin" }, timestamp: 0, payload: { text: "hi" },
  }, ["acme.plugin.state.changed"]);
  assert.equal(custom.ok, true);
  const sessionFrame = parseEnvelope({
    protocol: BRIDGE_PROTOCOL, version: BRIDGE_PROTOCOL_VERSION, kind: "event",
    name: "session.events", messageId: "stream:1",
    source: { type: "host", id: "protocol-host" }, timestamp: 0,
    payload: { type: "protocol_envelope", envelope: custom.ok ? custom.envelope : null },
  });
  assert.equal(sessionFrame.ok, true);
  FakeEventSource.last?.emit(sessionFrame.envelope);
  assert.deepEqual(received, ["acme.plugin.state.changed"]);
  unsubscribe();
  release();
});

test("catalog names still publish without a registry", () => {
  const sink = bus();
  const result = publishBridgeMessage(sink.target, { type: "extension", id: "fixture.ext" },
    "ui.status.changed", { key: "x", text: "ready" }, "m5");
  assert.equal(result.ok, true);
  assert.equal(sink.envelopes[0]?.name, "ui.status.changed");
  assert.equal(BRIDGE_MESSAGE_EVENT, "bridge-protocol:message");
});
