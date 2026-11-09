import test from "node:test";
import assert from "node:assert/strict";

import modes from "../extensions/modes.ts";
import { PLAN_MODE_TYPE } from "../lib/plan/plan-mode.ts";
import { WEB_PLUGIN_VIEW_EVENT } from "../lib/web-plugins/view.ts";
import { WEB_PLUGIN_ACTION_REQUEST_EVENT } from "../lib/web-plugins/actions.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;

/**
 * A pi API stand-in: every method the extension does not exercise is a no-op, and the
 * handlers it registers are kept so the test can drive them the way pi would.
 */
function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const eventHandlers = new Map<string, Handler[]>();
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const base: Record<string, unknown> = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    events: {
      on: (channel: string, handler: Handler) => {
        eventHandlers.set(channel, [...(eventHandlers.get(channel) ?? []), handler]);
        return () => undefined;
      },
      emit: (channel: string, data: unknown) => {
        emitted.push({ channel, data });
      },
    },
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: () => undefined,
  };
  const pi = new Proxy(base, {
    get: (target, key: string) => (key in target ? target[key] : () => undefined),
  });
  return { pi, handlers, eventHandlers, emitted };
}

function fakeContext(branch: unknown[]) {
  const notices: string[] = [];
  const ctx = {
    hasUI: false,
    isIdle: () => true,
    sessionManager: { getBranch: () => branch, getHeader: () => undefined, getSessionId: () => "session-1" },
    ui: { notify: (text: string) => notices.push(text), setWidget: () => undefined, getEditorComponent: () => undefined },
  };
  return { ctx, notices };
}

const planBranch = [{ type: "custom", customType: PLAN_MODE_TYPE, data: { enabled: true, previousTools: [] } }];

function viewsFor(emitted: Array<{ channel: string; data: unknown }>) {
  return emitted.filter((e) => e.channel === WEB_PLUGIN_VIEW_EVENT && (e.data as { pluginId: string }).pluginId === "modes");
}

test("a plan-mode session publishes the warning view, and a normal session publishes the neutral one", async () => {
  const planRun = fakePi();
  modes(planRun.pi as never);
  const planCtx = fakeContext(planBranch);
  for (const handler of planRun.handlers.get("session_start") ?? []) await handler({ reason: "startup" }, planCtx.ctx);
  const planViews = viewsFor(planRun.emitted);
  assert.equal(planViews.length, 1);
  assert.equal((planViews[0].data as { view: { tone: string } }).view.tone, "warning");

  const normalRun = fakePi();
  modes(normalRun.pi as never);
  const normalCtx = fakeContext([]);
  for (const handler of normalRun.handlers.get("session_start") ?? []) await handler({ reason: "startup" }, normalCtx.ctx);
  const normalViews = viewsFor(normalRun.emitted);
  assert.equal((normalViews.at(-1)!.data as { view: { tone: string } }).view.tone, "neutral");
});

test("the leave-plan web action returns the session to normal mode, and only for this plugin's action", async () => {
  const run = fakePi();
  modes(run.pi as never);
  const { ctx } = fakeContext(planBranch);
  for (const handler of run.handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
  const [onAction] = run.eventHandlers.get(WEB_PLUGIN_ACTION_REQUEST_EVENT) ?? [];
  assert.ok(onAction, "the modes extension listens for web plugin actions");

  // Another plugin's action is ignored.
  run.emitted.length = 0;
  onAction({ requestId: "r1", pluginId: "todo", actionId: "leave-plan", sessionId: "session-1" });
  assert.equal(run.emitted.length, 0);

  // The leave-plan action leaves Plan mode and publishes the new (neutral) view.
  onAction({ requestId: "r2", pluginId: "modes", actionId: "leave-plan", sessionId: "session-1" });
  const views = viewsFor(run.emitted);
  assert.equal(views.length, 1);
  assert.equal((views[0].data as { view: { tone: string } }).view.tone, "neutral");
});

test("the Alt+M toggle-mode action enters Plan mode and only for this plugin's declared action", async () => {
  const run = fakePi();
  modes(run.pi as never);
  const { ctx } = fakeContext([]);
  for (const handler of run.handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
  const [onAction] = run.eventHandlers.get(WEB_PLUGIN_ACTION_REQUEST_EVENT) ?? [];
  assert.ok(onAction);

  // An action id this plugin does not declare is ignored.
  run.emitted.length = 0;
  onAction({ requestId: "t0", pluginId: "modes", actionId: "unknown-action", sessionId: "session-1" });
  assert.equal(viewsFor(run.emitted).length, 0);

  // The instant toggle from Normal publishes the Plan (warning) view.
  onAction({ requestId: "t1", pluginId: "modes", actionId: "toggle-mode", sessionId: "session-1" });
  const views = viewsFor(run.emitted);
  assert.equal(views.length, 1);
  assert.equal((views[0].data as { view: { tone: string } }).view.tone, "warning");
});

test("the toggle-mode action before any session has started is a no-op, not an error", () => {
  const run = fakePi();
  modes(run.pi as never);
  const [onAction] = run.eventHandlers.get(WEB_PLUGIN_ACTION_REQUEST_EVENT) ?? [];
  assert.doesNotThrow(() => onAction({ requestId: "t4", pluginId: "modes", actionId: "toggle-mode", sessionId: "s" }));
  assert.equal(viewsFor(run.emitted).length, 0);
});

test("the leave-plan action before any session has started is a no-op, not an error", () => {
  const run = fakePi();
  modes(run.pi as never);
  const [onAction] = run.eventHandlers.get(WEB_PLUGIN_ACTION_REQUEST_EVENT) ?? [];
  assert.doesNotThrow(() => onAction({ requestId: "r3", pluginId: "modes", actionId: "leave-plan", sessionId: "s" }));
  assert.equal(viewsFor(run.emitted).length, 0);
});
