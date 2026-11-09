import test from "node:test";
import assert from "node:assert/strict";
import {
  attachSessionPlugins,
  checkAndSeedFixtures,
  checkAndSetInFlightAction,
  clearWebPluginStateForTests,
  getActionAuditLog,
  getPluginDescriptor,
  isKnownSession,
  recordActionAudit,
  relayActionRequest,
  webPluginsStore,
  type MinimalEventBus,
} from "./plugin-host.ts";
import { WEB_PLUGIN_VIEW_EVENT } from "../../lib/web-plugins/view.ts";
import { WEB_PLUGIN_ACTION_REQUEST_EVENT } from "../../lib/web-plugins/actions.ts";

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

test("recordView stores valid views and rejects invalid ones", () => {
  assert.equal(
    webPluginsStore.recordView("host-session", "todo", {
      type: "kv",
      title: "Snapshot",
      rows: [{ label: "L", value: "V" }],
    }),
    true,
  );
  assert.ok(webPluginsStore.getView("host-session", "todo"));
  assert.equal(webPluginsStore.getLatestView("todo") !== undefined, true);
  assert.deepEqual(Object.keys(webPluginsStore.getAllViews()), ["host-session"]);

  assert.equal(webPluginsStore.recordView("host-session", "todo", { type: "nonsense" }), false);
  assert.equal(webPluginsStore.recordView("", "todo", { type: "status", tone: "info", text: "x" }), false);
});

test("attachSessionPlugins routes bus view events into the store", () => {
  const { bus } = attach("host-session");
  assert.equal(isKnownSession("host-session"), true);

  bus.emit?.(WEB_PLUGIN_VIEW_EVENT, {
    pluginId: "cache-stats",
    view: { type: "status", tone: "success", text: "healthy" },
  });
  const view = webPluginsStore.getView("host-session", "cache-stats");
  assert.ok(view);
  assert.equal(view.type, "status");
});

test("attachSessionPlugins cleanup detaches the session bus", () => {
  const { detach, bus } = attach("detach-session");
  bus.emit?.(WEB_PLUGIN_VIEW_EVENT, {
    pluginId: "todo",
    view: { type: "status", tone: "accent", text: "seeded" },
  });
  assert.ok(webPluginsStore.getView("detach-session", "todo"));

  detach();
  assert.equal(relayActionRequest("detach-session", "todo", "sync").relayed, false);
});

test("relayActionRequest emits the request on the session bus", () => {
  const { emissions } = attach("relay-session");
  const result = relayActionRequest("relay-session", "subagent-monitor", "request-sync", "req-42");
  assert.deepEqual(result, { relayed: true });

  const request = emissions.find((e) => e.ch === WEB_PLUGIN_ACTION_REQUEST_EVENT);
  assert.ok(request, "action request must be emitted");
  assert.deepEqual(request.data, {
    requestId: "req-42",
    sessionId: "relay-session",
    pluginId: "subagent-monitor",
    actionId: "request-sync",
  });

  assert.equal(relayActionRequest("no-bus-session", "todo", "sync").relayed, false);
});

test("checkAndSetInFlightAction bounds one in-flight action per session", () => {
  assert.equal(checkAndSetInFlightAction("sess-1", "req-1", 60_000), true);
  assert.equal(checkAndSetInFlightAction("sess-1", "req-2", 60_000), false);
  assert.equal(checkAndSetInFlightAction("sess-2", "req-3", 60_000), true);

  webPluginsStore.inFlightActions.set("sess-3", { requestId: "old", expiresAt: Date.now() - 1000 });
  assert.equal(checkAndSetInFlightAction("sess-3", "new", 60_000), true);
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
  checkAndSeedFixtures();
  const session = "__test_session__";
  assert.ok(webPluginsStore.getView(session, "cache-stats"), "cache-stats kv view seeded");
  assert.ok(webPluginsStore.getView(session, "todo"), "todo list view seeded");
  const graph = webPluginsStore.getView(session, "subagent-monitor");
  assert.ok(graph && graph.type === "graph", "monitor graph seeded");
  assert.equal(isKnownSession(session), true);

  // The seeded bus records action requests as graph updates with the request id.
  const bus = webPluginsStore.sessionBuses.get(session);
  assert.ok(bus && typeof bus.emit === "function", "fixture bus present");
  bus.emit?.(WEB_PLUGIN_ACTION_REQUEST_EVENT, { requestId: "custom-req" });
  const updated = webPluginsStore.getView(session, "subagent-monitor");
  assert.ok(updated && updated.type === "graph");
  const labeled = updated.nodes.find((node) => node.id === "child:worker-slots");
  assert.ok(labeled?.label.includes("custom-req"), "request id flows into the graph label");
});

test("getPluginDescriptor resolves inline plugins", () => {
  assert.equal(getPluginDescriptor("todo")?.id, "todo");
  assert.equal(getPluginDescriptor("cache-stats")?.extension, "cache-stats");
  assert.equal(getPluginDescriptor("never-heard-of"), undefined);
});
