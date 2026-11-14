// Plugin views: the validated, per-session values a plugin publishes for the
// browser to render.
//
// A view is data, never code. It is validated against the view contract before
// it enters the unified store, so the client only ever renders a shape the
// contract allows. The store is the single home for these values — the host
// keeps no second copy, and a session's views are read back from the snapshot.

import { validateView, type WebView } from "../plugin-contracts/view.ts";
import { webUiStore } from "./ui-store.ts";

/**
 * Publish a plugin view for one session. Returns false when the session id or
 * the view itself is not valid; a rejected view never reaches the store.
 */
export function recordPluginView(sessionId: string, pluginId: string, rawView: unknown): boolean {
  if (typeof sessionId !== "string" || sessionId === "") return false;
  if (typeof pluginId !== "string" || pluginId === "") return false;

  const validation = validateView(rawView);
  if (!validation.ok) return false;

  return webUiStore.publish(sessionId, "ui.view.changed", { pluginId, view: validation.view }, pluginId);
}

/** One plugin's view for one session, or undefined when nothing is published. */
export function pluginView(sessionId: string, pluginId: string): WebView | undefined {
  return webUiStore.snapshot().sessions[sessionId]?.views[pluginId];
}
