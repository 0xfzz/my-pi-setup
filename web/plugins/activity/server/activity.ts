// Activity plugin — the pure half.
//
// Everything here is a value-in/value-out decision over the host's tap events:
// no clock, no store, no plugin context. That keeps the interesting part — how
// a session's activity is counted, bounded and rendered — testable without a
// session, which is why the runtime in `index.ts` is only wiring.

import type { TapEvent } from "../../../core/plugin-contracts/kernel/events.ts";
import type { ListItem, ListWebView } from "../../../core/plugin-contracts/view.ts";

/** Rows the panel keeps. A long turn must not grow the view without bound. */
export const MAX_RECENT_TOOLS = 6;
/** A bash command line is a label here, not a transcript. */
const MAX_LABEL_CHARS = 60;

export interface ToolRecord {
  label: string;
  /** Null when the end arrived without a start (a reconnected stream, a bash entry). */
  durationMs: number | null;
  isError: boolean;
}

export interface ActivityState {
  tools: number;
  failures: number;
  messages: number;
  /** Most recent first, capped at `MAX_RECENT_TOOLS`. */
  recent: ToolRecord[];
  /** Calls that started and have not ended yet, by tool call id. */
  running: Record<string, { label: string; at: number }>;
}

export function emptyActivity(): ActivityState {
  return { tools: 0, failures: 0, messages: 0, recent: [], running: {} };
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function label(text: string): string {
  return text.length > MAX_LABEL_CHARS ? `${text.slice(0, MAX_LABEL_CHARS - 1)}…` : text;
}

/** Push a finished record, keeping the list newest-first and bounded. */
function withRecord(state: ActivityState, record: ToolRecord): ActivityState {
  return {
    ...state,
    tools: state.tools + 1,
    failures: state.failures + (record.isError ? 1 : 0),
    recent: [record, ...state.recent].slice(0, MAX_RECENT_TOOLS),
  };
}

function startTool(state: ActivityState, payload: Readonly<Record<string, unknown>>, now: number): ActivityState {
  const id = stringOf(payload.toolCallId);
  const name = stringOf(payload.toolName);
  if (id === undefined || name === undefined) return state;
  return { ...state, running: { ...state.running, [id]: { label: name, at: now } } };
}

function endTool(state: ActivityState, payload: Readonly<Record<string, unknown>>, now: number): ActivityState {
  const name = stringOf(payload.toolName);
  if (name === undefined) return state;
  const id = stringOf(payload.toolCallId);
  const started = id === undefined ? undefined : state.running[id];
  const running = { ...state.running };
  if (id !== undefined) delete running[id];
  return {
    ...withRecord(state, {
      label: started?.label ?? name,
      durationMs: started === undefined ? null : Math.max(0, now - started.at),
      isError: payload.isError === true,
    }),
    running,
  };
}

/** pi appends a bash execution as a transcript entry, so it has no start/end pair. */
function bashTool(state: ActivityState, payload: Readonly<Record<string, unknown>>): ActivityState {
  const command = stringOf(payload.command) ?? "bash";
  const exitCode = payload.exitCode;
  return withRecord(state, {
    label: label(`bash: ${command}`),
    durationMs: null,
    isError: typeof exitCode === "number" && exitCode !== 0,
  });
}

/**
 * Apply one tap event. An event the plugin does not track returns the state
 * unchanged (same object), so the caller can tell nothing happened.
 */
export function applyActivity(state: ActivityState, event: TapEvent, now: number): ActivityState {
  switch (event.type) {
    case "tool_execution_start":
      return startTool(state, event.payload, now);
    case "tool_execution_end":
      return endTool(state, event.payload, now);
    case "entry_appended":
      return bashTool(state, event.payload);
    case "message_end":
      return { ...state, messages: state.messages + 1 };
    default:
      return state;
  }
}

/** Sub-second durations read as milliseconds; longer ones as seconds. */
export function formatDuration(ms: number): string {
  return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(1)}s`;
}

/** The panel's view: the recent tools, newest first, with the count it left out. */
export function activityView(state: ActivityState): ListWebView {
  const items: ListItem[] = state.recent.map((record) => ({
    text: record.durationMs === null ? record.label : `${record.label} · ${formatDuration(record.durationMs)}`,
    status: record.isError ? "failed" : "done",
  }));
  const omitted = state.tools - items.length;
  return {
    type: "list",
    title: "Activity",
    items,
    ...(omitted > 0 ? { omitted } : {}),
  };
}

/** The one-line status chip, or null when there is nothing to say yet. */
export function statusLine(state: ActivityState): string | null {
  if (state.tools === 0) return null;
  const tools = `${state.tools} ${state.tools === 1 ? "tool" : "tools"}`;
  return state.failures === 0 ? tools : `${tools} · ${state.failures} failed`;
}
