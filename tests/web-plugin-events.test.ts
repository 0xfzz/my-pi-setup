import test from "node:test";
import assert from "node:assert/strict";

import { CapabilityError, type Capability } from "../web/core/plugin-contracts/kernel/capabilities.ts";
import { AuditLog } from "../web/core/plugin-contracts/kernel/audit.ts";
import { EventTapRegistry, TAP_CHANNELS, type TapEvent } from "../web/core/plugin-contracts/kernel/events.ts";
import type { DiscoveredPlugin } from "../web/core/plugin-contracts/kernel/discovery.ts";
import { validateManifest } from "../web/core/plugin-contracts/kernel/manifest.ts";
import { PluginManager, type PluginLoader, type PluginRuntime } from "../web/core/plugin-contracts/kernel/manager.ts";
import { defaultState, setPluginState, type WebPluginsState } from "../web/core/plugin-contracts/kernel/state.ts";

const grants = (...caps: string[]): Capability[] => caps.map((c) => {
  const i = c.indexOf(":");
  return i === -1 ? { kind: c as Capability["kind"] } : { kind: c.slice(0, i) as Capability["kind"], arg: c.slice(i + 1) };
});

function tapEvent(overrides: Partial<TapEvent> = {}): TapEvent {
  return {
    channel: "session.tool",
    sessionId: "s1",
    project: "/repo",
    type: "tool_execution_end",
    payload: { toolName: "bash" },
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test("a subscription receives only its own channel, with the event the host published", async () => {
  const tap = new EventTapRegistry();
  const seen: TapEvent[] = [];
  tap.subscribe({ pluginId: "acme.watch", grants: grants("tap.pi-events:session.tool") }, "session.tool", (event) => {
    seen.push(event);
  });
  await tap.publish(tapEvent());
  await tap.publish(tapEvent({ channel: "session.lifecycle", type: "agent_settled" }));
  assert.deepEqual(seen.map((event) => event.type), ["tool_execution_end"]);
  assert.equal(seen[0]?.sessionId, "s1");
});

test("a wildcard grant covers every channel, a bare one covers one", () => {
  const tap = new EventTapRegistry();
  const wildcard = { pluginId: "acme.all", grants: grants("tap.pi-events") };
  for (const channel of TAP_CHANNELS) {
    assert.doesNotThrow(() => tap.subscribe(wildcard, channel, () => undefined), channel);
  }
  const single = { pluginId: "acme.one", grants: grants("tap.pi-events:session.tool") };
  assert.throws(() => tap.subscribe(single, "session.message", () => undefined), CapabilityError);
});

test("an unknown channel and an ungranted plugin are both refused at subscribe time", () => {
  const tap = new EventTapRegistry();
  const owner = { pluginId: "acme.watch", grants: grants("tap.pi-events") };
  assert.throws(() => tap.subscribe(owner, "session.nonsense", () => undefined), /unknown tap channel "session.nonsense"/);
  assert.throws(
    () => tap.subscribe({ pluginId: "acme.watch", grants: [] }, "session.tool", () => undefined),
    CapabilityError,
  );
});

test("a throwing or slow handler is reported and never blocks the other subscribers", async () => {
  const failures: Array<{ pluginId: string; reason: string }> = [];
  const tap = new EventTapRegistry({ budgetMs: 20, onFailure: (failure) => failures.push({ pluginId: failure.pluginId, reason: failure.reason }) });
  const seen: string[] = [];
  tap.subscribe({ pluginId: "acme.boom", grants: grants("tap.pi-events") }, "session.tool", () => {
    throw new Error("nope");
  });
  tap.subscribe({ pluginId: "acme.slow", grants: grants("tap.pi-events") }, "session.tool", () => new Promise(() => undefined));
  tap.subscribe({ pluginId: "acme.ok", grants: grants("tap.pi-events") }, "session.tool", (event) => {
    seen.push(event.type);
  });
  await tap.publish(tapEvent());
  assert.deepEqual(seen, ["tool_execution_end"]);
  assert.deepEqual(failures.sort((a, b) => a.pluginId.localeCompare(b.pluginId)), [
    { pluginId: "acme.boom", reason: "error" },
    { pluginId: "acme.slow", reason: "timeout" },
  ]);
});

test("one subscriber's deliveries keep publish order even when its handler is slow", async () => {
  const tap = new EventTapRegistry({ budgetMs: 1_000 });
  const order: string[] = [];
  const gate = deferred();
  let first = true;
  tap.subscribe({ pluginId: "acme.order", grants: grants("tap.pi-events") }, "session.tool", async (event) => {
    if (first) {
      first = false;
      order.push(`${event.type}:start`);
      await gate.promise;
      order.push(`${event.type}:end`);
      return;
    }
    order.push(event.type);
  });
  const firstPublish = tap.publish(tapEvent({ type: "tool_execution_start" }));
  const secondPublish = tap.publish(tapEvent({ type: "tool_execution_end" }));
  gate.resolve();
  await Promise.all([firstPublish, secondPublish]);
  assert.deepEqual(order, ["tool_execution_start:start", "tool_execution_start:end", "tool_execution_end"]);
});

test("hasSubscribers reports the channels the host would pay a projection for", () => {
  const tap = new EventTapRegistry();
  assert.equal(tap.hasSubscribers("session.tool"), false);
  const unsubscribe = tap.subscribe({ pluginId: "acme.watch", grants: grants("tap.pi-events") }, "session.tool", () => undefined);
  assert.equal(tap.hasSubscribers("session.tool"), true);
  assert.equal(tap.hasSubscribers("session.message"), false);
  unsubscribe();
  assert.equal(tap.hasSubscribers("session.tool"), false);
});

test("removeOwner drops every channel a plugin subscribed to, in one step", async () => {
  const tap = new EventTapRegistry();
  const seen: string[] = [];
  for (const channel of TAP_CHANNELS) {
    tap.subscribe({ pluginId: "acme.watch", grants: grants("tap.pi-events") }, channel, (event) => {
      seen.push(event.channel);
    });
  }
  tap.subscribe({ pluginId: "acme.other", grants: grants("tap.pi-events") }, "session.tool", (event) => {
    seen.push(`other:${event.channel}`);
  });
  assert.equal(tap.removeOwner("acme.watch"), TAP_CHANNELS.length);
  for (const channel of TAP_CHANNELS) await tap.publish(tapEvent({ channel }));
  assert.deepEqual(seen, ["other:session.tool"]);
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

test("a plugin's ctx.events subscription receives live events while active and stops when disabled", async () => {
  const plugin = candidate("acme.watch", ["tap.pi-events:session.tool"]);
  const tap = new EventTapRegistry();
  const seen: TapEvent[] = [];
  const loader: PluginLoader = (): PluginRuntime => ({
    activate: (ctx) => {
      ctx.events.on("session.tool", (event) => {
        seen.push(event);
      });
    },
  });
  const manager = new PluginManager({ plugins: [plugin], state: confirmed(plugin), loader, events: tap });
  await manager.start();
  assert.deepEqual(manager.activeIds(), ["acme.watch"]);

  await tap.publish(tapEvent());
  assert.deepEqual(seen.map((event) => event.type), ["tool_execution_end"]);

  await manager.disable("acme.watch");
  await tap.publish(tapEvent());
  assert.equal(seen.length, 1, "a disabled plugin's subscription is gone");
});

test("a plugin without the tap grant fails activation instead of silently receiving nothing", async () => {
  const plugin = candidate("acme.nosy", []);
  const loader: PluginLoader = (): PluginRuntime => ({
    activate: (ctx) => {
      ctx.events.on("session.tool", () => undefined);
    },
  });
  const manager = new PluginManager({ plugins: [plugin], state: confirmed(plugin), loader, events: new EventTapRegistry() });
  const report = await manager.start();
  assert.match(report.failed["acme.nosy"] ?? "", /lacks capability "tap\.pi-events:session\.tool"/);
});

test("a tap handler failure is audited against the plugin that threw", async () => {
  const plugin = candidate("acme.boom", ["tap.pi-events:session.tool"]);
  const tap = new EventTapRegistry();
  const loader: PluginLoader = (): PluginRuntime => ({
    activate: (ctx) => {
      ctx.events.on("session.tool", () => {
        throw new Error("handler exploded");
      });
    },
  });
  const audit = new AuditLog();
  const manager = new PluginManager({ plugins: [plugin], state: confirmed(plugin), loader, events: tap, audit });
  await manager.start();
  await tap.publish(tapEvent());
  const failures = audit.list({ pluginId: "acme.boom", kind: "failure" });
  assert.equal(failures.length, 1);
  assert.match(failures[0]?.detail ?? "", /tap session\.tool error: handler exploded/);
});
