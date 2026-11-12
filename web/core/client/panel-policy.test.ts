import test from "node:test";
import assert from "node:assert/strict";
import type { WebPluginDescriptor, WebView } from "./plugin-system/contract.ts";
import { availablePanelPlugins, isPanelPlugin } from "./plugin-system/panel-policy.ts";

function pluginWith(surfaces: WebPluginDescriptor["surfaces"]): WebPluginDescriptor {
  return { id: "fixture", title: "Fixture", extension: "fixture", surfaces };
}

const status: WebView = { type: "status", tone: "neutral", text: "Ready" };

test("sidebar, center and floating plugins belong to the panel rather than the transcript", () => {
  for (const surfaces of [
    [{ kind: "sidebar" }],
    [{ kind: "slot", slot: "center" }],
    [{ kind: "slot", slot: "floating" }],
    [{ kind: "sidebar" }, { kind: "slot", slot: "top" }],
  ] satisfies WebPluginDescriptor["surfaces"][]) {
    assert.equal(isPanelPlugin(pluginWith(surfaces)), true);
  }
});

test("standalone strips, pages and overrides keep their inline placements", () => {
  for (const surfaces of [
    [],
    [{ kind: "slot", slot: "top" }],
    [{ kind: "slot", slot: "bottom" }],
    [{ kind: "page", path: "/plugins/fixture" }],
    [{ kind: "override", region: "composer" }],
  ] satisfies WebPluginDescriptor["surfaces"][]) {
    assert.equal(isPanelPlugin(pluginWith(surfaces)), false);
  }
});

test("navbar buttons appear only for panel plugins with a published view", () => {
  const panel = pluginWith([{ kind: "sidebar" }]);
  assert.deepEqual(availablePanelPlugins([], {}), []);
  assert.deepEqual(availablePanelPlugins([panel], null), []);
  assert.deepEqual(availablePanelPlugins([panel], {}), []);
  assert.deepEqual(availablePanelPlugins([panel], { fixture: status }), [panel]);
  assert.deepEqual(availablePanelPlugins([pluginWith([{ kind: "slot", slot: "top" }])], { fixture: status }), []);
});

test("a plugin with multiple sidebar placements gets exactly one navbar button", () => {
  const panel = pluginWith([{ kind: "sidebar" }, { kind: "slot", slot: "floating" }]);
  assert.deepEqual(availablePanelPlugins([panel], { fixture: status }), [panel]);
});

test("navbar ordering follows the registry and excludes dialogs", () => {
  const first = pluginWith([{ kind: "sidebar" }]);
  const second = { ...first, id: "second" };
  const dialog: WebView = { type: "dialog", title: "Question", open: true };
  assert.deepEqual(availablePanelPlugins([first, second], { fixture: status, second: status }), [first, second]);
  assert.deepEqual(availablePanelPlugins([first, second], { fixture: dialog, second: status }), [second]);
});
