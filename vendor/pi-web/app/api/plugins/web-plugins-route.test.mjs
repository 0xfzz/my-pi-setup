import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { GET } = await jiti.import("./route.ts");
const { webPluginsStore } = await jiti.import("@/lib/web-plugins-host.ts");

test("GET /api/plugins without cwd returns workflow plugins and views with no-store cache", async () => {
  webPluginsStore.clear();
  webPluginsStore.recordView("session-test-1", "cache-stats", {
    type: "status",
    tone: "accent",
    text: "Operational",
  });

  const response = await GET(new Request("http://localhost/api/plugins"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");

  const body = await response.json();
  assert.ok(Array.isArray(body.plugins), "plugins is an array");
  const cacheStats = body.plugins.find((p) => p.id === "cache-stats");
  assert.ok(cacheStats, "cache-stats plugin is listed");
  assert.equal(cacheStats.title, "Cache health");

  assert.ok(body.views, "views object is returned");
  assert.ok(body.views["session-test-1"], "session-test-1 exists in views");
  assert.equal(body.views["session-test-1"]["cache-stats"].type, "status");
  assert.equal(body.views["session-test-1"]["cache-stats"].text, "Operational");
});
