import { WEB_PLUGIN_VIEW_EVENT, validateView, type WebView } from "./view.ts";
import {
  WEB_PLUGIN_UI_SYNC_EVENT,
  WEB_UI_EVENT,
  validateWebUiEvent,
  type WebUiPayloads,
  type WebUiType,
} from "./ui-event-models.ts";

export interface PublishWebViewTarget {
  events?: {
    emit(channel: string, data: unknown): void;
    on?(channel: string, handler: (data: unknown) => void): () => void;
  };
}

export interface PublishWebViewResult {
  ok: boolean;
  warnings?: string[];
  error?: string;
}

type EventsBus = NonNullable<PublishWebViewTarget["events"]>;

interface BusViewState {
  /** The last validated view per plugin id, keyed to this session's own bus. */
  views: Map<string, WebView>;
  /**
   * The last validated ui.* event per producer stream. `null` payloads are
   * remembered too: clearing a status/widget must survive a replay, otherwise
   * a cleared value would resurrect.
   */
  ui: Map<string, { sourceKey: string; type: WebUiType; payload: unknown }>;
}

/**
 * Value memory is bus-scoped, never process-global: several AgentSession
 * runtimes can share this module in one web-server process, and their event
 * buses are the only reliable session boundary.
 */
const busStates = new WeakMap<EventsBus, BusViewState>();
const syncBound = new WeakSet<EventsBus>();

function ensureState(events: EventsBus): BusViewState {
  const existing = busStates.get(events);
  if (existing) return existing;
  const state: BusViewState = { views: new Map(), ui: new Map() };
  busStates.set(events, state);
  return state;
}

const uiStateKey = (type: WebUiType, sourceKey: string): string => `${type}\u0000${sourceKey}`;

/**
 * Wire the sync responder once per bus: a consumer that attached after the
 * producers already published asks for the current values, and every remembered
 * value is re-emitted in full. Idempotent by design — the host treats a
 * re-publish as the same value it already held.
 */
function bindSync(events: EventsBus): void {
  if (syncBound.has(events) || typeof events.on !== "function") return;
  syncBound.add(events);
  try {
    events.on(WEB_PLUGIN_UI_SYNC_EVENT, () => {
      const state = busStates.get(events);
      if (!state) return;
      for (const [pluginId, view] of state.views) {
        events.emit(WEB_PLUGIN_VIEW_EVENT, { pluginId, view });
      }
      for (const ui of state.ui.values()) {
        events.emit(WEB_UI_EVENT, { sourceKey: ui.sourceKey, type: ui.type, payload: ui.payload });
      }
    });
  } catch {
    // A bus that cannot subscribe simply cannot replay; publish still works.
  }
}

/** Publish declarative UI data. The owning host assigns session, sequence and source. */
export function publishWebUi<K extends WebUiType>(pi: PublishWebViewTarget, sourceKey: string, type: K, payload: WebUiPayloads[K]): PublishWebViewResult {
  const result = validateWebUiEvent({ version: 1, eventId: "producer", sessionId: "producer", source: "extension", sourceKey, type, payload, timestamp: Date.now(), sequence: 1 });
  if (!result.ok) return { ok: false, error: result.error };
  try {
    const events = pi.events;
    if (!events || typeof events.emit !== "function") return { ok: true };
    bindSync(events);
    ensureState(events).ui.set(uiStateKey(type, sourceKey), {
      sourceKey,
      type,
      payload: result.event.payload,
    });
    events.emit(WEB_UI_EVENT, { sourceKey, type, payload: result.event.payload });
    return { ok: true };
  } catch { return { ok: false, error: "UI event delivery failed" }; }
}

export function publishWebView(
  pi: PublishWebViewTarget | null | undefined,
  pluginId: string,
  view: unknown,
): PublishWebViewResult {
  try {
    if (!pluginId || typeof pluginId !== "string") {
      return { ok: false, error: "pluginId must be a non-empty string" };
    }

    const result = validateView(view);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    try {
      const events = pi?.events;
      if (events && typeof events.emit === "function") {
        bindSync(events);
        ensureState(events).views.set(pluginId, result.view);
        events.emit(WEB_PLUGIN_VIEW_EVENT, { pluginId, view: result.view });
      }
    } catch {
      // Never throw into the caller if event emission fails.
    }

    return {
      ok: true,
      ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
