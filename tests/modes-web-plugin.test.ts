import test from "node:test";
import assert from "node:assert/strict";

import { MODES_LEAVE_PLAN_ACTION, MODES_PLUGIN_ID, modeWebView } from "../lib/modes-web-view.ts";
import { WEB_PLUGIN_VIEW_EVENT, validateView } from "../lib/web-plugins/view.ts";
import { publishWebView } from "../lib/web-plugins/publisher.ts";
import { validatePlugin, type WebPluginDescriptor } from "../lib/web-plugins/descriptor.ts";
import { validateRegistry } from "../lib/web-plugins/registry.ts";
import { WEB_PLUGINS, WEB_PLUGIN_OPT_OUT } from "../web-plugins/index.ts";
import { modesPlugin } from "../web-plugins/modes.ts";

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
  const known = ["modes.ts", "todo.ts"];
  const result = validatePlugin(modesPlugin, known);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  assert.deepEqual(modesPlugin.actions?.map((a) => a.id), [MODES_LEAVE_PLAN_ACTION]);
  assert.deepEqual(modesPlugin.ui?.map((c) => [c.component, c.view, c.placement]), [
    ["ui.plugin-view.v1", "modes", { kind: "anchor", anchor: "chat.composer", order: -1 }],
  ]);
  assert.deepEqual(validateRegistry(WEB_PLUGINS), []);
  assert.ok(WEB_PLUGINS.some((p: WebPluginDescriptor) => p.id === "modes"));
});

test("modes is no longer an opt-out, and every extension still appears exactly once", () => {
  assert.equal(Object.hasOwn(WEB_PLUGIN_OPT_OUT, "modes"), false);
  const ids = WEB_PLUGINS.map((p) => p.extension);
  assert.equal(new Set(ids).size, ids.length, "each descriptor's extension appears once");
});
