import test from "node:test";
import assert from "node:assert/strict";
import type { WebPluginDescriptor, WebView } from "./plugin-system/contract.ts";
import { availablePanelPlugins, isPanelPlugin } from "./plugin-system/panel-policy.ts";

function pluginWith(surfaces: WebPluginDescriptor["surfaces"]): WebPluginDescriptor {
  return { id: "fixture", title: "Fixture", extension: "fixture", surfaces };
}

const status: WebView = { type: "status", tone: "neutral", text: "Ready" };

test("a sidebar surface makes a plugin a panel", () => {
  assert.equal(isPanelPlugin(pluginWith([{ kind: "sidebar" }])), true);
  assert.equal(isPanelPlugin(pluginWith([{ kind: "sidebar" }, { kind: "page", path: "/plugins/fixture" }])), true);
});

test("strips, pages, dialogs and overrides are not panels", () => {
  for (const surfaces of [
    [],
    [{ kind: "page", path: "/plugins/fixture" }],
    [{ kind: "dialog" }],
    [{ kind: "override", region: "composer" }],
  ] satisfies WebPluginDescriptor["surfaces"][]) {
    assert.equal(isPanelPlugin(pluginWith(surfaces)), false, JSON.stringify(surfaces));
  }
});

test("navbar buttons appear only for panel plugins with a published view", () => {
  const panel = pluginWith([{ kind: "sidebar" }]);
  assert.deepEqual(availablePanelPlugins([], {}), []);
  assert.deepEqual(availablePanelPlugins([panel], null), []);
  assert.deepEqual(availablePanelPlugins([panel], {}), []);
  assert.deepEqual(availablePanelPlugins([panel], { fixture: status }), [panel]);
  assert.deepEqual(availablePanelPlugins([pluginWith([{ kind: "page", path: "/plugins/fixture" }])], { fixture: status }), []);
});

test("a panel with several surfaces gets exactly one navbar button", () => {
  const panel = pluginWith([{ kind: "sidebar" }, { kind: "page", path: "/plugins/fixture" }]);
  assert.deepEqual(availablePanelPlugins([panel], { fixture: status }), [panel]);
});

test("navbar ordering follows the registry and excludes dialogs", () => {
  const first = pluginWith([{ kind: "sidebar" }]);
  const second = { ...first, id: "second" };
  const dialog: WebView = { type: "dialog", title: "Question", open: true };
  assert.deepEqual(availablePanelPlugins([first, second], { fixture: status, second: status }), [first, second]);
  assert.deepEqual(availablePanelPlugins([first, second], { fixture: dialog, second: status }), [second]);
});

test("sessionPanel plugins are available whenever a session is selected", () => {
  const sessionPanel: WebPluginDescriptor = {
    id: "files",
    title: "Files",
    extension: "web-core.files",
    surfaces: [{ kind: "sidebar" }],
    sessionPanel: true,
  };
  assert.deepEqual(availablePanelPlugins([sessionPanel], null, false), []);
  assert.deepEqual(availablePanelPlugins([sessionPanel], null, true), [sessionPanel]);
});
