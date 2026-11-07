import type { WebView } from "./web-plugins/view.ts";

/** Web plugin id and the action that leaves Plan mode. Shared by the extension and its descriptor. */
export const MODES_PLUGIN_ID = "modes";
export const MODES_LEAVE_PLAN_ACTION = "leave-plan";

/**
 * The status the web shows for an input mode. Normal is informational; Plan is a
 * warning because it restricts what the agent may write.
 */
export function modeWebView(mode: { id: string; label: string; summary?: string }): WebView {
  if (mode.id === "plan") {
    return {
      type: "status",
      tone: "warning",
      text: "Plan mode: read-only exploration; writes only to artifacts. Use Leave plan mode to resume normal work.",
    };
  }
  return { type: "status", tone: "neutral", text: mode.summary ? `${mode.label} mode: ${mode.summary}` : `${mode.label} mode` };
}
