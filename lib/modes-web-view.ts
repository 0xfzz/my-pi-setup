import type { WebView } from "./web-plugins/view.ts";

/** Web plugin id and the actions it declares. Shared by the extension and its descriptor. */
export const MODES_PLUGIN_ID = "modes";
export const MODES_LEAVE_PLAN_ACTION = "leave-plan";
/** Instant (no-confirm) action: cycles Normal ↔ Plan, bound to Alt+M in the web UI. */
export const MODES_TOGGLE_MODE_ACTION = "toggle-mode";

/**
 * The status the web shows for an input mode. Normal is informational; Plan is a
 * warning because it restricts what the agent may write.
 */
export function modeWebView(mode: { id: string; label: string; summary?: string }): WebView {
  if (mode.id === "plan") {
    return {
      type: "status",
      tone: "warning",
      text: "Plan mode: read-only; writes only to artifacts",
    };
  }
  return { type: "status", tone: "neutral", text: mode.summary ? `${mode.label} mode: ${mode.summary}` : `${mode.label} mode` };
}
