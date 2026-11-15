import test from "node:test";
import assert from "node:assert/strict";

import { MODES_LEAVE_PLAN_ACTION, MODES_PLUGIN_ID, MODES_TOGGLE_MODE_ACTION, modeWebView } from "../web/plugins/modes/contract.ts";
import { WEB_PLUGIN_VIEW_EVENT, validateView } from "../web/core/plugin-contracts/view.ts";
import { publishWebView } from "../web/core/plugin-contracts/publisher.ts";
import { validatePlugin, type WebPluginDescriptor } from "../web/core/plugin-contracts/descriptor.ts";
import { validateRegistry } from "../web/core/plugin-contracts/registry.ts";
import { WEB_PLUGINS, WEB_PLUGIN_OPT_OUT } from "../web/plugins/index.ts";
import { modesPlugin } from "../web/plugins/modes/descriptor.ts";

const normal = { id: "normal", label: "Normal", summary: "AI chat & tools" };
const plan = { id: "plan", label: "Plan", summary: "Read; artifacts RW" };

test("the plan view is a warning status and the normal view is neutral", () => {
  const planView = modeWebView(plan);
  const normalView = modeWebView(normal);
  assert.deepEqual(planView, {
    type: "status",
    tone: "warning",
    text: "Plan mode: read-only; writes only to artifacts",
  });
  assert.deepEqual(normalView, { type: "status", tone: "neutral", text: "Normal mode: AI chat & tools" });
  assert.equal(validateView(planView).ok, true);
  assert.equal(validateView(normalView).ok, true);
});

test("publishing the mode view emits the standard view event under the modes plugin id", () => {
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const result = publishWebView({ events: { emit: (channel, data) => emitted.push({ channel, data }) } }, MODES_PLUGIN_ID, modeWebView(plan));
  assert.equal(result.ok, true);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].channel, WEB_PLUGIN_VIEW_EVENT);
  assert.deepEqual(emitted[0].data, { pluginId: "modes", view: modeWebView(plan) });
});

test("the modes descriptor is valid, declares the leave-plan action, and is registered", () => {
  const result = validatePlugin(modesPlugin);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  assert.deepEqual(modesPlugin.actions?.map((a) => a.id), [MODES_TOGGLE_MODE_ACTION, MODES_LEAVE_PLAN_ACTION]);
  const toggle = modesPlugin.actions?.find((a) => a.id === MODES_TOGGLE_MODE_ACTION);
  assert.equal(toggle?.confirm, undefined, "switch mode is the instant form: no typed confirmation");
  assert.equal(toggle?.keybinding, "Alt+M");
  const leave = modesPlugin.actions?.find((a) => a.id === MODES_LEAVE_PLAN_ACTION);
  assert.equal(leave?.confirm, "leave plan mode", "leaving Plan mode keeps its typed confirmation");
  assert.deepEqual(modesPlugin.ui?.map((c) => [c.component, c.view, c.placement]), [
    ["ui.plugin-view.v1", "modes", { kind: "anchor", anchor: "chat.composer", order: -1 }],
  ]);
  assert.deepEqual(validateRegistry(WEB_PLUGINS), []);
  assert.ok(WEB_PLUGINS.some((p: WebPluginDescriptor) => p.id === "modes"));
});

test("modes is no longer an opt-out", () => {
  assert.equal(Object.hasOwn(WEB_PLUGIN_OPT_OUT, "modes"), false);
});

test("an extension may declare more than one plugin, but no extension appears in both lists", () => {
  // The router is the worked example: one extension, two plugins (a sidebar
  // panel and its editor dialog), because a host keeps one view per plugin id.
  const ids = WEB_PLUGINS.map((p) => p.extension);
  assert.ok(ids.filter((id) => id === "account-router").length >= 2,
    "the router extension legitimately ships two plugins");
  // The enforcement rule is unchanged: an extension is either bridged or opted
  // out, never both, and never neither.
  assert.equal(Object.hasOwn(WEB_PLUGIN_OPT_OUT, "account-router"), false);
});
