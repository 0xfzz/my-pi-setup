// SSE transport for agent events over a raw Node response — the trimmed
// port of the vendored agent-event-stream.ts. One stream per client page:
// it opens immediately, publishes a `connected` event once the session is
// ready, coalesces tool progress, heartbeats every 30 s, and guards against
// a client that stops reading (drop rebuildable deltas above 512 KB, end the
// response above 16 MB so the client reconnects and re-snapshots).

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AGENT_EVENT_HEARTBEAT_MS,
  isDroppableEvent,
  toClientAgentEvent,
  type AgentEventLike,
} from "./wire.ts";
import type { SessionCore } from "./sessions.ts";
import { onSessionReplaced } from "./sessions.ts";
import {
  listDiskSessions,
  listLiveSessions,
  subscribeSessionDirectory,
  type SessionDirectoryEvent,
  type SessionInfo,
} from "./sessions.ts";
import { getRegisteredPlugins, recordExtensionUi, webUiStore } from "./plugin-host.ts";
import { resolveRegionOverrides } from "../shared/regions.ts";

const TOOL_UPDATE_COALESCE_MS = 150;
const STREAM_HIGH_WATER_MARK_BYTES = 512 * 1024;
const STREAM_BACKLOG_LIMIT_BYTES = 16 * 1024 * 1024;

export interface EventStreamSession extends Pick<SessionCore, "subscribe" | "isStreaming" | "getStreamSnapshot"> {}

/**
 * Attach an SSE stream to `res` for `sessionId`. `sessionPromise` resolves
 * with the session core, or null when the session cannot be found or started.
 */
export function attachAgentEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  sessionPromise: Promise<EventStreamSession | null>,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // Flush the headers before the agent is ready; the client waits for the
  // later `connected` data event.
  res.write(":\n\n");

  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let unsubscribeUi: (() => void) | null = null;
  let unsubscribeReplaced: (() => void) | null = null;
  let toolUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingToolUpdates = new Map<unknown, AgentEventLike>();

  const cleanup = (finish: boolean): void => {
    if (closed) return;
    closed = true;
    if (heartbeat !== null) clearInterval(heartbeat);
    if (toolUpdateTimer !== null) clearTimeout(toolUpdateTimer);
    pendingToolUpdates.clear();
    unsubscribe?.();
    unsubscribe = null;
    unsubscribeUi?.();
    unsubscribeUi = null;
    unsubscribeReplaced?.();
    unsubscribeReplaced = null;
    if (finish) res.end();
  };

  const send = (data: unknown, options?: { droppable?: boolean }): void => {
    if (closed) return;
    const queuedBytes = res.writableLength;
    if (options?.droppable && queuedBytes > STREAM_HIGH_WATER_MARK_BYTES) {
      return;
    }
    if (queuedBytes > STREAM_BACKLOG_LIMIT_BYTES) {
      cleanup(true);
      return;
    }
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      cleanup(false);
    }
  };

  const flushToolUpdates = (): void => {
    toolUpdateTimer = null;
    const updates = [...pendingToolUpdates.values()];
    pendingToolUpdates.clear();
    for (const update of updates) send(update, { droppable: true });
  };

  const sendClientEvent = (clientEvent: AgentEventLike): void => {
    if (clientEvent.type === "tool_execution_update") {
      pendingToolUpdates.set(clientEvent.toolCallId, clientEvent);
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
    send(clientEvent, { droppable: isDroppableEvent(clientEvent) });
  };

  const forwardEvent = (event: AgentEventLike): void => {
    const clientEvent = toClientAgentEvent(event);
    if (clientEvent !== null) sendClientEvent(clientEvent);
  };

  const publishSession = async (): Promise<void> => {
    try {
      const session = await sessionPromise;
      if (closed) return;
      if (session === null) {
        send({ type: "startup_error", errorMessage: "Session not found" });
        cleanup(true);
        return;
      }

      // Buffer events that arrive before the connection announcement, so a
      // reconnecting client never sees live events precede the state they
      // extend. (The vendored app also replayed the streaming snapshot here;
      // minimal v1 relies on the history endpoint for full state.)
      const buffered: AgentEventLike[] = [];
      let announced = false;
      const handleEvent = (event: unknown): void => {
        const typed = event as AgentEventLike;
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
          cleanup(true);
          return;
        }
        if (!announced) {
          buffered.push(typed);
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
      unsubscribeReplaced = onSessionReplaced(sessionId, () => {
        cleanup(true);
      });

      send({ type: "connected", sessionId, isStreaming: session.isStreaming() });
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
        send({
          type: "message_start",
          message: snapshot.message ?? { role: "assistant", content: [] },
        });
      }
      for (const event of buffered) forwardEvent(event);

      // Plugin surfaces ride the same stream: one snapshot after connect,
      // then every store revision pushes the session's views and working
      // model. Frames are deduplicated so other sessions' revisions cost
      // nothing on the wire.
      let lastPluginStateJson = "";
      const sendPluginState = (): void => {
        const snapshot = webUiStore.snapshot();
        const sessionState = snapshot.sessions[sessionId];
        const views = sessionState?.views ?? {};
        const frame = {
          type: "plugin_state" as const,
          revision: snapshot.revision,
          views,
          working: sessionState?.working ?? null,
          running: sessionState?.running ?? false,
          // The web port of the TUI's UI primitives: footer statuses, editor
          // widgets, custom popups and transient notifications, all driven
          // by the same ui.* events extensions publish.
          statuses: sessionState?.statuses ?? {},
          widgets: sessionState?.widgets ?? {},
          custom: sessionState?.custom ?? {},
          notifications: sessionState?.notifications ?? [],
          // Region override conflicts are host-resolved diagnostics: the
          // client renders overrides from the same views, and every conflict
          // (several plugins overriding one region) stays visible here.
          regionConflicts: resolveRegionOverrides(getRegisteredPlugins(), views).conflicts,
        };
        const json = JSON.stringify(frame);
        if (json === lastPluginStateJson) return;
        lastPluginStateJson = json;
        send(frame);
      };
      sendPluginState();
      unsubscribeUi = webUiStore.subscribe(() => {
        sendPluginState();
      });
    } catch (error) {
      if (closed) return;
      send({
        type: "startup_error",
        errorMessage: `Failed to start agent: ${error instanceof Error ? error.message : String(error)}`,
      });
      cleanup(true);
    }
  };

  void publishSession();

  req.on("close", () => cleanup(false));
  res.on("close", () => cleanup(false));

  heartbeat = setInterval(() => {
    send({ type: "heartbeat" }, { droppable: true });
  }, AGENT_EVENT_HEARTBEAT_MS);
}

async function buildSessionsSnapshot(): Promise<SessionInfo[]> {
  const live = listLiveSessions();
  const liveIds = new Set(live.map((session) => session.id));
  const disk = await listDiskSessions();
  return [
    ...live,
    ...disk
      .filter((session) => !liveIds.has(session.id))
      .map((session) => ({
        id: session.id,
        cwd: session.cwd,
        sessionFile: session.file,
        live: false,
        running: false,
        modifiedAt: session.modifiedAt,
      })),
  ];
}

/**
 * The session directory stream: replaces the client's 2s /api/sessions poll.
 * One snapshot on connect, then only `session_running` / `session_added` /
 * `session_removed` transitions (see subscribeSessionDirectory in sessions.ts).
 * Shares the agent stream's heartbeat cadence and backlog guards.
 */
export function attachSessionsEventStream(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(":\n\n");

  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const cleanup = (finish: boolean): void => {
    if (closed) return;
    closed = true;
    if (heartbeat !== null) clearInterval(heartbeat);
    unsubscribe?.();
    unsubscribe = null;
    if (finish) res.end();
  };

  const send = (data: unknown, options?: { droppable?: boolean }): void => {
    if (closed) return;
    const queuedBytes = res.writableLength;
    if (options?.droppable && queuedBytes > STREAM_HIGH_WATER_MARK_BYTES) return;
    if (queuedBytes > STREAM_BACKLOG_LIMIT_BYTES) {
      cleanup(true);
      return;
    }
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      cleanup(false);
    }
  };

  // Subscribe-before-snapshot: transitions that land while the (async) disk
  // scan runs are buffered and flushed after the snapshot, so no flip is lost.
  let announced = false;
  const buffered: SessionDirectoryEvent[] = [];
  const forward = (event: SessionDirectoryEvent): void => {
    if (!announced) {
      buffered.push(event);
      return;
    }
    send(event);
  };
  unsubscribe = subscribeSessionDirectory(forward);

  void buildSessionsSnapshot()
    .then((sessions) => {
      if (closed) return;
      send({ type: "sessions_snapshot", sessions });
      announced = true;
      for (const event of buffered) send(event);
      buffered.length = 0;
    })
    .catch(() => {
      if (closed) return;
      send({ type: "sessions_snapshot", sessions: [] });
      announced = true;
      for (const event of buffered) send(event);
      buffered.length = 0;
    });

  req.on("close", () => cleanup(false));
  res.on("close", () => cleanup(false));

  heartbeat = setInterval(() => {
    send({ type: "heartbeat" }, { droppable: true });
  }, AGENT_EVENT_HEARTBEAT_MS);
}
