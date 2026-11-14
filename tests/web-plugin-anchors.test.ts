// Anchor mounting and component overrides on the client.
//
// The failure mode being pinned: plugins declared `ui[]` anchor placements and
// `override` blocks that the shell validated and then never mounted, so the
// declarations were dead metadata. These tests fix the mounting rules — order,
// visibility, one-home-per-view — without needing a browser.

import test from "node:test";
import assert from "node:assert/strict";

import {
  anchorEntries,
  anchorSuppression,
  regionOverrideOwners,
} from "../web/core/client/plugin-system/anchor-policy.ts";
import { overrideEntries } from "../web/core/client/plugin-system/override-policy.ts";
import { resolveOverrides, type WebPluginUiContribution } from "../web/core/plugin-contracts/ui-contracts.ts";
import type { WebPluginDescriptor, WebView } from "../web/core/client/plugin-system/contract.ts";

const status: WebView = { type: "status", tone: "accent", text: "Plan" };
const other: WebView = { type: "status", tone: "neutral", text: "Normal" };

function plugin(
  id: string,
  ui: WebPluginUiContribution[],
  surfaces: WebPluginDescriptor["surfaces"] = [{ kind: "sidebar" }],
): WebPluginDescriptor {
  return { id, title: id, extension: id, surfaces, ui };
}

function anchored(id: string, anchor: string, extra: Partial<WebPluginUiContribution> = {}): WebPluginUiContribution {
  return {
    id,
    component: "ui.plugin-view.v1",
    scope: "session",
    placement: { kind: "anchor", anchor: anchor as never },
    ...extra,
  };
}

test("an anchor mounts exactly the contributions that asked for it", () => {
  const plugins = [
    plugin("modes", [anchored("mode", "chat.composer")]),
    plugin("title", [anchored("title", "session.header")]),
  ];
  const views = { modes: status, title: other };

  assert.deepEqual(
    anchorEntries(plugins, views, { anchor: "chat.composer" }).map((entry) => entry.pluginId),
    ["modes"],
  );
  assert.deepEqual(anchorEntries(plugins, views, { anchor: "chat.working" }), []);
});

test("a plugin without a published view mounts nothing", () => {
  const plugins = [plugin("modes", [anchored("mode", "chat.composer")])];
  assert.deepEqual(anchorEntries(plugins, {}, { anchor: "chat.composer" }), []);
  assert.deepEqual(anchorEntries(plugins, null, { anchor: "chat.composer" }), []);
});

test("dialogs never mount at an anchor — the dialog layer owns them", () => {
  const plugins = [plugin("ask", [anchored("dialog", "viewport.overlay")])];
  const views = { ask: { type: "dialog", title: "Question", open: true } as WebView };
  assert.deepEqual(anchorEntries(plugins, views, { anchor: "viewport.overlay" }), []);
});

test("ordering is order, then priority, then plugin id", () => {
  const plugins = [
    plugin("c", [anchored("x", "chat.composer", { placement: { kind: "anchor", anchor: "chat.composer", order: 2 } })]),
    plugin("a", [anchored("x", "chat.composer", { priority: 5 })]),
    plugin("b", [anchored("x", "chat.composer")]),
  ];
  const views = { a: status, b: status, c: status };
  assert.deepEqual(
    anchorEntries(plugins, views, { anchor: "chat.composer" }).map((entry) => entry.pluginId),
    ["a", "b", "c"],
    "higher priority first, then the plugin id; an explicit order sorts last",
  );

  const ordered = [
    plugin("late", [anchored("x", "chat.composer", { placement: { kind: "anchor", anchor: "chat.composer", order: 1 } })]),
    plugin("early", [anchored("x", "chat.composer", { placement: { kind: "anchor", anchor: "chat.composer", order: -1 } })]),
  ];
  assert.deepEqual(
    anchorEntries(ordered, { late: status, early: status }, { anchor: "chat.composer" }).map((entry) => entry.pluginId),
    ["early", "late"],
  );
});

test("visibleWhen running/idle follows the session state", () => {
  const plugins = [
    plugin("running-only", [anchored("x", "chat.working", { visibleWhen: "running" })]),
    plugin("idle-only", [anchored("y", "chat.working", { visibleWhen: "idle" })]),
    plugin("always", [anchored("z", "chat.working")]),
  ];
  const views = { "running-only": status, "idle-only": status, always: status };

  assert.deepEqual(
    anchorEntries(plugins, views, { anchor: "chat.working", running: true }).map((entry) => entry.pluginId),
    ["always", "running-only"],
  );
  assert.deepEqual(
    anchorEntries(plugins, views, { anchor: "chat.working", running: false }).map((entry) => entry.pluginId),
    ["always", "idle-only"],
  );
});

test("a plugin whose view already renders elsewhere is suppressed", () => {
  const plugins = [plugin("modes", [anchored("mode", "chat.composer")])];
  const views = { modes: status };
  const suppressed = anchorSuppression(new Set(["other"]), ["modes"]);
  assert.deepEqual(anchorEntries(plugins, views, { anchor: "chat.composer", suppressed }), []);
});

test("regionOverrideOwners reads the winning plugin ids out of the region map", () => {
  const owners = regionOverrideOwners({
    composer: { pluginId: "example-override" },
    header: undefined,
  });
  assert.deepEqual([...owners], ["example-override"]);
});

test("anchorSuppression merges region owners and panel plugins without duplicates", () => {
  const suppressed = anchorSuppression(new Set(["a"]), ["a", "b"]);
  assert.deepEqual([...suppressed].sort(), ["a", "b"]);
});

test("overrideEntries attributes each override contribution to its plugin", () => {
  const plugins = [
    plugin("bubbly-spinner", [
      {
        id: "working",
        component: "ui.working-indicator.v1",
        scope: "session",
        placement: { kind: "anchor", anchor: "chat.working" },
        priority: 5,
        override: { target: "ui.working-indicator.v1", mode: "wrap", fallback: "builtin" },
      },
    ]),
    plugin("unrelated", [anchored("x", "chat.composer")]),
  ];
  const entries = overrideEntries(plugins, "ui.working-indicator.v1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].pluginId, "bubbly-spinner");
  assert.equal(entries[0].contribution.override?.mode, "wrap");
  assert.deepEqual(overrideEntries(plugins, "ui.extension-status.v1"), []);
});

test("an override with no competing contribution resolves to nothing, so the built-in stays", () => {
  const resolved = resolveOverrides("ui.working-indicator.v1", []);
  assert.equal(resolved.replacement, undefined);
  assert.deepEqual(resolved.wrappers, []);
  assert.equal(resolved.hidden, false);
});

test("a replace override wins over a wrap, and hide suppresses the built-in", () => {
  const wrap = overrideEntries(
    [plugin("wrap", [{ ...anchored("w", "chat.working"), override: { target: "ui.working-indicator.v1", mode: "wrap", fallback: "builtin" } }])],
    "ui.working-indicator.v1",
  );
  const replace = overrideEntries(
    [plugin("replace", [{ ...anchored("r", "chat.working"), priority: 1, override: { target: "ui.working-indicator.v1", mode: "replace", fallback: "builtin" } }])],
    "ui.working-indicator.v1",
  );
  const resolved = resolveOverrides("ui.working-indicator.v1", [...wrap, ...replace]);
  assert.equal(resolved.replacement?.pluginId, "replace");
  assert.deepEqual(resolved.wrappers.map((entry) => entry.pluginId), ["wrap"]);

  const hidden = resolveOverrides("ui.working-indicator.v1", [
    ...overrideEntries(
      [plugin("hide", [{ ...anchored("h", "chat.working"), override: { target: "ui.working-indicator.v1", mode: "hide", fallback: "builtin" } }])],
      "ui.working-indicator.v1",
    ),
  ]);
  assert.equal(hidden.hidden, true);
});
