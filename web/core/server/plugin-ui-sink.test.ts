import test from "node:test";
import assert from "node:assert/strict";

import { createPluginUiSink } from "./plugin-ui-sink.ts";
import { webUiStore } from "./ui-store.ts";
import type { WebUiType } from "../plugin-contracts/ui-event-models.ts";

const sink = createPluginUiSink();

test.afterEach(() => {
  webUiStore.clear();
});

function session(sessionId: string) {
  return webUiStore.snapshot().sessions[sessionId];
}

test("a plugin view is validated and stored under the plugin's id", () => {
  assert.equal(
    sink.publish("s1", "ui.view.changed", { pluginId: "activity", view: { type: "status", tone: "accent", text: "live" } }, "activity"),
    true,
  );
  assert.deepEqual(session("s1")?.views.activity, { type: "status", tone: "accent", text: "live" });
});

test("a view the contract rejects never reaches the store", () => {
  assert.equal(
    sink.publish("s1", "ui.view.changed", { pluginId: "activity", view: { type: "status", tone: "loud", text: "x" } }, "activity"),
    false,
  );
  assert.equal(session("s1")?.views.activity, undefined);
});

test("a plugin can publish a notification, a status line and widget lines", () => {
  assert.equal(sink.publish("s1", "ui.notify", { message: "indexed 4 files", level: "info" }, "activity"), true);
  assert.equal(sink.publish("s1", "ui.status.changed", { key: "activity", text: "3 tools" }, "activity"), true);
  assert.equal(
    sink.publish("s1", "ui.widget.changed", { key: "activity", lines: ["a"], placement: "belowEditor" }, "activity"),
    true,
  );
  const state = session("s1");
  assert.deepEqual(state?.notifications.map((entry) => entry.message), ["indexed 4 files"]);
  assert.equal(state?.statuses.activity, "3 tools");
  assert.deepEqual(state?.widgets.activity, { lines: ["a"], placement: "belowEditor" });
});

test("host-owned state is refused with a named diagnostic, never applied", () => {
  const reserved: WebUiType[] = [
    "ui.session.lifecycle",
    "ui.title.changed",
    "ui.editor.changed",
    "ui.layout.changed",
    "ui.plugin.action-requested",
    "ui.custom.changed",
    "ui.working.changed",
  ];
  for (const type of reserved) {
    assert.equal(sink.publish("s1", type, { running: true }, "activity"), false, type);
  }
  // Nothing was admitted, so the session was never created: a plugin cannot
  // claim the session is running or retitle it, because it cannot write at all.
  assert.equal(session("s1"), undefined);
  const diagnostics = webUiStore.snapshot().diagnostics;
  assert.equal(diagnostics.length, reserved.length);
  assert.match(diagnostics[0]?.message ?? "", /plugins cannot publish ui\.session\.lifecycle/);
});

test("the plugin id is the source key, so the store's per-producer limits apply to it", () => {
  sink.publish("s1", "ui.status.changed", { key: "activity", text: "3 tools" }, "activity");
  // A second plugin publishing its own status is a different producer, and
  // both keys survive: namespacing is what keeps them apart.
  sink.publish("s1", "ui.status.changed", { key: "other", text: "2 files" }, "other");
  assert.deepEqual(session("s1")?.statuses, { activity: "3 tools", other: "2 files" });
});
