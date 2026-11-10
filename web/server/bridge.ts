// The session bridge: the pi process that OWNS a live session (the TUI)
// attaches it here, making that one AgentSession the single source of truth
// for both frontends. The attach response is an SSE stream of commands
// (prompt, abort, plugin action) for the extension to execute in-process;
// the extension POSTs the session's events (and its plugin view / working
// indicator bus events) back, which fan out to every browser stream through
// the same wire projection and plugin state store the in-process sessions
// use. This is what makes web↔TUI sync bidirectional and realtime: one
// session, two frontends, no rival in-process copy.

import type { IncomingMessage, ServerResponse } from "node:http";
import { createStreamTracker, type StreamSnapshot } from "./stream-tracker.ts";
import { WEB_PLUGIN_ACTION_REQUEST_EVENT } from "../../lib/web-plugins/actions.ts";
import type { WebUiType } from "../../lib/web-plugins/ui-event-models.ts";
import {
  recordExtensionUi,
  webPluginsStore,
  webUiStore,
  type MinimalEventBus,
} from "./plugin-host.ts";
import {
  registerSession,
  unregisterSession,
  type SessionCore,
  type SessionStateLite,
} from "./sessions.ts";

export interface BridgeMetadata {
  sessionId: string;
  cwd: string;
  sessionFile?: string;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
}

export interface BridgeState {
  isStreaming: boolean;
  isBashRunning: boolean;
  isCompacting: boolean;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  contextUsage?: { percent: number; contextWindow: number; tokens: number } | null;
}

export type BridgeCommand =
  | { type: "prompt"; message: string; images?: Array<{ data: string; mimeType: string }> }
  | { type: "abort" }
  | { type: "action"; requestId: string; pluginId: string; actionId: string }
  | { type: "set_model"; provider: string; id: string }
  | { type: "set_thinking"; level: string }
  | { type: "web_command"; name: string; args?: string };

/** Model list for the web picker, posted by the extension (web_models). */
export interface BridgeModels {
  current?: { provider: string; id: string };
  models: Array<{ provider: string; id: string }>;
}

export interface BridgeConnection {
  readonly metadata: BridgeMetadata;
  readonly state: BridgeState;
  readonly closed: boolean;
  sendCommand(command: BridgeCommand): void;
  postEvent(event: unknown): void;
  postState(state: Partial<BridgeState>): void;
  /** Slash commands the owning pi process posted (web_commands events). */
  getCommands(): Array<{ name: string; description?: string }>;
  /** The model list for the web picker (web_models events). */
  getModels(): BridgeModels | null;
  /** The in-flight streaming message, for mid-turn stream replay. */
  getStreamSnapshot(): StreamSnapshot;
  subscribe(listener: (event: unknown) => void): () => void;
  close(): void;
}

const bridges = new Map<string, BridgeConnection>();
const BRIDGE_HEARTBEAT_MS = 30_000;

export function getBridge(sessionId: string): BridgeConnection | undefined {
  return bridges.get(sessionId);
}

/**
 * Attach a session bridge. The response stays open (SSE) for the lifetime of
 * the owning pi process; closing the request detaches the bridge, which ends
 * the browser streams so their EventSources reconnect and re-resolve.
 */
export function attachBridge(options: {
  req: IncomingMessage;
  res: ServerResponse;
  metadata: BridgeMetadata;
}): BridgeConnection {
  const { req, res, metadata } = options;
  // A re-attach replaces the previous bridge (server or extension restart).
  bridges.get(metadata.sessionId)?.close();

  const listeners = new Set<(event: unknown) => void>();
  const state: BridgeState = {
    isStreaming: false,
    isBashRunning: false,
    isCompacting: false,
    model: metadata.model,
    thinkingLevel: metadata.thinkingLevel,
    contextUsage: null,
  };
  // The in-flight streaming state, tapped from the raw events so a browser
  // stream attaching mid-turn can replay the partial message (the tracker
  // sits before wire normalization, where `partial` is still present).
  const streamTracker = createStreamTracker();
  // The commands the extension posts at attach (web_commands events);
  // bridgeSessionCore serves them to /api/agent/:id/commands.
  let commands: Array<{ name: string; description?: string }> = [];
  let commandsChanged = false;
  const setCommands = (next: Array<{ name: string; description?: string }>): void => {
    commands = next;
  };
  // The model list the extension posts (web_models events); served to
  // /api/agent/:id/models for the web picker.
  let models: BridgeModels | null = null;
  const setModels = (next: BridgeModels): void => {
    models = next;
  };

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(":\n\n");
  res.write(
    `data: ${JSON.stringify({ type: "bridge_attached", sessionId: metadata.sessionId })}\n\n`,
  );

  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  // Action relay: the plugin action route emits the action request on the
  // session bus; for a bridged session the bus forwards it as a bridge
  // command, so the TUI-side extensions (which listen on pi.events) receive
  // it exactly like an in-process session would.
  const actionBus: MinimalEventBus = {
    on: () => () => {},
    emit: (channel: string, data: unknown) => {
      if (closed || channel !== WEB_PLUGIN_ACTION_REQUEST_EVENT) return;
      const request = data as { requestId?: unknown; pluginId?: unknown; actionId?: unknown };
      if (typeof request?.pluginId === "string" && typeof request?.actionId === "string") {
        connection.sendCommand({
          type: "action",
          requestId: typeof request.requestId === "string" ? request.requestId : "",
          pluginId: request.pluginId,
          actionId: request.actionId,
        });
      }
    },
  };

  const connection: BridgeConnection = {
    metadata,
    get state() {
      return state;
    },
    get closed() {
      return closed;
    },
    sendCommand(command: BridgeCommand): void {
      if (closed) return;
      try {
        res.write(`data: ${JSON.stringify({ type: "bridge_command", command })}\n\n`);
      } catch {
        // A failed write means the owning process is gone; the request's
        // close event runs the cleanup.
      }
    },
    postEvent(event: unknown): void {
      if (closed) return;
      // web_commands needs this connection's closure; the rest of the
      // lifecycle/plugin projection is module-scope.
      if (event !== null && typeof event === "object") {
        const e = event as { type?: unknown; commands?: unknown };
        if (e.type === "web_commands" && Array.isArray(e.commands)) {
          const valid = e.commands.filter(
            (command): command is { name: string; description?: string } =>
              typeof command === "object"
              && command !== null
              && typeof (command as { name?: unknown }).name === "string"
              && (command as { name?: unknown }).name !== "",
          );
          if (valid.length > 0) {
            setCommands(valid);
            // The client refetches /commands so the palette and the web
            // dispatch channel see the new list immediately.
            commandsChanged = true;
          }
        }
        if (e.type === "web_models") {
          const payload = event as { current?: unknown; models?: unknown };
          const list = Array.isArray(payload.models)
            ? payload.models.filter(
              (ref): ref is { provider: string; id: string } =>
                typeof ref === "object" && ref !== null
                && typeof (ref as { provider?: unknown }).provider === "string"
                && typeof (ref as { id?: unknown }).id === "string",
            )
            : [];
          const current = typeof payload.current === "object" && payload.current !== null
            && typeof (payload.current as { provider?: unknown }).provider === "string"
            && typeof (payload.current as { id?: unknown }).id === "string"
            ? (payload.current as { provider: string; id: string })
            : undefined;
          setModels({ current, models: list.slice(0, 500) });
        }
      }
      streamTracker.feed(event);
      handleBridgeEvent(metadata.sessionId, event);
      if (commandsChanged) {
        commandsChanged = false;
        for (const listener of Array.from(listeners)) {
          try {
            listener({ type: "commands_changed" });
          } catch {
            // A failing listener cannot break the bridge.
          }
        }
      }
      // Snapshot: a listener may unsubscribe itself (browser stream cleanup)
      // while the fan-out runs, which would skip entries mid-iteration.
      for (const listener of Array.from(listeners)) {
        try {
          listener(event);
        } catch {
          // A failing listener (a dead browser stream) cannot break the bridge.
        }
      }
    },
    postState(partial: Partial<BridgeState>): void {
      if (closed) return;
      Object.assign(state, partial);
    },
    getCommands(): Array<{ name: string; description?: string }> {
      return commands;
    },
    getModels(): BridgeModels | null {
      return models;
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getStreamSnapshot(): StreamSnapshot {
      return streamTracker.snapshot();
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (heartbeat !== null) clearInterval(heartbeat);
      if (bridges.get(metadata.sessionId) === connection) {
        bridges.delete(metadata.sessionId);
      }
      if (webPluginsStore.sessionBuses.get(metadata.sessionId) === actionBus) {
        webPluginsStore.sessionBuses.delete(metadata.sessionId);
      }
      unregisterSession(metadata.sessionId);
      // End the browser streams watching this session: their EventSources
      // reconnect and re-resolve (a re-attached bridge, or the disk fallback).
      // Snapshot: the stream cleanups unsubscribe during this very fan-out.
      for (const listener of Array.from(listeners)) {
        try {
          listener({ type: "session_shutdown" });
        } catch {
          // ignored
        }
      }
      listeners.clear();
      try {
        res.end();
      } catch {
        // already gone
      }
    },
  };

  bridges.set(metadata.sessionId, connection);
  webPluginsStore.knownSessions.add(metadata.sessionId);
  webPluginsStore.sessionBuses.set(metadata.sessionId, actionBus);

  // The bridge IS the live session: every existing route (events SSE, prompt
  // and abort POSTs, get_state, the sessions list) works against this core
  // unchanged, and it replaces any in-process copy resumed earlier.
  registerSession(bridgeSessionCore(connection), metadata.cwd, metadata.sessionFile ?? "");

  heartbeat = setInterval(() => {
    if (closed) return;
    try {
      res.write(":hb\n\n");
    } catch {
      connection.close();
    }
  }, BRIDGE_HEARTBEAT_MS);

  req.on("close", () => {
    connection.close();
  });

  return connection;
}

/**
 * Events the extension adds on top of the session stream: plugin views and
 * UI events from the TUI-side publishers, plus lifecycle recording so the
 * unified UI state (running flag, working indicator) stays current even
 * before any browser stream connects.
 */
function handleBridgeEvent(sessionId: string, event: unknown): void {
  if (event === null || typeof event !== "object") return;
  const e = event as Record<string, unknown>;
  if (e.type === "web_plugin_view") {
    const payload = e.payload as { pluginId?: unknown; view?: unknown } | undefined;
    if (payload !== undefined && typeof payload.pluginId === "string") {
      webPluginsStore.recordView(sessionId, payload.pluginId, payload.view);
    }
    return;
  }
  if (e.type === "web_ui_event") {
    const payload = e.payload as
      | { type?: unknown; payload?: unknown; sourceKey?: unknown }
      | undefined;
    if (payload !== undefined && typeof payload.type === "string") {
      webUiStore.publish(
        sessionId,
        payload.type as WebUiType,
        payload.payload,
        typeof payload.sourceKey === "string" ? payload.sourceKey : "bridge",
      );
    }
    return;
  }
  if (e.type === "web_models") {
    // Handled in postEvent: the models list is this connection's state.
    return;
  }
  if (e.type === "agent_start" || e.type === "agent_settled" || e.type === "session_shutdown") {
    recordExtensionUi(sessionId, e);
  }
}

/** The bridge as a session core: commands in, events out. */
export function bridgeSessionCore(connection: BridgeConnection): SessionCore {
  const { metadata } = connection;
  return {
    sessionId: metadata.sessionId,
    subscribe: (listener: (event: unknown) => void) => connection.subscribe(listener),
    getStreamSnapshot: () => connection.getStreamSnapshot(),
    prompt: async (text: string, images?: Array<{ data: string; mimeType: string }>) => {
      connection.sendCommand({
        type: "prompt",
        message: text,
        ...(images !== undefined && images.length > 0 ? { images } : {}),
      });
    },
    abort: async () => {
      connection.sendCommand({ type: "abort" });
    },
    isStreaming: () => connection.state.isStreaming,
    getState: (): SessionStateLite => ({
      sessionId: metadata.sessionId,
      sessionFile: metadata.sessionFile ?? "",
      isStreaming: connection.state.isStreaming,
      isBashRunning: connection.state.isBashRunning,
      isCompacting: connection.state.isCompacting,
      model: connection.state.model ?? metadata.model,
      contextUsage: connection.state.contextUsage ?? null,
      thinkingLevel: connection.state.thinkingLevel ?? metadata.thinkingLevel ?? "off",
    }),
    getCommands: () => connection.getCommands(),
    getModels: () => {
      const posted = connection.getModels();
      if (posted !== null) return posted;
      // The extension has not posted a list yet; the current model still
      // makes a one-row picker.
      const current = connection.state.model ?? metadata.model;
      return { models: current ? [current] : [], ...(current !== undefined ? { current } : {}) };
    },
    setModel: async (provider: string, id: string) => {
      // The extension resolves, applies and reports back (session_state);
      // the command channel is fire-and-forget like the TUI's own path.
      connection.sendCommand({ type: "set_model", provider, id });
      return true;
    },
    setThinkingLevel: async (level: string) => {
      connection.sendCommand({ type: "set_thinking", level });
      return true;
    },
    webCommand: async (name: string, args: string) => {
      // The extension's web-core registry handles it in the pi process.
      connection.sendCommand({ type: "web_command", name, ...(args !== "" ? { args } : {}) });
    },
  };
}
