import test from "node:test";
import assert from "node:assert/strict";

import { CapabilityError, type Capability } from "../web/core/plugin-contracts/kernel/capabilities.ts";
import {
  MAX_LISTENERS_PER_CHANNEL,
  MAX_PENDING_PER_LISTENER,
  PEER_PAYLOAD_MAX_BYTES,
  PluginChannelBus,
  boundedPeerPayload,
  isOwnChannel,
} from "../web/core/plugin-contracts/kernel/plugin-channels.ts";
import type { DiscoveredPlugin } from "../web/core/plugin-contracts/kernel/discovery.ts";
import { validateManifest } from "../web/core/plugin-contracts/kernel/manifest.ts";
import { PluginManager, type PluginLoader, type PluginRuntime } from "../web/core/plugin-contracts/kernel/manager.ts";
import { defaultState, setPluginState, type WebPluginsState } from "../web/core/plugin-contracts/kernel/state.ts";

const grants = (...caps: string[]): Capability[] => caps.map((c) => {
  const i = c.indexOf(":");
  return i === -1 ? { kind: c as Capability["kind"] } : { kind: c.slice(0, i) as Capability["kind"], arg: c.slice(i + 1) };
});

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("a plugin's channel is its own namespace, and nothing else", () => {
  assert.equal(isOwnChannel("acme.indexer", "acme.indexer.done"), true);
  assert.equal(isOwnChannel("acme.indexer", "acme.indexer"), false, "the bare id is not a channel");
  assert.equal(isOwnChannel("acme.indexer", "acme.other.done"), false);
  assert.equal(isOwnChannel("acme.indexer", "session.tool"), false);
  assert.equal(isOwnChannel("acme.indexer", "acme.indexer.Done"), false, "channels are lower-case");
  assert.equal(isOwnChannel("acme", "acme.indexer.done"), true, "a parent namespace owns its children");
});

test("a listener in the same namespace gets the event with its emitter named", async () => {
  const bus = new PluginChannelBus();
  const seen: unknown[] = [];
  bus.listen({ pluginId: "acme.indexer", grants: [] }, "acme.indexer.done", (event) => {
    seen.push(event);
  });
  assert.equal(bus.emit({ pluginId: "acme.indexer", grants: [] }, "acme.indexer.done", { files: 4 }), true);
  await settle();
  assert.deepEqual(seen, [{ channel: "acme.indexer.done", from: "acme.indexer", payload: { files: 4 } }]);
});

test("listening to another plugin's channel needs its grant, and the refusal names it", () => {
  const bus = new PluginChannelBus();
  assert.throws(
    () => bus.listen({ pluginId: "acme.watch", grants: [] }, "acme.indexer.done", () => undefined),
    CapabilityError,
  );
  assert.doesNotThrow(() =>
    bus.listen({ pluginId: "acme.watch", grants: grants("events.subscribe:acme.indexer.done") }, "acme.indexer.done", () => undefined));
  // A wildcard grant covers a namespace.
  assert.doesNotThrow(() =>
    bus.listen({ pluginId: "acme.watch", grants: grants("events.subscribe:acme.indexer.*") }, "acme.indexer.done", () => undefined));
});

test("a plugin cannot emit into another plugin's namespace", () => {
  const bus = new PluginChannelBus();
  const seen: unknown[] = [];
  bus.listen({ pluginId: "acme.watch", grants: grants("events.subscribe:acme.indexer.done") }, "acme.indexer.done", (event) => {
    seen.push(event);
  });
  assert.equal(bus.emit({ pluginId: "acme.watch", grants: grants("events.subscribe:acme.indexer.done") }, "acme.indexer.done", { spoofed: true }), false);
  assert.equal(bus.emit({ pluginId: "acme.watch", grants: [] }, "session.tool", {}), false, "host channels are not plugin channels");
  return settle().then(() => assert.deepEqual(seen, []));
});

test("host session channels are refused by listen, with the right API named", () => {
  const bus = new PluginChannelBus();
  assert.throws(
    () => bus.listen({ pluginId: "acme.watch", grants: grants("tap.pi-events") }, "session.tool", () => undefined),
    /is host session traffic; use ctx\.events\.on/,
  );
});

test("payloads are bounded, inert JSON: cycles, depth, size and unsafe keys are refused", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(boundedPeerPayload(cyclic).ok, false);

  let deep: unknown = "leaf";
  for (let i = 0; i < 12; i++) deep = { next: deep };
  assert.equal(boundedPeerPayload(deep).ok, false);

  assert.equal(boundedPeerPayload({ blob: "x".repeat(PEER_PAYLOAD_MAX_BYTES) }).ok, false);
  assert.equal(boundedPeerPayload(JSON.parse('{"__proto__":{"polluted":true}}')).ok, false);
  assert.equal(boundedPeerPayload({ when: Number.NaN }).ok, false);
  assert.equal(boundedPeerPayload(() => undefined).ok, false);

  const ok = boundedPeerPayload({ files: 4, names: ["a", "b"], nested: { ok: true } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok ? ok.value : undefined, { files: 4, names: ["a", "b"], nested: { ok: true } });
});

test("an invalid payload is refused without reaching a listener", async () => {
  const bus = new PluginChannelBus();
  const seen: unknown[] = [];
  bus.listen({ pluginId: "acme.indexer", grants: [] }, "acme.indexer.done", (event) => {
    seen.push(event);
  });
  assert.equal(bus.emit({ pluginId: "acme.indexer", grants: [] }, "acme.indexer.done", { bad: () => undefined }), false);
  await settle();
  assert.deepEqual(seen, []);
});

test("one listener's throw or timeout is reported and does not stop the others", async () => {
  const failures: Array<{ pluginId: string; reason: string }> = [];
  const bus = new PluginChannelBus({ budgetMs: 20, onFailure: (failure) => failures.push({ pluginId: failure.pluginId, reason: failure.reason }) });
  const seen: string[] = [];
  const channel = "acme.indexer.done";
  const granted = grants(`events.subscribe:${channel}`);
  bus.listen({ pluginId: "acme.boom", grants: granted }, channel, () => {
    throw new Error("nope");
  });
  bus.listen({ pluginId: "acme.slow", grants: granted }, channel, () => new Promise(() => undefined));
  bus.listen({ pluginId: "acme.ok", grants: granted }, channel, (event) => {
    seen.push(event.from);
  });
  bus.emit({ pluginId: "acme.indexer", grants: [] }, channel, {});
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(seen, ["acme.indexer"]);
  assert.deepEqual(failures.sort((a, b) => a.pluginId.localeCompare(b.pluginId)), [
    { pluginId: "acme.boom", reason: "error" },
    { pluginId: "acme.slow", reason: "timeout" },
  ]);
});

test("a listener's deliveries keep order across a slow handler", async () => {
  const bus = new PluginChannelBus({ budgetMs: 500 });
  const order: string[] = [];
  let first = true;
  bus.listen({ pluginId: "acme.indexer", grants: [] }, "acme.indexer.tick", async (event) => {
    const payload = event.payload as { n: number };
    if (first) {
      first = false;
      order.push(`slow:${payload.n}:start`);
      await settle();
      order.push(`slow:${payload.n}:end`);
      return;
    }
    order.push(`fast:${payload.n}`);
  });
  bus.emit({ pluginId: "acme.indexer", grants: [] }, "acme.indexer.tick", { n: 1 });
  bus.emit({ pluginId: "acme.indexer", grants: [] }, "acme.indexer.tick", { n: 2 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(order, ["slow:1:start", "slow:1:end", "fast:2"]);
});

test("a listener that cannot keep up drops its own backlog and is reported once per drop", async () => {
  const overflows: Array<{ pluginId: string; dropped: number }> = [];
  const bus = new PluginChannelBus({ budgetMs: 500, onOverflow: (overflow) => overflows.push({ pluginId: overflow.pluginId, dropped: overflow.dropped }) });
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delivered = 0;
  bus.listen({ pluginId: "acme.slow", grants: grants("events.subscribe:acme.indexer.tick") }, "acme.indexer.tick", async () => {
    delivered++;
    await gate;
  });
  for (let i = 0; i < MAX_PENDING_PER_LISTENER + 5; i++) {
    bus.emit({ pluginId: "acme.indexer", grants: [] }, "acme.indexer.tick", { n: i });
  }
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(delivered, MAX_PENDING_PER_LISTENER, "only the queue cap is delivered");
  assert.equal(overflows.length, 5, "each dropped event is reported");
  assert.deepEqual(overflows.map((entry) => entry.dropped), [1, 2, 3, 4, 5]);
});

test("a channel is capped at a fixed number of listeners", () => {
  const bus = new PluginChannelBus();
  for (let i = 0; i < MAX_LISTENERS_PER_CHANNEL; i++) {
    bus.listen({ pluginId: "acme.indexer", grants: [] }, "acme.indexer.done", () => undefined);
  }
  assert.throws(
    () => bus.listen({ pluginId: "acme.indexer", grants: [] }, "acme.indexer.done", () => undefined),
    /already has 64 listeners/,
  );
});

test("unsubscribing and removeOwner both stop delivery", async () => {
  const bus = new PluginChannelBus();
  const seen: string[] = [];
  const unsubscribe = bus.listen({ pluginId: "acme.indexer", grants: [] }, "acme.indexer.done", () => {
    seen.push("unsubscribed");
  });
  bus.listen({ pluginId: "acme.indexer", grants: [] }, "acme.indexer.done", () => {
    seen.push("owned");
  });
  bus.listen({ pluginId: "acme.other", grants: [] }, "acme.other.done", () => {
    seen.push("other");
  });
  unsubscribe();
  bus.emit({ pluginId: "acme.indexer", grants: [] }, "acme.indexer.done", {});
  await settle();
  assert.deepEqual(seen, ["owned"]);

  assert.equal(bus.removeOwner("acme.indexer"), 1);
  assert.equal(bus.hasListeners("acme.indexer.done"), false);
  assert.equal(bus.hasListeners("acme.other.done"), true);
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

test("two plugins talk over ctx.events: one emits, the other listens, teardown ends it", async () => {
  const indexer = candidate("acme.indexer", []);
  const watcher = candidate("acme.watch", ["events.subscribe:acme.indexer.done"]);
  const channels = new PluginChannelBus();
  const seen: unknown[] = [];
  const loader: PluginLoader = (plugin): PluginRuntime => (plugin.id === "acme.indexer"
    ? {
      activate: (ctx) => {
        ctx.events.emit("acme.indexer.done", { files: 2 });
      },
    }
    : {
      activate: (ctx) => {
        ctx.events.listen("acme.indexer.done", (event) => {
          seen.push(event);
        });
      },
    });
  const manager = new PluginManager({
    plugins: [indexer, watcher],
    state: { ...defaultState(), plugins: { ...confirmed(indexer).plugins, ...confirmed(watcher).plugins } },
    loader,
    channels,
  });
  await manager.start();
  // The indexer emitted during activation, before the watcher was listening:
  // a channel is live traffic, so that one is gone. Emit again now.
  channels.emit({ pluginId: "acme.indexer", grants: [] }, "acme.indexer.done", { files: 5 });
  await settle();
  assert.deepEqual(seen, [{ channel: "acme.indexer.done", from: "acme.indexer", payload: { files: 5 } }]);

  await manager.disable("acme.watch");
  channels.emit({ pluginId: "acme.indexer", grants: [] }, "acme.indexer.done", { files: 6 });
  await settle();
  assert.equal(seen.length, 1, "a disabled listener receives nothing");
});

test("a listener failure is audited against the listener, not the emitter", async () => {
  const { AuditLog } = await import("../web/core/plugin-contracts/kernel/audit.ts");
  const indexer = candidate("acme.indexer", []);
  const watcher = candidate("acme.watch", ["events.subscribe:acme.indexer.done"]);
  const audit = new AuditLog();
  const channels = new PluginChannelBus();
  const loader: PluginLoader = (plugin): PluginRuntime => (plugin.id === "acme.indexer"
    ? {}
    : {
      activate: (ctx) => {
        ctx.events.listen("acme.indexer.done", () => {
          throw new Error("listener exploded");
        });
      },
    });
  const manager = new PluginManager({
    plugins: [indexer, watcher],
    state: { ...defaultState(), plugins: { ...confirmed(indexer).plugins, ...confirmed(watcher).plugins } },
    loader,
    channels,
    audit,
  });
  await manager.start();
  channels.emit({ pluginId: "acme.indexer", grants: [] }, "acme.indexer.done", {});
  await settle();
  const failures = audit.list({ kind: "failure" });
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.pluginId, "acme.watch");
  assert.match(failures[0]?.detail ?? "", /listen acme\.indexer\.done error: listener exploded/);
});
