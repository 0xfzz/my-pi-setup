import test from "node:test";
import assert from "node:assert/strict";

import {
  BRIDGE_MESSAGE_DENIED,
  BridgeMessageDeniedError,
  createPluginBridge,
  type BridgeResult,
  type PluginBridgeTransport,
} from "@pi-web/bridge";
import { createCorePluginBridge, ProtocolClient } from "../web/core/client/protocol-client.ts";

function transport(calls: string[]): PluginBridgeTransport {
  return {
    invoke: async <T>(name: string): Promise<BridgeResult<T>> => {
      calls.push(name);
      return { ok: true, value: { name } as T };
    },
    subscribe: (name) => {
      calls.push(`subscribe:${name}`);
      return () => undefined;
    },
  };
}

test("a declared core message reaches the supplied transport", async () => {
  const calls: string[] = [];
  const bridge = createPluginBridge({
    pluginId: "acme.plugin",
    core: ["session.list", "session.events"],
    transport: transport(calls),
  });
  const outcome = await bridge.query("session.list", {});
  assert.equal(outcome.ok, true);
  assert.deepEqual(calls, ["session.list"]);
});

test("an undeclared invoke or query returns BRIDGE_MESSAGE_DENIED without transport use", async () => {
  const calls: string[] = [];
  const bridge = createPluginBridge({
    pluginId: "acme.plugin",
    core: ["session.list"],
    transport: transport(calls),
  });
  const invoke = await bridge.invoke("session.delete", {});
  const query = await bridge.query("session.delete", {});
  assert.deepEqual([invoke.ok, query.ok], [false, false]);
  if (!invoke.ok) assert.equal(invoke.error.code, BRIDGE_MESSAGE_DENIED);
  if (!query.ok) assert.equal(query.error.code, BRIDGE_MESSAGE_DENIED);
  assert.deepEqual(calls, []);
});

test("an undeclared subscription throws the named denial instead of opening a stream", () => {
  const calls: string[] = [];
  const bridge = createPluginBridge({
    pluginId: "acme.plugin",
    core: ["session.list"],
    transport: transport(calls),
  });
  assert.throws(() => bridge.subscribe("session.events", () => undefined), (error: unknown) => {
    assert.ok(error instanceof BridgeMessageDeniedError);
    assert.equal(error.code, BRIDGE_MESSAGE_DENIED);
    return true;
  });
  assert.deepEqual(calls, []);
});

test("a declared name outside the frozen catalog is not part of the slice", () => {
  const bridge = createPluginBridge({
    pluginId: "acme.plugin",
    core: ["session.list", "not.a.catalog.message"],
    transport: transport([]),
  });
  assert.deepEqual([...bridge.core], ["session.list"]);
});

test("the core factory labels envelopes with the plugin id, not the first-party client id", async () => {
  type FetchCall = { body: { name: string; source: { id: string } } };
  const calls: FetchCall[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as FetchCall["body"];
    calls.push({ body });
    const reply = body.name === "bridge.hello"
      ? { ok: true, value: { version: 1, capabilities: [], bindings: ["http-sse"], cursor: "0" } }
      : { ok: true, value: { payload: {} } };
    return new Response(JSON.stringify(reply), { status: 200 });
  };
  const client = new ProtocolClient({ sessionId: "s1", fetch: fetcher });
  const bridge = createCorePluginBridge({ pluginId: "acme.plugin", core: ["session.list"], client });

  const outcome = await bridge.query("session.list", {});
  assert.equal(outcome.ok, true);
  assert.deepEqual(calls.map((call) => call.body.name), ["bridge.hello", "session.list"]);
  assert.deepEqual(calls.map((call) => call.body.source.id), ["pi-web", "acme.plugin"]);

  const denied = await bridge.query("session.delete", {});
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, BRIDGE_MESSAGE_DENIED);
  assert.equal(calls.length, 2, "a denied query never reaches the transport");
});
