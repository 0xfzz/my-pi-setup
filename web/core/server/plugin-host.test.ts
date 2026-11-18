import test from "node:test";
import assert from "node:assert/strict";
import {
  getPluginDescriptor,
  registerWebPlugins,
  visiblePluginsWhenReady,
} from "./plugin-host.ts";
import {
  attachSessionPlugins,
  isKnownSession,
  relayActionRequest,
  sessionBus,
  type MinimalEventBus,
} from "./plugin-sessions.ts";
import { checkAndSetInFlightAction, getActionAuditLog, recordActionAudit } from "./plugin-actions.ts";
import { clearWebPluginStateForTests, seedPluginFixtures } from "../../plugins/fixture-e2e/server/fixtures.ts";
import { pluginView, recordPluginView } from "./plugin-views.ts";
import { recordExtensionUi, webUiStore } from "./ui-store.ts";
import type { WebPluginDescriptor } from "../plugin-contracts/descriptor.ts";
import { WEB_PLUGIN_VIEW_EVENT } from "../plugin-contracts/view.ts";
import { WEB_PLUGIN_ACTION_REQUEST_EVENT } from "../plugin-contracts/actions.ts";
import { WEB_PLUGIN_UI_SYNC_EVENT } from "../plugin-contracts/ui-event-models.ts";
import { publishWebView } from "../plugin-contracts/publisher.ts";
import { WEB_PLUGINS } from "../../plugins/index.ts";

registerWebPlugins(WEB_PLUGINS);

test.afterEach(() => {
  clearWebPluginStateForTests();
  delete process.env.PI_WEB_TEST_PLUGIN_VIEWS;
});

/** A bus that records emissions and dispatches to registered handlers. */
function fakeBus(): { bus: MinimalEventBus; emissions: Array<{ ch: string; data: unknown }> } {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  const emissions: Array<{ ch: string; data: unknown }> = [];
  const bus: MinimalEventBus = {
    on: (channel: string, handler: (data: unknown) => void) => {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
      return () => {
        handlers.set(
          channel,
          (handlers.get(channel) ?? []).filter((h) => h !== handler),
        );
      };
    },
    emit: (channel: string, data: unknown) => {
      emissions.push({ ch: channel, data });
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
  };
  return { bus, emissions };
}

function attach(sessionId: string): { detach: () => void; emissions: Array<{ ch: string; data: unknown }>; bus: MinimalEventBus } {
  const { bus, emissions } = fakeBus();
  const detach = attachSessionPlugins({ sessionId, inner: { resourceLoader: { eventBus: bus } } });
  return { detach, emissions, bus };
}

test("recordExtensionUi clears the running flag on agent_end", () => {
  recordExtensionUi("working-session", { type: "agent_start" });
  assert.equal(webUiStore.snapshot().sessions["working-session"]?.running, true);

  recordExtensionUi("working-session", { type: "agent_end" });
  assert.equal(webUiStore.snapshot().sessions["working-session"]?.running, false);
});

test("recordView stores valid views and rejects invalid ones", () => {
  assert.equal(
    recordPluginView("host-session", "todo", {
      type: "kv",
      title: "Snapshot",
      rows: [{ label: "L", value: "V" }],
    }),
    true,
  );
  assert.ok(pluginView("host-session", "todo"));
  assert.deepEqual(Object.keys(webUiStore.snapshot().sessions), ["host-session"]);

  assert.equal(recordPluginView("host-session", "todo", { type: "nonsense" }), false);
  assert.equal(recordPluginView("", "todo", { type: "status", tone: "info", text: "x" }), false);
});

test("attachSessionPlugins routes bus view events into the store", () => {
  const { bus } = attach("host-session");
  assert.equal(isKnownSession("host-session"), true);

  bus.emit?.(WEB_PLUGIN_VIEW_EVENT, {
    pluginId: "cache-stats",
    view: { type: "status", tone: "success", text: "healthy" },
  });
  const view = pluginView("host-session", "cache-stats");
  assert.ok(view);
  assert.equal(view.type, "status");
});

test("attachSessionPlugins requests a ui-sync so late consumers converge", () => {
  const { emissions } = attach("sync-session");
  assert.ok(
    emissions.some(e => e.ch === WEB_PLUGIN_UI_SYNC_EVENT),
    "the host must ask producers to replay their current values on attach",
  );
});

test("a view published before attach is replayed into the store on attach", () => {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  const events = {
    emit: (channel: string, data: unknown) => {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    on: (channel: string, handler: (data: unknown) => void) => {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
      return () => {};
    },
  };

  // The producer published before this host ever attached (the exact
  // late-consumer ordering that used to leave the web empty).
  assert.equal(publishWebView({ events }, "todo", { type: "status", tone: "accent", text: "published early" }).ok, true);

  attachSessionPlugins({ sessionId: "replay-session", inner: { resourceLoader: { eventBus: events } } });

  assert.ok(
    pluginView("replay-session", "todo"),
    "the pre-attach view must be replayed when the host subscribes",
  );
});

test("attachSessionPlugins cleanup detaches the session bus", () => {
  const { detach, bus } = attach("detach-session");
  bus.emit?.(WEB_PLUGIN_VIEW_EVENT, {
    pluginId: "todo",
    view: { type: "status", tone: "accent", text: "seeded" },
  });
  assert.ok(pluginView("detach-session", "todo"));

  detach();
  assert.equal(relayActionRequest("detach-session", "todo", "sync").relayed, false);
});

test("relayActionRequest emits the request on the session bus", () => {
  const { emissions } = attach("relay-session");
  const result = relayActionRequest("relay-session", "subagent-graph", "request-sync", "req-42");
  assert.deepEqual(result, { relayed: true });

  const request = emissions.find((e) => e.ch === WEB_PLUGIN_ACTION_REQUEST_EVENT);
  assert.ok(request, "action request must be emitted");
  assert.deepEqual(request.data, {
    requestId: "req-42",
    sessionId: "relay-session",
    pluginId: "subagent-graph",
    actionId: "request-sync",
  });

  assert.equal(relayActionRequest("no-bus-session", "todo", "sync").relayed, false);
});

test("relayActionRequest forwards a dialog form's answers", () => {
  const { emissions } = attach("relay-values-session");
  relayActionRequest("relay-values-session", "providers", "continue", "req-43", undefined, {
    api: "openai-completions",
  });

  const request = emissions.find((e) => e.ch === WEB_PLUGIN_ACTION_REQUEST_EVENT);
  assert.ok(request, "action request must be emitted");
  assert.deepEqual(request.data, {
    requestId: "req-43",
    sessionId: "relay-values-session",
    pluginId: "providers",
    actionId: "continue",
    values: { api: "openai-completions" },
  });
});

/** The minimum a registry read needs from a host. */
function descriptor(id: string): WebPluginDescriptor {
  return { id, title: id, extension: id, surfaces: [] };
}

test("the served registry waits for boot before hiding not-yet-active plugins", async () => {
  // A plugin that is still activating is not `active`, so `visible()` hides it.
  // Answering the one-shot registry fetch before `ready` settles would tell the
  // client "no plugins" for the whole page load.
  let bootResolved = false;
  const ready = new Promise<void>((resolve) => {
    setTimeout(() => {
      bootResolved = true;
      resolve();
    }, 10);
  });
  const host = {
    ready,
    visible: () => (bootResolved ? [descriptor("late")] : []),
  };

  assert.deepEqual((await visiblePluginsWhenReady(host)).map((plugin) => plugin.id), ["late"]);
});

test("a host that never finishes booting still answers, bounded by the deadline", async () => {
  const host = { ready: new Promise<void>(() => {}), visible: () => [descriptor("fast")] };

  const plugins = await visiblePluginsWhenReady(host, 5);
  assert.deepEqual(plugins.map((plugin) => plugin.id), ["fast"]);
});

test("a rejected boot still serves the plugins that did activate", async () => {
  const host = { ready: Promise.reject(new Error("boom")), visible: () => [descriptor("survivor")] };

  const plugins = await visiblePluginsWhenReady(host, 50);
  assert.deepEqual(plugins.map((plugin) => plugin.id), ["survivor"]);
});

test("checkAndSetInFlightAction locks one submission of one action, not the whole session", () => {
  const claim = (sessionId: string, actionId: string) =>
    checkAndSetInFlightAction({ sessionId, pluginId: "todo", actionId, requestId: `${sessionId}-${actionId}` });

  assert.equal(claim("sess-1", "sync"), true);
  // The same action again while the first is held is refused…
  assert.equal(claim("sess-1", "sync"), false);
  // …but a different action in the same session is not.
  assert.equal(claim("sess-1", "clear"), true);
  assert.equal(claim("sess-2", "sync"), true);
});

test("a plugin publishing a view releases the action it was asked for", () => {
  const claim = (pluginId: string) =>
    checkAndSetInFlightAction({ sessionId: "sess-4", pluginId, actionId: "sync", requestId: "r" });

  assert.equal(claim("todo"), true);
  assert.equal(claim("todo"), false, "held while nothing has answered");

  // The handler answering with a new view is the signal that it is done.
  recordPluginView("sess-4", "todo", { type: "status", tone: "neutral", text: "synced" });
  assert.equal(claim("todo"), true, "the button is free again without waiting for the TTL");
});

test("an expired claim is reusable", () => {
  const claim = () =>
    checkAndSetInFlightAction({ sessionId: "sess-3", pluginId: "todo", actionId: "sync", requestId: "r", ttlMs: 0 });
  assert.equal(claim(), true);
  assert.equal(claim(), true);
});

test("audit log records entries and clears with the store", () => {
  recordActionAudit({
    requestId: "req-9",
    sessionId: "sess-9",
    pluginId: "todo",
    actionId: "sync",
    timestamp: Date.now(),
  });
  const log = getActionAuditLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].requestId, "req-9");
  assert.equal(log[0].pluginId, "todo");

  clearWebPluginStateForTests();
  assert.equal(getActionAuditLog().length, 0);
});

test("checkAndSeedFixtures seeds the test session when enabled", () => {
  process.env.PI_WEB_TEST_PLUGIN_VIEWS = "1";
  seedPluginFixtures();
  const session = "__test_session__";
  assert.ok(pluginView(session, "cache-stats"), "cache-stats kv view seeded");
  assert.ok(pluginView(session, "todo"), "todo list view seeded");
  const graph = pluginView(session, "subagent-graph");
  assert.ok(graph && graph.type === "graph", "monitor graph seeded");
  assert.equal(isKnownSession(session), true);

  // The seeded bus records action requests as graph updates with the request id.
  const bus = sessionBus(session);
  assert.ok(bus && typeof bus.emit === "function", "fixture bus present");
  bus.emit?.(WEB_PLUGIN_ACTION_REQUEST_EVENT, { requestId: "custom-req" });
  const updated = pluginView(session, "subagent-graph");
  assert.ok(updated && updated.type === "graph");
  const labeled = updated.nodes.find((node) => node.id === "child:worker-slots");
  assert.ok(labeled?.label.includes("custom-req"), "request id flows into the graph label");
});

test("getPluginDescriptor resolves inline plugins", () => {
  assert.equal(getPluginDescriptor("todo")?.id, "todo");
  assert.equal(getPluginDescriptor("cache-stats")?.extension, "cache-stats");
  assert.equal(getPluginDescriptor("never-heard-of"), undefined);
});
