import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const {
  webPluginsStore,
  getRegisteredPlugins,
  getPluginDescriptor,
  attachSessionPlugins,
  checkAndSeedFixtures,
  WEB_PLUGIN_VIEW_EVENT,
  WEB_PLUGIN_ACTION_REQUEST_EVENT,
  relayActionRequest,
  checkAndSetInFlightAction,
  recordActionAudit,
  getActionAuditLog,
  isKnownSession,
  getPluginsRevision,
  subscribePluginChanges,
} = await jiti.import("./web-plugins-host.ts");

test("webPluginsStore records and retrieves valid kv views", () => {
  webPluginsStore.clear();

  const validKv = {
    type: "kv",
    title: "Metrics",
    rows: [
      { label: "Hits", value: "10" },
      { label: "Misses", value: "2" },
    ],
  };

  const ok = webPluginsStore.recordView("sess-1", "cache-stats", validKv);
  assert.equal(ok, true);

  const view = webPluginsStore.getView("sess-1", "cache-stats");
  assert.ok(view);
  assert.equal(view.type, "kv");
  assert.equal(view.title, "Metrics");
  assert.equal(view.rows.length, 2);

  const latest = webPluginsStore.getLatestView("cache-stats");
  assert.deepEqual(latest, view);
});

test("webPluginsStore drops invalid views and does not throw", () => {
  webPluginsStore.clear();

  const badView = {
    type: "unknown-type",
    rows: [],
  };

  const ok = webPluginsStore.recordView("sess-1", "cache-stats", badView);
  assert.equal(ok, false);
  assert.equal(webPluginsStore.getView("sess-1", "cache-stats"), undefined);
});

test("webPluginsStore getAllViews returns nested record of all sessions and plugins", () => {
  webPluginsStore.clear();

  webPluginsStore.recordView("sess-1", "cache-stats", {
    type: "status",
    tone: "success",
    text: "Healthy",
  });
  webPluginsStore.recordView("sess-2", "cache-stats", {
    type: "list",
    title: "Items",
    items: ["item1", "item2"],
  });

  const all = webPluginsStore.getAllViews();
  assert.deepEqual(Object.keys(all).sort(), ["sess-1", "sess-2"]);
  assert.equal(all["sess-1"]["cache-stats"].type, "status");
  assert.equal(all["sess-2"]["cache-stats"].type, "list");
});

test("getRegisteredPlugins lists WEB_PLUGINS including cache-stats", () => {
  const plugins = getRegisteredPlugins();
  assert.ok(Array.isArray(plugins));
  assert.ok(plugins.some((p) => p.id === "cache-stats"));

  const cacheStats = getPluginDescriptor("cache-stats");
  assert.ok(cacheStats);
  assert.equal(cacheStats.extension, "cache-stats");
});

test("attachSessionPlugins listens to web-plugin:view event and stores view", () => {
  webPluginsStore.clear();

  let listener = null;
  const mockEventBus = {
    on(channel, handler) {
      if (channel === WEB_PLUGIN_VIEW_EVENT) {
        listener = handler;
      }
      return () => {
        listener = null;
      };
    },
  };

  let shutdownListener = null;
  const mockWrapper = {
    sessionId: "sess-test-bus",
    inner: {
      resourceLoader: {
        eventBus: mockEventBus,
      },
    },
    onEvent(cb) {
      shutdownListener = cb;
      return () => {
        shutdownListener = null;
      };
    },
  };

  const cleanup = attachSessionPlugins(mockWrapper);
  assert.ok(listener, "registered onEventBus listener");

  // Emit view
  listener({
    pluginId: "cache-stats",
    view: {
      type: "kv",
      rows: [{ label: "Throughput", value: "100req/s" }],
    },
  });

  const recorded = webPluginsStore.getView("sess-test-bus", "cache-stats");
  assert.ok(recorded);
  assert.equal(recorded.rows[0].value, "100req/s");

  // Simulate shutdown
  assert.ok(shutdownListener, "registered onEvent listener");
  shutdownListener({ type: "session_shutdown" });
  assert.equal(listener, null, "unsubscribed on shutdown");
});

test("checkAndSeedFixtures seeds kv view with <script> string when PI_WEB_TEST_PLUGIN_VIEWS=1", () => {
  webPluginsStore.clear();
  const prevEnv = process.env.PI_WEB_TEST_PLUGIN_VIEWS;
  process.env.PI_WEB_TEST_PLUGIN_VIEWS = "1";
  try {
    checkAndSeedFixtures();
    const seeded = webPluginsStore.getView("__test_session__", "cache-stats");
    assert.ok(seeded);
    assert.equal(seeded.type, "kv");
    assert.ok(seeded.rows.some((r) => r.value.includes("<script>")));
  } finally {
    if (prevEnv === undefined) delete process.env.PI_WEB_TEST_PLUGIN_VIEWS;
    else process.env.PI_WEB_TEST_PLUGIN_VIEWS = prevEnv;
  }
});

test("relayActionRequest emits on session bus and returns relayed: true", () => {
  webPluginsStore.clear();

  let emittedChannel = null;
  let emittedData = null;
  const mockEventBus = {
    on() {
      return () => {};
    },
    emit(channel, data) {
      emittedChannel = channel;
      emittedData = data;
    },
  };

  const mockWrapper = {
    sessionId: "sess-action-test",
    inner: {
      resourceLoader: {
        eventBus: mockEventBus,
      },
    },
  };

  attachSessionPlugins(mockWrapper);
  assert.equal(isKnownSession("sess-action-test"), true);

  const result = relayActionRequest("sess-action-test", "dashboard", "request-sync", "custom-req-id");
  assert.equal(result.relayed, true);
  assert.equal(emittedChannel, WEB_PLUGIN_ACTION_REQUEST_EVENT);
  assert.deepEqual(emittedData, {
    requestId: "custom-req-id",
    sessionId: "sess-action-test",
    pluginId: "dashboard",
    actionId: "request-sync",
  });
});

test("relayActionRequest reports relayed: false when no bus is attached (A5)", () => {
  webPluginsStore.clear();
  assert.equal(isKnownSession("sess-no-bus"), false);

  const result = relayActionRequest("sess-no-bus", "dashboard", "request-sync");
  assert.equal(result.relayed, false);
});

test("checkAndSetInFlightAction bounds concurrency to one in-flight per session (A6)", () => {
  webPluginsStore.clear();

  const first = checkAndSetInFlightAction("sess-1", "req-1", 10_000);
  assert.equal(first, true);

  const secondConcurrent = checkAndSetInFlightAction("sess-1", "req-2", 10_000);
  assert.equal(secondConcurrent, false, "Second concurrent request for same session must be rejected");

  const diffSession = checkAndSetInFlightAction("sess-2", "req-3", 10_000);
  assert.equal(diffSession, true, "Different session can run an action concurrently");

  // Expired lock allows subsequent action
  webPluginsStore.inFlightActions.set("sess-expired", {
    requestId: "req-old",
    expiresAt: Date.now() - 1000,
  });
  const expired = checkAndSetInFlightAction("sess-expired", "req-new", 10_000);
  assert.equal(expired, true, "Expired in-flight lock can be acquired");
});

test("audit log records entries and clears with store", () => {
  webPluginsStore.clear();
  assert.equal(getActionAuditLog().length, 0);

  recordActionAudit({
    requestId: "req-1",
    sessionId: "sess-1",
    pluginId: "dashboard",
    actionId: "request-sync",
    timestamp: Date.now(),
  });

  const log = getActionAuditLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].requestId, "req-1");
  assert.equal(log[0].pluginId, "dashboard");

  webPluginsStore.clear();
  assert.equal(getActionAuditLog().length, 0);
});

test("webPluginsStore tracks monotonic revision and asynchronously notifies subscribers on recordView", async () => {
  await Promise.resolve();
  webPluginsStore.clear();

  const initialRev = getPluginsRevision();
  assert.equal(typeof initialRev, "number");

  const seenRevisions = [];
  const unsubscribe = subscribePluginChanges((rev) => {
    seenRevisions.push(rev);
  });

  const ok = webPluginsStore.recordView("sess-rev-1", "cache-stats", {
    type: "status",
    tone: "success",
    text: "Revision test",
  });
  assert.equal(ok, true);

  const newRev = getPluginsRevision();
  assert.ok(newRev > initialRev);
  assert.equal(seenRevisions.length, 0, "producer does not synchronously deliver");
  await Promise.resolve();
  assert.equal(seenRevisions.length, 1);
  assert.equal(seenRevisions[0], newRev);

  // Invalid view should NOT bump revision or notify
  const badOk = webPluginsStore.recordView("sess-rev-1", "cache-stats", { type: "bad" });
  assert.equal(badOk, false);
  assert.equal(getPluginsRevision(), newRev);
  assert.equal(seenRevisions.length, 1);

  // Unsubscribe stops notifications
  unsubscribe();
  const unsubOk = webPluginsStore.recordView("sess-rev-1", "cache-stats", {
    type: "status",
    tone: "neutral",
    text: "Unsubscribed test",
  });
  assert.equal(unsubOk, true);
  assert.equal(getPluginsRevision(), newRev + 1);
  assert.equal(seenRevisions.length, 1, "Unsubscribed listener receives no further calls");
});
