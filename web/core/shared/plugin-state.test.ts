import test from "node:test";
import assert from "node:assert/strict";
import { pluginStateFrameOf } from "./plugin-state.ts";

test("a plugin_state message is read into the declared frame", () => {
  const frame = pluginStateFrameOf({
    type: "plugin_state",
    revision: 7,
    views: { todo: { type: "list", items: ["one"] } },
    working: { message: "Working", visible: true, frames: null, intervalMs: 80 },
    running: true,
    statuses: { build: "green" },
    widgets: { w: { lines: ["line"], placement: "aboveEditor" } },
    custom: { c: { method: "custom", lines: ["panel"] } },
    notifications: [{ id: "n", message: "saved", level: "info", timestamp: 1 }],
  });

  assert.equal(frame?.revision, 7);
  assert.deepEqual(frame?.views.todo, { type: "list", items: ["one"] });
  assert.equal(frame?.working?.message, "Working");
  assert.equal(frame?.running, true);
  assert.deepEqual(frame?.statuses, { build: "green" });
  assert.deepEqual(frame?.widgets.w, { lines: ["line"], placement: "aboveEditor" });
  assert.deepEqual(frame?.custom.c, { method: "custom", lines: ["panel"] });
  assert.equal(frame?.notifications.length, 1);
});

test("a message of another type is not a plugin_state frame", () => {
  assert.equal(pluginStateFrameOf({ type: "message_start" }), undefined);
  assert.equal(pluginStateFrameOf({}), undefined);
});

test("a partial frame falls back to empty values instead of blanking the UI", () => {
  const frame = pluginStateFrameOf({ type: "plugin_state" });
  assert.deepEqual(frame, {
    type: "plugin_state",
    revision: 0,
    views: {},
    working: null,
    running: false,
    statuses: {},
    widgets: {},
    custom: {},
    notifications: [],
  });
});

test("malformed containers are treated as absent, not as data", () => {
  const frame = pluginStateFrameOf({
    type: "plugin_state",
    revision: "7",
    views: [],
    statuses: null,
    notifications: "none",
    running: "true",
  });
  assert.equal(frame?.revision, 0);
  assert.deepEqual(frame?.views, {});
  assert.deepEqual(frame?.statuses, {});
  assert.deepEqual(frame?.notifications, []);
  assert.equal(frame?.running, false, "only a literal true means running");
});
