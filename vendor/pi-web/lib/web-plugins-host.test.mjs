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
