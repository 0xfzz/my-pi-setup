import test from "node:test";
import assert from "node:assert/strict";
import { resolveRegionOverrides } from "./regions.ts";
import type { WebPluginDescriptor, WebPluginRegion } from "../../../lib/web-plugins/descriptor.ts";
import type { WebView } from "../../../lib/web-plugins/view.ts";

function overridePlugin(id: string, region: WebPluginRegion): WebPluginDescriptor {
  return {
    id,
    extension: id,
    title: id,
    surfaces: [{ kind: "override", region }],
  };
}

function statusView(text: string): WebView {
  return { type: "status", tone: "neutral", text };
}

test("a published view overrides its region; absent views do not", () => {
  const plugin = overridePlugin("alpha", "composer");
  const withView = resolveRegionOverrides([plugin], { alpha: statusView("replaced") });
  assert.deepEqual(withView.regions.composer, {
    pluginId: "alpha",
    view: statusView("replaced"),
  });
  assert.deepEqual(withView.conflicts, []);

  assert.deepEqual(resolveRegionOverrides([plugin], {}).regions, {});
  assert.deepEqual(resolveRegionOverrides([plugin], null).regions, {});
  assert.deepEqual(resolveRegionOverrides([plugin], undefined).regions, {});
});

test("the last plugin in registry order wins and conflicts are reported", () => {
  const first = overridePlugin("alpha", "status");
  const second = overridePlugin("beta", "status");
  const result = resolveRegionOverrides(
    [first, second],
    { alpha: statusView("a"), beta: statusView("b") },
  );
  assert.equal(result.regions.status?.pluginId, "beta");
  assert.deepEqual(result.conflicts, [{ region: "status", pluginIds: ["alpha", "beta"] }]);
});

test("only the plugin with a view participates in a conflict", () => {
  const first = overridePlugin("alpha", "header");
  const second = overridePlugin("beta", "header");
  // beta declares the override but publishes nothing: no conflict, no winner.
  const result = resolveRegionOverrides([first, second], { alpha: statusView("a") });
  assert.equal(result.regions.header?.pluginId, "alpha");
  assert.deepEqual(result.conflicts, []);
});

test("plugins without override surfaces are ignored", () => {
  const plugin: WebPluginDescriptor = {
    id: "slotly",
    extension: "slotly",
    title: "Slotly",
    surfaces: [{ kind: "slot", slot: "top" }],
  };
  const result = resolveRegionOverrides([plugin], { slotly: statusView("s") });
  assert.deepEqual(result.regions, {});
  assert.deepEqual(result.conflicts, []);
});

test("different regions never conflict", () => {
  const alpha = overridePlugin("alpha", "header");
  const beta = overridePlugin("beta", "composer");
  const result = resolveRegionOverrides(
    [alpha, beta],
    { alpha: statusView("a"), beta: statusView("b") },
  );
  assert.equal(result.regions.header?.pluginId, "alpha");
  assert.equal(result.regions.composer?.pluginId, "beta");
  assert.deepEqual(result.conflicts, []);
});
