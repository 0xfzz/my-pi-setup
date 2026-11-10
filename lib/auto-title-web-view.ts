import type { WebView } from "./web-plugins/view.ts";

/** Web plugin id and the actions it declares. Shared by the extension and its descriptor. */
export const AUTO_TITLE_PLUGIN_ID = "auto-title";
/** Instant actions: both only touch the session name, which `/name` can always change back. */
export const AUTO_TITLE_REGENERATE_ACTION = "regenerate";
export const AUTO_TITLE_TOGGLE_ACTION = "toggle";

export type AutoTitlePhase = "idle" | "generating" | "done" | "failed";

export interface AutoTitleState {
  enabled: boolean;
  phase: AutoTitlePhase;
  /** The session's current name, whoever set it. */
  title?: string;
  /** Why the last attempt did not produce a title. */
  error?: string;
}

const PHASE_LABEL: Record<AutoTitlePhase, string> = {
  idle: "Waiting for the first turn",
  generating: "Generating…",
  done: "Titled",
  failed: "Skipped",
};

/** What the web shows for the auto title: its state, the title, and the last failure if any. */
export function autoTitleWebView(state: AutoTitleState): WebView {
  const rows = [
    { label: "Auto title", value: state.enabled ? "On" : "Off" },
    { label: "Status", value: state.enabled || state.phase === "done" ? PHASE_LABEL[state.phase] : "Disabled" },
  ];
  if (state.title) rows.push({ label: "Title", value: state.title });
  if (state.error) rows.push({ label: "Last error", value: state.error });
  return { type: "kv", title: "Session title", rows };
}
