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
  /** Who owns the current name: a generated title, or the person's own. */
  source?: "auto" | "you";
  /** Automatic tries so far, failures included, out of `cap`. */
  attempts?: number;
  cap?: number;
  /** `provider/id` of the model the session is using. */
  model?: string;
  /** Why the last attempt did not produce a title. */
  error?: string;
}

const PHASE_LABEL: Record<AutoTitlePhase, string> = {
  idle: "Waiting for the first turn",
  generating: "Generating…",
  done: "Titled",
  failed: "Skipped",
};

function statusOf(state: AutoTitleState): string {
  if (state.phase === "generating") return PHASE_LABEL.generating;
  if (state.source === "you") return "Locked (you named it)";
  if (!state.enabled && state.phase !== "done") return "Disabled";
  return PHASE_LABEL[state.phase];
}

/** What the web shows for the auto title: its state, the name and who owns it, the model, and the last failure if any. */
export function autoTitleWebView(state: AutoTitleState): WebView {
  const rows = [
    { label: "Auto title", value: state.enabled ? "On" : "Off" },
    { label: "Status", value: statusOf(state) },
  ];
  if (state.title) rows.push({ label: "Title", value: state.title });
  if (state.source) rows.push({ label: "Source", value: state.source === "auto" ? "Generated" : "You" });
  if (state.model) rows.push({ label: "Model", value: state.model });
  if (state.attempts !== undefined) rows.push({ label: "Generations", value: `${state.attempts} / ${state.cap ?? 3}` });
  if (state.error) rows.push({ label: "Last error", value: state.error });
  return { type: "kv", title: "Session title", rows };
}
