// Slot policy: the host applies a plugin's declared placement within its own
// ceilings. Each test names the failure it guards.

import test from "node:test";
import assert from "node:assert/strict";
import type { WebPluginDescriptor, WebPluginUiContribution, WebView } from "./plugin-system/contract.ts";
import { NARROW_VIEWPORT_PX, compactSummary, slotPolicy, startsCollapsed } from "./plugin-system/slot-policy.ts";

function pluginWith(ui: WebPluginUiContribution[] | undefined): WebPluginDescriptor {
  return {
    id: "fixture",
    extension: "fixture",
    title: "Fixture",
    surfaces: [],
    ...(ui !== undefined ? { ui } : {}),
  } as WebPluginDescriptor;
}

interface PlacementHints {
  collision?: "stack" | "shrink" | "hide";
  maxHeight?: number;
  maxWidth?: number;
}

function regionContribution(
  region: "top" | "center" | "bottom" | "floating",
  options: { strategy?: "default" | "compact" | "card"; placement?: PlacementHints } = {},
): WebPluginUiContribution {
  return {
    id: `${region}-view`,
    component: "ui.plugin-view.v1",
    scope: "session",
    ...(options.strategy !== undefined ? { strategy: options.strategy } : {}),
    placement: { kind: "region", region, ...options.placement },
  };
}

test("a plugin without a ui contribution keeps the stacked, full-height default", () => {
  assert.deepEqual(slotPolicy(pluginWith(undefined), "center"), {
    compact: false,
    collision: "stack",
    bodyMaxHeight: 240,
    cardMaxWidth: 320,
  });
});

test("a compact strategy asks for one summary line in any slot", () => {
  const plugin = pluginWith([regionContribution("center", { strategy: "compact" })]);
  assert.equal(slotPolicy(plugin, "center").compact, true);
});

test("a card strategy keeps the full view rather than the compact line", () => {
  const plugin = pluginWith([regionContribution("center", { strategy: "card" })]);
  assert.equal(slotPolicy(plugin, "center").compact, false);
});

test("a contribution for another region does not change this slot", () => {
  const plugin = pluginWith([regionContribution("top", { strategy: "compact", placement: { collision: "hide" } })]);
  assert.deepEqual(slotPolicy(plugin, "center"), slotPolicy(pluginWith(undefined), "center"));
});

test("the declared collision behaviour reaches the slot", () => {
  const plugin = pluginWith([regionContribution("bottom", { placement: { collision: "hide" } })]);
  assert.equal(slotPolicy(plugin, "bottom").collision, "hide");
});

test("a height hint below the host ceiling is applied as asked", () => {
  const plugin = pluginWith([regionContribution("floating", { placement: { maxHeight: 200 } })]);
  assert.equal(slotPolicy(plugin, "floating").bodyMaxHeight, 200);
});

test("a height hint above the host ceiling is clamped, never honoured", () => {
  const plugin = pluginWith([regionContribution("floating", { placement: { maxHeight: 5000 } })]);
  assert.equal(slotPolicy(plugin, "floating").bodyMaxHeight, 360);
});

test("a width hint above the host ceiling is clamped to the card ceiling", () => {
  const plugin = pluginWith([regionContribution("floating", { placement: { maxWidth: 900 } })]);
  assert.equal(slotPolicy(plugin, "floating").cardMaxWidth, 400);
});

test("a floating card without a height hint gets the floating default, not the centre default", () => {
  assert.equal(slotPolicy(pluginWith(undefined), "floating").bodyMaxHeight, 380);
});

test("compact summary: a status view shows its text", () => {
  const view: WebView = { type: "status", tone: "accent", text: "3 running" };
  assert.equal(compactSummary(view), "3 running");
});

test("compact summary: an empty key-value view shows nothing", () => {
  assert.equal(compactSummary({ type: "kv", rows: [] }), "");
});

test("compact summary: a key-value view shows its first row", () => {
  assert.equal(compactSummary({ type: "kv", rows: [{ label: "Active", value: "worker" }] }), "Active: worker");
});

test("compact summary: a list counts its items and quotes the first", () => {
  const view: WebView = { type: "list", items: [{ text: "port slots" }, "verify"] };
  assert.equal(compactSummary(view), "2 items (port slots)");
});

test("compact summary: a single-item list uses the singular", () => {
  assert.equal(compactSummary({ type: "list", items: ["only"] }), "1 item (only)");
});

test("compact summary: a graph reports its node count instead of going blank", () => {
  const view: WebView = { type: "graph", nodes: [{ id: "a", label: "A", kind: "parent" }], edges: [] };
  assert.equal(compactSummary(view), "1 node");
});

test("phones start centre cards folded and wider screens start them open", () => {
  assert.equal(startsCollapsed(390), true, "a phone folds its cards to keep the chat");
  assert.equal(startsCollapsed(NARROW_VIEWPORT_PX), true, "the breakpoint itself is a phone");
  assert.equal(startsCollapsed(NARROW_VIEWPORT_PX + 1), false, "just above the breakpoint stays open");
});
