// Agent/session-directory events over the shared library SSE channel — the trimmed
// port of the vendored agent-event-stream.ts. One stream per client page:
// it opens immediately, publishes a `connected` event once the session is
// ready, coalesces tool progress, heartbeats every 30 s, and guards against
// a client that stops reading (drop rebuildable deltas above 512 KB, end the
// response above 16 MB so the client reconnects and re-snapshots).

import { setEventChannelFrame, type EventChannel } from "../http/sse.ts";
import { getWebLogger } from "../http/logging.ts";
import { BoundedSseEvents, MAIN_SSE_LIMITS } from "../../../lib/sse-pressure.ts";
import {
  AGENT_EVENT_HEARTBEAT_MS,
  isDroppableEvent,
  toClientAgentEvent,
  type AgentEventLike,
} from "./wire.ts";
import type { SessionCore } from "./sessions.ts";
import { onSessionReplaced } from "./sessions.ts";
import {
  getServerBootId,
  listAllSessions,
  subscribeSessionDirectory,
  type SessionDirectoryEvent,
  type SessionInfo,
} from "./sessions.ts";
import { recordExtensionUi, webUiStore } from "./ui-store.ts";
import { sessionBus } from "./plugin-sessions.ts";
import { servedClientBuild } from "./client-build.ts";
import { WEB_PLUGIN_UI_SYNC_EVENT } from "../plugin-contracts/ui-event-models.ts";
import type { BridgeEnvelope } from "../protocol/envelope.ts";
import { BRIDGE_PROTOCOL, BRIDGE_PROTOCOL_VERSION } from "../protocol/version.ts";

export type ProtocolEventName = "session.events" | "session.directory.events";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Match JSON.stringify's handling of undefined without stringify/parse per frame. */
function jsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    let copy: unknown[] | undefined;
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      const clean = jsonValue(entry);
      if (clean === entry || copy !== undefined) continue;
      copy = value.slice();
    }
    if (copy === undefined) return value;
    for (let index = 0; index < value.length; index += 1) copy[index] = jsonValue(value[index]) ?? null;
    return copy;
  }
  if (isRecord(value)) {
    let copy: Record<string, unknown> | undefined;
    for (const [key, entry] of Object.entries(value)) {
      const clean = jsonValue(entry);
      if (clean === entry && entry !== undefined) continue;
      copy ??= { ...value };
      if (clean === undefined) delete copy[key];
      else copy[key] = clean;
    }
    return copy ?? value;
  }
  return value;
}

/** One sequenced envelope per streamed event. */
export function protocolEvent(
  name: ProtocolEventName,
  sessionId: string | undefined,
  payload: unknown,
  sequence: number,
): BridgeEnvelope {
  return {
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_PROTOCOL_VERSION,
    kind: "event",
    name,
    messageId: `${name}-${sequence}`,
    ...(sessionId === undefined ? {} : { sessionId }),
    source: { type: "host", id: "protocol-host" },
    timestamp: 0,
    sequence,
    cursor: String(sequence),
    payload: jsonValue(payload) ?? null,
  };
}

/**
 * One stream owns one catalog channel. Binding every frame through this
 * wrapper keeps the orderly-restart hint on the same envelope sequence.
 */
function protocolSender(
  channel: EventChannel,
  name: ProtocolEventName,
  sessionId?: string,
): (payload: unknown) => BridgeEnvelope {
  let sequence = 0;
  const frame = (payload: unknown): BridgeEnvelope => {
    sequence += 1;
    return protocolEvent(name, sessionId, payload, sequence);
  };
  setEventChannelFrame(channel, frame);
  return frame;
}

const TOOL_UPDATE_COALESCE_MS = 150;
const SESSION_UI_SYNC_MS = 1_000;

interface SessionSyncTarget {
  isStreaming(): boolean;
  refresh(): void;
}
interface SessionSync {
  timer: ReturnType<typeof setInterval>;
  targets: Set<SessionSyncTarget>;
}
const sessionSyncs = new Map<string, SessionSync>();

/**
 * One UI replay per session per second, whatever the number of browser tabs.
 * The timer follows the streams that need it and disappears with the last one.
 */
function joinSessionSync(sessionId: string, target: SessionSyncTarget): () => void {
  let sync = sessionSyncs.get(sessionId);
  if (sync === undefined) {
    const targets = new Set<SessionSyncTarget>();
    const timer = setInterval(() => {
      let streaming = false;
      for (const entry of targets) {
        if (entry.isStreaming()) {
          streaming = true;
          break;
        }
      }
      if (!streaming) return;
      sessionBus(sessionId)?.emit?.(WEB_PLUGIN_UI_SYNC_EVENT, {});
      for (const entry of targets) {
        if (entry.isStreaming()) entry.refresh();
      }
    }, SESSION_UI_SYNC_MS);
    sync = { timer, targets };
    sessionSyncs.set(sessionId, sync);
  }
  const owned = sync;
  owned.targets.add(target);
  return () => {
    owned.targets.delete(target);
    if (owned.targets.size > 0) return;
    clearInterval(owned.timer);
    if (sessionSyncs.get(sessionId) === owned) sessionSyncs.delete(sessionId);
  };
}

function isAgentEvent(event: unknown): event is AgentEventLike {
  return typeof event === "object" && event !== null && !Array.isArray(event)
    && "type" in event && typeof event.type === "string";
}

export interface EventStreamSession extends Pick<SessionCore, "subscribe" | "isStreaming" | "getStreamSnapshot" | "getState"> {}

/**
 * Publish on the SSE channel for `sessionId`. `sessionPromise` resolves
 * with the session core, or null when the session cannot be found or started.
 */
export function attachAgentEventStream(
  channel: EventChannel,
  options: { sessionId: string; sessionPromise: Promise<EventStreamSession | null> },
): void {
  const { sessionId, sessionPromise } = options;

  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let unsubscribeUi: (() => void) | null = null;
  let unsubscribeReplaced: (() => void) | null = null;
  let toolUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  let releaseSessionSync: (() => void) | null = null;
  const pendingToolUpdates = new BoundedSseEvents();
  const startupEvents = new BoundedSseEvents();
  const protocolFrame = protocolSender(channel, "session.events", sessionId);

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat !== null) clearInterval(heartbeat);
    if (toolUpdateTimer !== null) clearTimeout(toolUpdateTimer);
    releaseSessionSync?.();
    releaseSessionSync = null;
    pendingToolUpdates.clear();
    startupEvents.clear();
    unsubscribe?.();
    unsubscribe = null;
    unsubscribeUi?.();
    unsubscribeUi = null;
    unsubscribeReplaced?.();
    unsubscribeReplaced = null;
    channel.close();
  };

  const reservedBytes = (): number => pendingToolUpdates.bytes + startupEvents.bytes;
  const send = (data: unknown, options?: { droppable?: boolean }): void => {
    if (closed) return;
    channel.send(data, { ...options, reservedBytes: reservedBytes() });
    if (channel.closed) cleanup();
  };
  // Coalesced and deduped frames already carry their JSON: hand it to the wire
  // directly instead of parsing it back and stringifying it a second time.
  const sendEncoded = (encoded: string, options?: { droppable?: boolean }): void => {
    if (closed) return;
    channel.sendEncoded(encoded, { ...options, reservedBytes: reservedBytes() });
    if (channel.closed) cleanup();
  };
  const sendFrame = (payload: unknown, options?: { droppable?: boolean }): void => {
    send(protocolFrame(payload), options);
  };
  const sendEncodedFrame = (encoded: string, options?: { droppable?: boolean }): void => {
    sendEncoded(JSON.stringify(protocolFrame(JSON.parse(encoded) as unknown)), options);
  };

  const flushToolUpdates = (): void => {
    toolUpdateTimer = null;
    for (const { encoded } of pendingToolUpdates.consumeEncoded()) {
      sendEncodedFrame(encoded, { droppable: true });
    }
  };

  const sendClientEvent = (clientEvent: AgentEventLike): void => {
    if (clientEvent.type === "tool_execution_update") {
      const available = MAIN_SSE_LIMITS.closeAboveBytes - channel.bufferedBytes - startupEvents.bytes;
      if (!pendingToolUpdates.put(clientEvent.toolCallId, clientEvent, available)) {
        cleanup();
        return;
      }
      if (toolUpdateTimer === null) {
        toolUpdateTimer = setTimeout(flushToolUpdates, TOOL_UPDATE_COALESCE_MS);
      }
      return;
    }
    // The end supersedes a partial result still waiting here; agent_end does
    // the same for any tool call whose end never came.
    if (clientEvent.type === "tool_execution_end") {
      pendingToolUpdates.delete(clientEvent.toolCallId);
    } else if (clientEvent.type === "agent_end") {
      pendingToolUpdates.clear();
    }
    sendFrame(clientEvent, { droppable: isDroppableEvent(clientEvent) });
  };

  const forwardEvent = (event: unknown): void => {
    if (!isAgentEvent(event)) return;
    const clientEvent = toClientAgentEvent(event);
    if (clientEvent !== null) sendClientEvent(clientEvent);
  };

  const publishSession = async (): Promise<void> => {
    try {
      const session = await sessionPromise;
      if (closed) return;
      if (session === null) {
        sendFrame({ type: "startup_error", errorMessage: "Session not found" });
        cleanup();
        return;
      }

      // Buffer events that arrive before the connection announcement, so a
      // reconnecting client never sees live events precede the state they
      // extend. (The vendored app also replayed the streaming snapshot here;
      // minimal v1 relies on the history endpoint for full state.)
      let startupSequence = 0;
      let announced = false;
      const handleEvent = (event: unknown): void => {
        if (closed || !isAgentEvent(event)) return;
        const typed = event;
        // Lifecycle events drive the unified UI state (running flag, working
        // indicator reset) for every plugin surface following this stream.
        if (
          typed.type === "agent_start"
          || typed.type === "agent_end"
          || typed.type === "agent_settled"
          || typed.type === "session_shutdown"
        ) {
          recordExtensionUi(sessionId, typed as Record<string, unknown>);
        }
        if (typed.type === "session_shutdown") {
          cleanup();
          return;
        }
        if (!announced) {
          const available = MAIN_SSE_LIMITS.closeAboveBytes - channel.bufferedBytes - pendingToolUpdates.bytes;
          if (!startupEvents.put(startupSequence++, typed, available)) cleanup();
          return;
        }
        forwardEvent(typed);
      };

      unsubscribe = session.subscribe(handleEvent);
      if (closed) {
        unsubscribe();
        return;
      }
      // If this session gets a new owner (a TUI bridge attaching over the
      // in-process resume this stream may be watching), end the stream: the
      // browser reconnects and resolves the live session instead of staying
      // frozen on the replaced copy.
      unsubscribeReplaced = onSessionReplaced(sessionId, cleanup);

      sendFrame({ type: "connected", sessionId, isStreaming: session.isStreaming() });
      if (closed) return;
      announced = true;
      // Mid-turn (re)connect: this stream never saw `message_start`, so
      // the client's delta accumulator would drop every delta until
      // `message_end` popped the reply in fully-formed. Replay the tapped
      // in-flight message as a synthetic `message_start` — the client
      // snapshots it and subsequent deltas continue from the partial.
      // BEFORE the buffered flush, so live deltas never precede the state
      // they extend.
      const snapshot = session.getStreamSnapshot?.();
      if (snapshot?.started === true) {
        sendFrame({
          type: "message_start",
          message: snapshot.message ?? { role: "assistant", content: [] },
        });
      }
      for (const { encoded } of startupEvents.consumeEncoded()) forwardEvent(JSON.parse(encoded) as AgentEventLike);
      if (closed) return;

      // Plugin surfaces ride the same stream: one snapshot after connect,
      // then every store revision pushes the session's views and working
      // model. Dedupe on the session's content, not the global revision: a
      // change in another session must not resend this one's whole snapshot.
      let lastPluginStateSignature = "";
      const sendPluginState = (): void => {
        const snapshot = webUiStore.snapshot();
        const sessionState = snapshot.sessions[sessionId];
        const views = sessionState?.views ?? {};
        // The web port of the TUI's UI primitives: footer statuses, editor
        // widgets, custom popups and transient notifications, all driven by
        // the same ui.* events extensions publish. Typed by the shared wire
        // contract, so the client reads it without per-field casts.
        const content = {
          views,
          working: sessionState?.working ?? null,
          running: sessionState?.running ?? false,
          statuses: sessionState?.statuses ?? {},
          widgets: sessionState?.widgets ?? {},
          custom: sessionState?.custom ?? {},
          notifications: sessionState?.notifications ?? [],
        };
        const contentJson = JSON.stringify(content);
        if (contentJson === lastPluginStateSignature) return;
        lastPluginStateSignature = contentJson;
        // The frame's JSON differs from the dedupe signature only by its type
        // and revision fields; stringify the plugin content once, not twice.
        sendEncodedFrame(`{"type":"plugin_state","revision":${snapshot.revision},${contentJson.slice(1)}`);
      };
      sendPluginState();
      if (closed) return;
      unsubscribeUi = webUiStore.subscribe(() => {
        sendPluginState();
      });
      if (closed) return;

      // While a turn runs, keep the live context-window figure and the
      // declarative plugin views fresh. The shared timer emits one ui-sync
      // per session; each stream deduplicates its own session_state frame.
      let lastSessionStateJson = "";
      releaseSessionSync = joinSessionSync(sessionId, {
        isStreaming: () => !closed && session.isStreaming(),
        refresh: () => {
          const state = session.getState();
          const frame = {
            type: "session_state" as const,
            model: state.model,
            thinkingLevel: state.thinkingLevel,
            contextUsage: state.contextUsage ?? null,
          };
          const json = JSON.stringify(frame);
          if (json === lastSessionStateJson) return;
          lastSessionStateJson = json;
          sendEncodedFrame(json, { droppable: true });
        },
      });
    } catch (error) {
      if (closed) return;
      getWebLogger().error({ err: error, sessionId }, "agent event stream startup failed");
      sendFrame({
        type: "startup_error",
        errorMessage: `Failed to start agent: ${error instanceof Error ? error.message : String(error)}`,
      });
      cleanup();
    }
  };

  channel.onClose(cleanup);
  // Observe startup rejection even if the socket closed before attachment.
  void publishSession();
  if (closed) return;
  heartbeat = setInterval(() => {
    sendFrame({ type: "heartbeat" }, { droppable: true });
  }, AGENT_EVENT_HEARTBEAT_MS);
}

async function buildSessionsSnapshot(): Promise<SessionInfo[]> {
  return listAllSessions();
}

/**
 * The session directory stream: replaces the client's 2s /api/sessions poll.
 * One snapshot on connect, then only `session_running` / `session_added` /
 * `session_removed` transitions (see subscribeSessionDirectory in sessions.ts).
 * Shares the agent stream's heartbeat cadence and backlog guards.
 */
export function attachSessionsEventStream(channel: EventChannel): void {

  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  const buffered = new BoundedSseEvents();
  const protocolFrame = protocolSender(channel, "session.directory.events");

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat !== null) clearInterval(heartbeat);
    buffered.clear();
    unsubscribe?.();
    unsubscribe = null;
    channel.close();
  };

  const send = (data: unknown, options?: { droppable?: boolean }): void => {
    if (closed) return;
    channel.send(data, { ...options, reservedBytes: buffered.bytes });
    if (channel.closed) cleanup();
  };
  const sendFrame = (payload: unknown, options?: { droppable?: boolean }): void => {
    send(protocolFrame(payload), options);
  };

  // Subscribe-before-snapshot: transitions that land while the (async) disk
  // scan runs are buffered and flushed after the snapshot, so no flip is lost.
  let announced = false;
  let eventSequence = 0;
  const forward = (event: SessionDirectoryEvent): void => {
    if (closed) return;
    if (!announced) {
      const available = MAIN_SSE_LIMITS.closeAboveBytes - channel.bufferedBytes;
      if (!buffered.put(eventSequence++, event, available)) cleanup();
      return;
    }
    sendFrame(event);
  };
  unsubscribe = subscribeSessionDirectory(forward);

  void buildSessionsSnapshot()
    .then((sessions) => {
      if (closed) return;
      const snapshot = { type: "sessions_snapshot", bootId: getServerBootId(), buildId: servedClientBuild()?.buildId ?? null, sessions };
      sendFrame(snapshot);
      announced = true;
      for (const event of buffered.consume()) {
        sendFrame(event);
      }
    })
    .catch((error: unknown) => {
      getWebLogger().warn({ err: error }, "session directory snapshot failed");
      if (closed) return;
      const snapshot = { type: "sessions_snapshot", bootId: getServerBootId(), buildId: servedClientBuild()?.buildId ?? null, sessions: [] };
      sendFrame(snapshot);
      announced = true;
      for (const event of buffered.consume()) {
        sendFrame(event);
      }
    });

  channel.onClose(cleanup);
  if (closed) return;
  heartbeat = setInterval(() => {
    sendFrame({ type: "heartbeat" }, { droppable: true });
  }, AGENT_EVENT_HEARTBEAT_MS);
}
