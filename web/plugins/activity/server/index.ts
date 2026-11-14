// Activity plugin — the server half, and the first real consumer of the two
// realtime seams the kernel gained: `ctx.events` (host session traffic, in) and
// `ctx.ui` (the plugin's own surface, out).
//
// It is deliberately small, because its job is to be a worked example rather
// than a feature: subscribe to the tap, fold each event into a bounded state,
// and publish that state as a declarative view plus one status line. No client
// code, no route, no polling — the browser gets it through the same
// `plugin_state` frame every other plugin surface uses.

import type { PluginContext, PluginRuntime } from "../../../core/plugin-contracts/kernel/manager.ts";
import type { TapEvent } from "../../../core/plugin-contracts/kernel/events.ts";
import { activityView, applyActivity, emptyActivity, statusLine, type ActivityState } from "./activity.ts";

/** One bounded state per live session; a shutdown forgets it. */
const activity = new Map<string, ActivityState>();

function stateOf(sessionId: string): ActivityState {
  const existing = activity.get(sessionId);
  if (existing !== undefined) return existing;
  const fresh = emptyActivity();
  activity.set(sessionId, fresh);
  return fresh;
}

function publishActivity(ctx: PluginContext, event: TapEvent): void {
  const sessionId = event.sessionId;
  if (event.type === "session_shutdown") {
    activity.delete(sessionId);
    ctx.ui.status(sessionId, null);
    return;
  }

  const state = stateOf(sessionId);
  const next = applyActivity(state, event, Date.now());
  // An event this plugin does not track returns the same state object.
  if (next === state) return;
  activity.set(sessionId, next);

  // The panel shows tools; a message only moves the count behind the chip, so
  // it does not repaint the view.
  if (event.channel === "session.tool") ctx.ui.view(sessionId, activityView(next));
  const line = statusLine(next);
  if (line !== null) ctx.ui.status(sessionId, line);
}

const runtime: PluginRuntime = {
  setup(ctx) {
    const onEvent = (event: TapEvent): void => publishActivity(ctx, event);
    // One subscription per channel: the kernel refuses an unknown channel or a
    // missing grant at this call, so a manifest that forgot one fails loudly
    // during activation instead of silently showing nothing.
    ctx.events.on("session.tool", onEvent);
    ctx.events.on("session.message", onEvent);
    ctx.events.on("session.lifecycle", onEvent);
    ctx.register(() => activity.clear());
  },
};

export default runtime;
