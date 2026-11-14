// The activity plugin, end to end through the kernel: it is discovered from the
// repo tree, activated with its tap + ui.publish grants, and a session event
// that reaches the tap comes out as a browser view and a status line. This is
// the integration proof the unit tests cannot give — that the manifest, the
// descriptor compile, the subscription and the store are wired to each other.

import test from "node:test";
import assert from "node:assert/strict";

import { getPluginHost, registerWebPlugins, visiblePluginsWhenReady } from "./plugin-host.ts";
import { publishSessionTapEvent } from "./session-tap.ts";
import { webUiStore } from "./ui-store.ts";
import { WEB_PLUGINS } from "../../plugins/index.ts";

const host = registerWebPlugins(WEB_PLUGINS);
await host.ready;

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test.afterEach(() => {
  webUiStore.clear();
});

test("the activity plugin is discovered from the repo tree, active, and served with its view", async () => {
  assert.equal(host.manager.isActive("activity"), true);
  const plugins = await visiblePluginsWhenReady(host);
  const activity = plugins.find((plugin) => plugin.id === "activity");
  assert.ok(activity !== undefined, "the manifest's contributes block compiles into a served descriptor");
  assert.equal(activity.title, "Activity");
  assert.deepEqual(activity.ui?.map((contribution) => [contribution.id, contribution.component]), [
    ["recent-tools", "ui.plugin-view.v1"],
  ]);
  assert.equal(activity.ui?.[0]?.placement.kind, "region");
});

test("a tool event through the tap becomes a browser view and a status line", async () => {
  publishSessionTapEvent(host.events, "s-activity", "/repo", {
    type: "tool_execution_start",
    toolCallId: "c1",
    toolName: "bash",
  });
  publishSessionTapEvent(host.events, "s-activity", "/repo", {
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "bash",
  });
  await settle();

  const state = webUiStore.snapshot().sessions["s-activity"];
  const view = state?.views.activity;
  assert.equal(view?.type, "list");
  assert.equal(view?.type === "list" ? view.title : undefined, "Activity");
  const items = view?.type === "list" ? view.items : [];
  assert.equal(items.length, 1);
  const row = items[0];
  assert.equal(typeof row === "object" ? row.status : undefined, "done");
  // The duration is real elapsed time between the two publishes, so match its shape.
  assert.match(typeof row === "object" ? row.text : "", /^bash · \d+ms$/);
  assert.equal(state?.statuses.activity, "1 tool");
});

test("a failed tool is counted in the status line", async () => {
  publishSessionTapEvent(host.events, "s-fail", "/repo", {
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "bash",
    isError: true,
  });
  await settle();
  assert.equal(webUiStore.snapshot().sessions["s-fail"]?.statuses.activity, "1 tool · 1 failed");
});

test("a shutdown clears the status line and forgets the session's activity", async () => {
  publishSessionTapEvent(host.events, "s-gone", "/repo", {
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "bash",
  });
  await settle();
  assert.equal(webUiStore.snapshot().sessions["s-gone"]?.statuses.activity, "1 tool");

  publishSessionTapEvent(host.events, "s-gone", "/repo", { type: "session_shutdown" });
  await settle();
  assert.equal(webUiStore.snapshot().sessions["s-gone"]?.statuses.activity, undefined);
});

test("a message event counts without repainting the panel", async () => {
  publishSessionTapEvent(host.events, "s-msg", "/repo", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
  });
  await settle();
  const state = webUiStore.snapshot().sessions["s-msg"];
  assert.equal(state?.views.activity, undefined, "a message does not publish a view");
  assert.equal(state?.statuses.activity, undefined, "and no tools means no status line");
});

test("a channel with no subscriber in this process still costs nothing", async () => {
  // The tap registry is the only subscriber; publishing an untracked type is a
  // lookup, not a projection. This asserts the observable half: nothing lands.
  publishSessionTapEvent(host.events, "s-quiet", "/repo", { type: "turn_start" });
  await settle();
  assert.equal(webUiStore.snapshot().sessions["s-quiet"], undefined);
  assert.equal(getPluginHost(), host, "one host per process");
});
