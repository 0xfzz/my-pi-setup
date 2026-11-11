import test from "node:test";
import assert from "node:assert/strict";
import { WebUiStore } from "../lib/web-plugins/ui-state-store.ts";
import { publishWebUi, publishWebView } from "../lib/web-plugins/publisher.ts";
import { WEB_PLUGIN_UI_SYNC_EVENT, WEB_UI_EVENT, extensionUiUpdate, validateWebUiEvent, webUiText } from "../lib/web-plugins/ui-event-models.ts";
import { WEB_PLUGIN_VIEW_EVENT } from "../lib/web-plugins/view.ts";
const event = (sequence: number, payload: unknown, type = "ui.working.changed") => ({ version: 1, eventId: `event-${sequence}`, sessionId: "session-a", source: "extension", sourceKey: "fixture", type, timestamp: Date.now(), sequence, payload });

test("publisher validates declarative data and leaves session/source sequencing to host", () => {
  const emitted: unknown[] = [];
  const target = { events: { emit: (channel: string, payload: unknown) => emitted.push({ channel, payload }) } };
  assert.equal(publishWebUi(target, "fixture", "ui.working.changed", { message: "Working" }).ok, true);
  assert.deepEqual(emitted, [{ channel: WEB_UI_EVENT, payload: { sourceKey: "fixture", type: "ui.working.changed", payload: { message: "Working" } } }]);
  assert.equal(publishWebUi(target, "fixture", "ui.working.changed", { intervalMs: 1 }).ok, false);
  assert.equal(emitted.length, 1);
});

test("UI store: working message, visibility, frames, interval and resets survive validation", async () => {
  const store = new WebUiStore();
  const revisions: number[] = [];
  store.subscribe(r => revisions.push(r));
  assert.equal(store.publish("session-a", "ui.working.changed", { message: "Ratiocinating…" }), true);
  store.publish("session-a", "ui.working.changed", { visible: false });
  store.publish("session-a", "ui.working.changed", { frames: ["·", "●"], intervalMs: 120 });
  assert.deepEqual(store.snapshot().sessions["session-a"].working, { message: "Ratiocinating…", visible: false, frames: ["·", "●"], intervalMs: 120 });
  assert.deepEqual(revisions, [], "delivery cannot block producer");
  await Promise.resolve();
  assert.deepEqual(revisions, [3], "visual notifications coalesce");
  store.publish("session-a", "ui.working.changed", { message: null, visible: true, frames: null, intervalMs: 80 });
  assert.equal(store.snapshot().sessions["session-a"].working.message, null);
  assert.throws(() => { store.snapshot().sessions["session-a"].working.message = "mutated"; });
});

test("UI store: ui.notify toasts are bounded and consecutive duplicates refresh", () => {
  const store = new WebUiStore();
  assert.equal(store.publish("session-a", "ui.notify", { message: "saved", level: "info" }), true);
  assert.equal(store.publish("session-a", "ui.notify", { message: "failed", level: "error" }), true);
  // An identical repeat refreshes the twin instead of stacking.
  assert.equal(store.publish("session-a", "ui.notify", { message: "failed", level: "error" }), true);
  let notifications = store.snapshot().sessions["session-a"].notifications;
  assert.equal(notifications.length, 2);
  assert.deepEqual(
    notifications.map(n => ({ message: n.message, level: n.level })),
    [{ message: "saved", level: "info" }, { message: "failed", level: "error" }],
  );
  // Invalid payloads are rejected, not stored.
  assert.equal(store.publish("session-a", "ui.notify", { message: "x", level: "loud" }), false);
  assert.equal(store.publish("session-a", "ui.notify", { message: "x" }), false);
  // Bounded: a burst keeps only the last 8.
  for (let i = 0; i < 12; i++) store.publish("session-a", "ui.notify", { message: `m${i}`, level: "info" });
  notifications = store.snapshot().sessions["session-a"].notifications;
  assert.equal(notifications.length, 8);
  assert.equal(notifications[notifications.length - 1].message, "m11");
});
test("UI store: sessions, views, status/widget clears and layout revisions are isolated", () => {
  const store = new WebUiStore();
  for (const id of ["a", "b"]) {
    store.publish(id, "ui.working.changed", { message: id });
    store.publish(id, "ui.view.changed", { pluginId: "fixture", view: { type: "status", text: id, tone: "neutral" } });
  }
  assert.equal(store.snapshot().sessions.a.working.message, "a");
  assert.equal(store.snapshot().sessions.b.views.fixture.type, "status");
  store.publish("a", "ui.status.changed", { key: "status", text: "Ready" });
  store.publish("a", "ui.status.changed", { key: "status", text: null });
  store.publish("a", "ui.widget.changed", { key: "widget", lines: ["line"], placement: "belowEditor" });
  store.publish("a", "ui.widget.changed", { key: "widget", lines: null, placement: "aboveEditor" });
  assert.deepEqual(store.snapshot().sessions.a.statuses, {});
  assert.deepEqual(store.snapshot().sessions.a.widgets, {});
  store.publish("a", "ui.layout.changed", { pluginId: "fixture", contributionId: "card", placement: { kind: "anchor", anchor: "chat.composer" } });
  const before = store.snapshot().sessions.a.layouts;
  assert.equal(store.publish("a", "ui.layout.changed", { pluginId: "fixture", contributionId: "card", placement: { kind: "anchor", anchor: "auth" } }), false);
  assert.deepEqual(store.snapshot().sessions.a.layouts, before, "invalid runtime layout preserves last valid placement");
  assert.match(store.snapshot().diagnostics.at(-1)!.message, /ui.layout.changed placement: unknown anchor/);
});
test("UI store: stale/repeated events rejected; replay gaps and server restarts recover full snapshots", () => {
  const store = new WebUiStore({ maxEvents: 2 });
  store.accept(event(2, { message: "newer" }));
  assert.equal(store.accept(event(1, { message: "older" })), false);
  assert.equal(store.accept(event(2, { message: "duplicate" })), false);
  assert.equal(store.snapshot().sessions["session-a"].working.message, "newer");
  assert.ok(store.replay(0).snapshot);
  const cursor = store.snapshot().revision;
  store.publish("session-a", "ui.session.lifecycle", { running: true });
  assert.equal(store.replay(cursor).events.length, 1);
  assert.ok(store.replay(cursor, "previous-process").snapshot);
  store.publish("session-a", "ui.working.changed", { message: "latest" });
  store.publish("session-a", "ui.working.changed", { message: "last" });
  assert.equal(store.replay(cursor).snapshot?.sessions["session-a"].working.message, "last");
});
test("UI events: ANSI/OSC controls normalized, markup inert and unsafe/oversized/flooded payloads rejected", () => {
  assert.equal(webUiText("\x1b[31mred\x1b[0m\x1b]0;title\x07\x00"), "red");
  const valid = validateWebUiEvent(event(1, { message: "<script>alert(1)</script>\x1b[2J" }));
  assert.equal(valid.ok, true);
  if (valid.ok && valid.event.type === "ui.working.changed") assert.equal(valid.event.payload.message, "<script>alert(1)</script>");
  for (const payload of [{ intervalMs: 1 }, { intervalMs: Infinity }, { frames: Array(121).fill("x") }, { frames: ["x".repeat(129)] }, { visible: "false" }, { message: "x".repeat(65537) }, { html: "<b>unsafe</b>" }, JSON.parse('{"__proto__": {"polluted": true}}')]) assert.equal(validateWebUiEvent(event(1, payload)).ok, false);
  const store = new WebUiStore();
  assert.equal(store.accept({ ...event(1, { message: "spoof" }), source: "browser" }), false);
  for (let i = 1; i <= 130; i++) store.accept(event(i, { message: String(i) }));
  assert.ok(store.snapshot().metrics.dropped >= 10);
  assert.match(store.snapshot().diagnostics.at(-1)!.message, /frequency/);
});
test("legacy normalization retains standard status/widget/title/editor/custom semantics", () => {
  const store = new WebUiStore();
  for (const request of [
    { method: "setStatus", statusKey: "ext", statusText: "Ready" },
    { method: "setWidget", widgetKey: "ext", widgetLines: ["A"], widgetPlacement: "aboveEditor" },
    { method: "setTitle", title: "Title" }, { method: "set_editor_text", text: "Draft" },
    { method: "custom", id: "custom-id", lines: ["Custom panel"] },
  ]) {
    const update = extensionUiUpdate(request)!;
    assert.equal(store.publish("session", update.type, update.payload, update.sourceKey), true);
  }
  const state = store.snapshot().sessions.session;
  assert.equal(state.statuses.ext, "Ready"); assert.equal(state.title, "Title"); assert.equal(state.editor, "Draft");
  assert.deepEqual(state.widgets.ext.lines, ["A"]);
  assert.deepEqual(state.custom["custom-id"].lines, ["Custom panel"]);
});

test("publisher remembers the last value and re-emits it on a ui-sync request", () => {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  const emitted: Array<{ channel: string; payload: unknown }> = [];
  const events = {
    emit: (channel: string, payload: unknown) => {
      emitted.push({ channel, payload });
      for (const handler of handlers.get(channel) ?? []) handler(payload);
    },
    on: (channel: string, handler: (data: unknown) => void) => {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
      return () => {};
    },
  };
  const pi = { events };
  const view = { type: "status", tone: "accent", text: "ready" } as const;
  assert.equal(publishWebView(pi, "todo", view).ok, true);
  assert.equal(publishWebUi(pi, "fixture", "ui.status.changed", { key: "s", text: "Ready" }).ok, true);

  events.emit(WEB_PLUGIN_UI_SYNC_EVENT, {});

  const viewReplays = emitted.filter(e => e.channel === WEB_PLUGIN_VIEW_EVENT);
  assert.equal(viewReplays.length, 2, "the original publish plus the replay");
  assert.deepEqual(viewReplays[1].payload, { pluginId: "todo", view });

  const uiReplays = emitted.filter(e => e.channel === WEB_UI_EVENT);
  assert.equal(uiReplays.length, 2, "the original ui publish plus the replay");
  assert.deepEqual(uiReplays[1].payload, { sourceKey: "fixture", type: "ui.status.changed", payload: { key: "s", text: "Ready" } });
});

test("UI store: persistence projection keeps non-dialog views and restores them", () => {
  const store = new WebUiStore();
  assert.equal(store.publish("s1", "ui.view.changed", { pluginId: "modes", view: { type: "status", tone: "accent", text: "plan" } }), true);
  assert.equal(store.publish("s1", "ui.view.changed", { pluginId: "web-core", view: { type: "dialog", lines: ["hi"] } }), true);
  assert.equal(store.publish("s2", "ui.view.changed", { pluginId: "todo", view: { type: "list", title: "Tasks", items: ["a"] } }), true);

  const persisted = store.persistableViews();
  assert.deepEqual(persisted.s1.modes, { type: "status", tone: "accent", text: "plan" });
  assert.equal(persisted.s1["web-core"], undefined, "dialog views are transient, never persisted");
  assert.deepEqual(persisted.s2.todo, { type: "list", title: "Tasks", items: ["a"] });

  const restored = new WebUiStore();
  restored.restoreViews(persisted);
  assert.deepEqual(restored.snapshot().sessions.s1.views.modes, { type: "status", tone: "accent", text: "plan" });
  assert.equal(restored.snapshot().sessions.s1.views["web-core"], undefined);
  assert.deepEqual(restored.snapshot().sessions.s2.views.todo, { type: "list", title: "Tasks", items: ["a"] });
});
