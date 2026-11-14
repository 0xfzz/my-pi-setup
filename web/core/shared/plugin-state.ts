// The `plugin_state` frame: the per-session plugin surface snapshot the SSE
// stream pushes after connect and on every store revision.
//
// One definition, shared by the server that builds it and the client that
// renders it. The client used to cast each field by hand off an untyped
// `Record<string, unknown>`, so a field added on one side was invisible to the
// other; `pluginStateFrameOf` is now the single place JSON becomes this type.

import type { WebNotification, WorkingModel } from "../plugin-contracts/ui-event-models.ts";
import type { WebView } from "../plugin-contracts/view.ts";

export interface PluginWidgetState {
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

export interface PluginCustomPanelState {
  method: string;
  lines: string[] | null;
}

export interface PluginStateFrame {
  type: "plugin_state";
  /** The unified store revision this frame was built from. */
  revision: number;
  views: Record<string, WebView>;
  working: WorkingModel | null;
  /** Mid-turn right now; drives `visibleWhen: "running" | "idle"`. */
  running: boolean;
  statuses: Record<string, string>;
  widgets: Record<string, PluginWidgetState>;
  custom: Record<string, PluginCustomPanelState>;
  notifications: WebNotification[];
}

function asRecord<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "object" || Array.isArray(value)) return fallback;
  return value as T;
}

/**
 * Read a `plugin_state` frame out of one decoded SSE message, or undefined when
 * the message is a different frame type. A field the server did not send falls
 * back to its empty value, so a partial frame never blanks the UI.
 */
export function pluginStateFrameOf(data: Record<string, unknown>): PluginStateFrame | undefined {
  if (data.type !== "plugin_state") return undefined;
  return {
    type: "plugin_state",
    revision: typeof data.revision === "number" ? data.revision : 0,
    views: asRecord<Record<string, WebView>>(data.views, {}),
    working: asRecord<WorkingModel | null>(data.working, null),
    running: data.running === true,
    statuses: asRecord<Record<string, string>>(data.statuses, {}),
    widgets: asRecord<Record<string, PluginWidgetState>>(data.widgets, {}),
    custom: asRecord<Record<string, PluginCustomPanelState>>(data.custom, {}),
    notifications: Array.isArray(data.notifications) ? (data.notifications as WebNotification[]) : [],
  };
}
