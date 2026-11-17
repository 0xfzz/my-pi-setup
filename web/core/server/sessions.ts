// Trimmed session manager: spawn and resume pi agent sessions in-process,
// keep a live registry, project minimal state, and translate the small
// command set (prompt / abort / get_state) onto AgentSession calls.
//
// This replaces the vendored app's 3.4k-line rpc-manager; per the PRD the
// model-selection, lease, trust, push and custom-UI chrome is out of scope.

import {
  createAgentSession,
  getAgentDir,
  resolveModelScopeWithDiagnostics,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { buildWebTree, type WebTreeNode } from "../../../lib/web-tree.ts";
import type { ServerReloadState } from "../../../lib/web-ui-reload.ts";
import { createStreamTracker, type StreamSnapshot } from "./stream-tracker.ts";
import { compileHttpSchema } from "../http/schema.ts";
import { SESSION_COMMAND_SCHEMA, sessionCommandSchemaError } from "../../../lib/session-command-schema.ts";
import { createReadStream, existsSync } from "node:fs";
import { open, readdir, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { getPluginHost } from "./plugin-host.ts";
import type { PluginHost } from "../plugin-contracts/kernel/host.ts";
import type { WebPluginDescriptor } from "../plugin-contracts/descriptor.ts";
import { attachSessionPlugins } from "./plugin-sessions.ts";
import { publishSessionTapEvent } from "./session-tap.ts";
import { createHeadlessWebUiContext } from "./web-ui-context.ts";
import { annotateContributedCommands } from "../shared/commands.ts";
import { WEB_PLUGIN_WEB_COMMAND_EVENT } from "../plugin-contracts/web-commands.ts";
import { announcedWebCommands, sessionBus } from "./plugin-sessions.ts";
import { externalSessionHostEnabled, isSessionHosted, startSessionHost, stopSessionHost } from "./session-host.ts";

export interface SessionStateLite {
  sessionId: string;
  sessionFile: string;
  isStreaming: boolean;
  isBashRunning: boolean;
  isCompacting: boolean;
  model: { provider: string; id: string } | undefined;
  contextUsage: { percent: number; contextWindow: number; tokens: number } | null;
  thinkingLevel: string;
}

/** The session surface the server consumes; fakes in tests implement this. */
export interface SessionCore {
  readonly sessionId: string;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void>;
  abort(): Promise<void>;
  isStreaming(): boolean;
  getState(): SessionStateLite;
  /** The session's display name, when it has one. Undefined for an unnamed session. */
  getSessionName?(): string | undefined;
  /** Slash commands the session can dispatch (extension/prompt/skill). */
  getCommands?(): Array<{ name: string; description?: string }>;
  /** Model list for the web picker + the current model. */
  getModels?(): {
    current?: { provider: string; id: string };
    models: Array<{ provider: string; id: string }>;
    all?: Array<{ provider: string; id: string }>;
  };
  /** Apply a model to the session; false when it could not be applied. */
  setModel?(provider: string, id: string): Promise<boolean>;
  /** Apply a thinking level; false when rejected. */
  setThinkingLevel?(level: string): Promise<boolean>;
  /** Dispatch a web core command (name + args) to the session owner. */
  webCommand?(name: string, args: string): Promise<void>;
  /**
   * Compact the session's context. Compaction is the core's own (a browser
   * /compact works on a session this process owns, with no extension in the
   * path); a bridged core leaves this undefined and the command rides the
   * bridge to the process that owns the session instead.
   */
  compact?(instructions?: string): Promise<void>;
  /**
   * The in-flight streaming message, tapped from the session's raw events.
   * Browser streams replay it right after `connected` so a mid-turn
   * (re)connect renders the partial reply instead of dropping deltas.
   */
  getStreamSnapshot?(): StreamSnapshot;
  /**
   * The session tree for the web /tree picker: pi's getTree() projected
   * the way its TUI selector shapes it (lib/web-tree.ts). Bridged sessions
   * read the extension's posted projection; in-process ones build it.
   */
  getTreeNodes?(): WebTreeNode[] | null;
  /**
   * Release this core when another owner takes the session over (a TUI
   * bridge attaching over an in-process resume): unsubscribe and drop the
   * AgentSession so two live copies never share one file.
   */
  dispose?(): void;
  /**
   * The owning bridge connection, when this core is a bridge core — the
   * drift heal's identity check (see bridge.ts). Internal; not a route.
   */
  bridgeOf?: unknown;
}

export interface SessionHandle {
  core: SessionCore;
  cwd: string;
  sessionFile: string;
  startedAt: number;
  lastActivityAt: number;
}

export interface DiskSession {
  id: string;
  cwd: string;
  file: string;
  modifiedAt: number;
  name?: string;
}

export type HistoryBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string }
  | { kind: "toolCall"; toolCallId: string; toolName: string; rawInput: string }
  | { kind: "image"; data: string; mimeType: string }
  | { kind: "bash"; command: string; output: string; exitCode?: number; cancelled?: boolean; truncated?: boolean };

export interface HistoryEntry {
  role: "user" | "assistant" | "compaction";
  blocks: HistoryBlock[];
  /**
   * For a `compaction` entry: the summary that replaced the earlier context,
   * and the token count it replaced. Both come straight from the session
   * file, so a live marker and a reloaded one render identically.
   */
  summary?: string;
  tokensBefore?: number;
  /** Set when the assistant reply ended because the run was aborted. */
  aborted?: boolean;
  /** Set when the assistant reply ended in a provider error; its message. */
  error?: string;
}

/** A tool call's result, joined to its call by toolCallId. */
export interface ToolResultEntry {
  text: string;
  isError: boolean;
  /** The edit tool's diff, from the result's `details.diff`. */
  diff?: string;
  /** Image blocks the tool returned (read on an image file, screenshots). */
  images?: Array<{ data: string; mimeType: string }>;
}

export interface SessionHistory {
  entries: HistoryEntry[];
  toolResults: Record<string, ToolResultEntry>;
}

const liveSessions = new Map<string, SessionHandle>();

// ── Session directory (realtime list transitions) ─────────────────────────
// The sidebar shows the running/idle state of EVERY session, not just the
// selected one. This is a global subscription independent of browser
// streams: it emits running flips and add/remove transitions so one SSE
// stream can replace the /api/sessions poll.

export type SessionDirectoryEvent =
  | { type: "session_running"; id: string; running: boolean }
  | { type: "session_added"; session: SessionInfo }
  | { type: "session_removed"; id: string }
  | { type: "session_renamed"; id: string; name: string }
  | { type: "code_changes"; message: string }
  /**
   * The client bundle on disk changed (a rebuild without a restart). The page
   * compares `buildId` with the id stamped into its own HTML and reloads onto
   * the newer bundle.
   */
  | { type: "build_changed"; buildId: string }
  /**
   * The served plugin registry changed (enable, disable, reload, quarantine,
   * safe mode). The client fetches `/api/plugins` once per page load, so
   * without this frame an open tab keeps the plugin set it was opened with —
   * and two tabs opened at different times disagree about what is installed.
   */
  | { type: "plugins_changed" };

/**
 * Unique identity of this server process. The directory stream sends it on
 * `sessions_snapshot` so a browser reconnecting after a reload sees that the
 * server restarted and reloads the page onto the fresh bundle.
 */
const SERVER_BOOT_ID = `${process.pid}-${Date.now().toString(36)}`;

export function getServerBootId(): string {
  return SERVER_BOOT_ID;
}

/** Tell connected browsers that code changed and the web is reloading. */
export function announceCodeChanges(message = "There are code changes — reloading…"): void {
  emitDirectory({ type: "code_changes", message });
}

/** Tell connected browsers to re-read `/api/plugins`: the served set changed. */
export function announcePluginsChanged(): void {
  emitDirectory({ type: "plugins_changed" });
}

/** Tell connected browsers a newer client bundle is on disk. */
export function announceBuildChanged(buildId: string): void {
  emitDirectory({ type: "build_changed", buildId });
}

const directoryListeners = new Set<(event: SessionDirectoryEvent) => void>();

export function subscribeSessionDirectory(listener: (event: SessionDirectoryEvent) => void): () => void {
  directoryListeners.add(listener);
  return () => {
    directoryListeners.delete(listener);
  };
}

function emitDirectory(event: SessionDirectoryEvent): void {
  for (const listener of Array.from(directoryListeners)) {
    try {
      listener(event);
    } catch {
      // A failing listener (a dead SSE stream) cannot break the directory.
    }
  }
}

// One permanent tap per live session: it detects running/idle flips from the
// session's own lifecycle events so listeners see transitions, not a re-read.
const directoryTaps = new Map<string, () => void>();

// The last running value announced per session, so both detection paths
// (lifecycle events and bridge state posts) dedupe their flips.
const directoryRunning = new Map<string, boolean>();

/**
 * Announce a running/idle flip for one session — deduped: a repeated value
 * (an attach-time state post matching the last known flip, say) is silent.
 */
export function setSessionRunning(id: string, running: boolean): void {
  if (directoryRunning.get(id) === running) return;
  directoryRunning.set(id, running);
  emitDirectory({ type: "session_running", id, running });
}

// ── The split-brain guard ──────────────────────────────────────────────────
// A TUI bridge OWNS its session. While the bridge is attached — or within
// the self-heal grace window after it drops — the web must NEVER resume
// that session in-process: two AgentSessions on one file split the
// frontends (the web's prompts run on the server's copy; the TUI's turns
// never reach the web). `ensureSession` waits out the window instead; if
// the TUI is truly gone, the grace expires and the resume becomes legal.

/** How long a detached bridge's ownership holds while it self-heals back. */
const BRIDGE_GRACE_MS = 10_000;
/** id -> ownership expires at (Infinity while attached). */
const bridgeOwnership = new Map<string, number>();

export function markBridgeAttached(id: string): void {
  bridgeOwnership.set(id, Number.POSITIVE_INFINITY);
}

export function markBridgeDetached(id: string): void {
  // Only mark a grace when the bridge actually owned the session; a
  // re-attach over a fresh id starts clean.
  bridgeOwnership.set(id, Date.now() + BRIDGE_GRACE_MS);
}

export function isBridgeOwned(id: string): boolean {
  const until = bridgeOwnership.get(id);
  if (until === undefined) return false;
  if (until === Number.POSITIVE_INFINITY) return true;
  if (until <= Date.now()) {
    bridgeOwnership.delete(id);
    return false;
  }
  return true;
}

function toCore(inner: AgentSession): SessionCore {
  const getCommands = (): Array<{ name: string; description?: string }> =>
    // The contributed web commands carry the flags the web needs (dispatch
    // channel, the picker's add entry). A bridged session gets them from the
    // extension's `web_commands` post; an in-process session reads the same
    // registry, so both frontends see the same list.
    annotateContributedCommands(
      inner.extensionRunner
        .getRegisteredCommands()
        .map((command) => ({
          name: command.invocationName,
          ...(command.description !== undefined ? { description: command.description } : {}),
        })),
      announcedWebCommands(inner.sessionId),
    );
  // The same list the TUI's /model picker offers: scoped models when
  // scoping is active, otherwise the available catalogue snapshot.
  const modelRefs = (): Array<{ provider: string; id: string }> => {
    const scoped = inner.scopedModels;
    const source = scoped.length > 0 ? scoped.map((scopedModel) => scopedModel.model) : inner.modelRuntime.getAvailableSnapshot();
    return source.map((model) => ({ provider: model.provider, id: model.id }));
  };
  // Every model the runtime offers — the picker's "all" tab. The scoped
  // list drives Ctrl+P; picking from all of them is still allowed, like the
  // TUI's full selector.
  const allModelRefs = (): Array<{ provider: string; id: string }> =>
    inner.modelRuntime.getAvailableSnapshot().map((model) => ({ provider: model.provider, id: model.id }));
  // A permanent tap on the session's raw events keeps the in-flight
  // streaming snapshot current from the session's birth — not from the
  // first browser stream — so any (re)connect can replay it.
  const streamTracker = createStreamTracker();
  inner.subscribe(streamTracker.feed);
  return {
    sessionId: inner.sessionId,
    getSessionName: () => inner.sessionManager?.getSessionName?.(),
    subscribe: (listener: (event: unknown) => void) => inner.subscribe(listener),
    getStreamSnapshot: (): StreamSnapshot => streamTracker.snapshot(),
    getTreeNodes: (): WebTreeNode[] | null => {
      const manager = inner.sessionManager;
      const tree = manager?.getTree?.() ?? [];
      if (tree.length === 0) return null;
      return buildWebTree(
        tree as unknown as Parameters<typeof buildWebTree>[0],
        manager?.getLeafId?.() ?? null,
      );
    },
    dispose: (): void => {
      // Releasing the tap plus the AgentSession itself: a displaced
      // in-process copy must not stay live on the session file.
      inner.dispose();
    },
    // Prompts pass through AgentSession.prompt with its default
    // expandPromptTemplates: "/command …" dispatches extension commands;
    // steer queues the message when a run is already streaming, like the TUI.
    prompt: (text: string, images?: Array<{ data: string; mimeType: string }>) =>
      inner.prompt(text, {
        streamingBehavior: "steer",
        ...(images !== undefined && images.length > 0
          ? { images: images.map((image) => ({ type: "image" as const, ...image })) }
          : {}),
      }),
    abort: () => inner.abort(),
    isStreaming: () => inner.isStreaming,
    getState: () => {
      const usage = inner.getContextUsage();
      const agentState = (inner as { agent?: { state?: { thinkingLevel?: string } } }).agent?.state;
      return {
        sessionId: inner.sessionId,
        sessionFile: inner.sessionFile ?? "",
        isStreaming: inner.isStreaming,
        isBashRunning: inner.isBashRunning,
        isCompacting: inner.isCompacting,
        model: inner.model ? { provider: inner.model.provider, id: inner.model.id } : undefined,
        contextUsage: usage
          ? {
            percent: usage.percent ?? 0,
            contextWindow: usage.contextWindow ?? 0,
            tokens: usage.tokens ?? 0,
          }
          : null,
        thinkingLevel: agentState?.thinkingLevel ?? "off",
      };
    },
    getCommands,
    getModels: () => ({
      models: modelRefs(),
      all: allModelRefs(),
      ...(inner.model !== undefined ? { current: { provider: inner.model.provider, id: inner.model.id } } : {}),
    }),
    setModel: async (provider: string, id: string) => {
      const model = inner.modelRuntime.getAvailableSnapshot().find(
        (candidate) => candidate.provider === provider && candidate.id === id,
      );
      if (model === undefined) return false;
      await inner.setModel(model, { persist: false });
      return true;
    },
    setThinkingLevel: async (level: string) => {
      await inner.setThinkingLevel(level as never, { persist: false });
      return true;
    },
    webCommand: async (name: string, args: string) => {
      // A command an extension contributed: it runs in the extension that
      // announced it, on the session bus (the only channel that reaches it —
      // pi evaluates each extension with its own module graph).
      sessionBus(inner.sessionId)?.emit?.(WEB_PLUGIN_WEB_COMMAND_EVENT, { name, args });
    },
    // Compaction is the core's own: this process owns the session, so it
    // runs the compaction directly and the browser's live status, transcript
    // marker and failure notice all come from this session's own events.
    compact: async (instructions?: string) => {
      const trimmed = (instructions ?? "").trim();
      await inner.compact(trimmed === "" ? undefined : trimmed);
    },
  };
}

/**
 * One permanent tap per live session: running/idle flips, the kernel hooks, and
 * the plugin event tap (every live event a plugin may subscribe to).
 */
function trackSessionEvents(core: SessionCore, cwd: string): void {
  const id = core.sessionId;
  directoryTaps.get(id)?.();
  directoryTaps.delete(id);
  directoryRunning.set(id, core.getState().isStreaming);
  const unsubscribe = core.subscribe((event: unknown) => {
    const typed = event as { type?: unknown; name?: string; message?: unknown; toolCallId?: string; toolName?: string; isError?: boolean } | null;
    const type = typed?.type;
    const host = getPluginHost();
    publishSessionTapEvent(host?.events ?? null, id, cwd, event);
    if (type === "agent_start") {
      setSessionRunning(id, true);
    } else if (type === "agent_settled") {
      setSessionRunning(id, false);
      if (host !== null) void host.hooks.event("session.settled", { sessionId: id, project: cwd });
    } else if (type === "session_shutdown") {
      setSessionRunning(id, false);
    } else if (type === "session_info_changed") {
      recordSessionName(id, typed?.name);
    } else if (type === "message_end" && host !== null) {
      void host.hooks.event("message.appended", { sessionId: id, project: cwd, message: typed?.message });
    } else if (type === "tool_execution_end" && host !== null) {
      void host.hooks.event("tool.finished", {
        sessionId: id,
        project: cwd,
        toolCallId: typed?.toolCallId,
        toolName: typed?.toolName,
        isError: typed?.isError === true,
      });
    }
  });
  directoryTaps.set(id, unsubscribe);
}

/** Names of live sessions, kept current from rename events. */
const sessionNames = new Map<string, string>();

/**
 * A session's name changed (a person's /name, a generated title, or a bridge
 * report). Remembers it and tells the directory stream; an unchanged name is
 * not re-announced.
 */
export function recordSessionName(id: string, name: string | undefined): void {
  const next = name?.trim() ?? "";
  if ((sessionNames.get(id) ?? "") === next) return;
  if (next === "") sessionNames.delete(id);
  else sessionNames.set(id, next);
  emitDirectory({ type: "session_renamed", id, name: next });
}

function register(core: SessionCore, cwd: string, sessionFile: string, inner?: unknown): SessionCore {
  const replaced = liveSessions.get(core.sessionId);
  liveSessions.set(core.sessionId, {
    core,
    cwd,
    sessionFile,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
  });
  if (replaced !== undefined && replaced.core !== core) {
    // The displaced owner (an in-process resume or a headless host a bridge
    // just took over) is released: no second AgentSession stays live on the
    // file. A host that reattaches has already unregistered, so this is only
    // reached when a different process took the session.
    if (replaced.core.bridgeOf !== undefined && isSessionHosted(core.sessionId)) stopSessionHost(core.sessionId);
    replaced.core.dispose?.();
    // Someone else now owns this session (a bridge over an in-process
    // resume). Wake every stream watching the old owner so they reconnect
    // to the live one. Array.from snapshots: a listener's cleanup can
    // unsubscribe from the set while the loop runs.
    const listeners = replacementListeners.get(core.sessionId);
    if (listeners !== undefined) for (const listener of Array.from(listeners)) listener();
  }
  // Attach the web-plugin host to the live session's extension event bus so
  // plugin views and UI events flow into the store. The host reads the
  // { sessionId, inner, onEvent } wrapper shape itself; fake cores pass no inner.
  if (inner !== undefined) {
    void attachSessionPlugins({
      sessionId: core.sessionId,
      inner,
      onEvent: (listener: (event: { type?: string }) => void) =>
        core.subscribe((event: unknown) => listener(event as { type?: string })),
    });
  }
  // Session directory: track this live session's running/idle transitions
  // and announce its membership (the replace path re-announces, so a bridge
  // takeover or an in-process resume both refresh the listing).
  const seeded = core.getSessionName?.()?.trim();
  if (seeded) sessionNames.set(core.sessionId, seeded);
  trackSessionEvents(core, cwd);
  const registered = liveSessions.get(core.sessionId);
  if (registered !== undefined) {
    emitDirectory({ type: "session_added", session: sessionInfoOf(registered) });
    if (replaced === undefined) {
      const host = getPluginHost();
      if (host !== null) void host.hooks.event("session.created", { sessionId: core.sessionId, project: cwd });
    }
  }
  return core;
}

/**
 * Apply the `enabledModels` scope to an in-process session, mirroring the
 * CLI/TUI. The interactive, print and rpc runners resolve `enabledModels` into
 * `scopedModels` before serving a session; without it the web picker falls
 * back to the full available snapshot and diverges from sessions opened in the
 * TUI. A resolution failure (e.g. an auth-refresh timeout) is deliberately
 * swallowed: the picker then serves the available snapshot, exactly as the TUI
 * does when no scope resolves.
 */
export async function applyEnabledModelScope(session: AgentSession): Promise<void> {
  const patterns = session.settingsManager.getEnabledModels();
  if (patterns === undefined || patterns.length === 0) return;
  try {
    const { scopedModels } = await resolveModelScopeWithDiagnostics(patterns, session.modelRuntime, {
      signal: AbortSignal.timeout(15_000),
    });
    session.setScopedModels(
      scopedModels.map((scoped) => ({ model: scoped.model, thinkingLevel: scoped.thinkingLevel })),
    );
  } catch {
    // Scope resolution is best-effort; an empty scope keeps the full snapshot.
  }
}

/** Spawn a brand-new pi session with the project's real extensions loaded. */
export async function startSession(options: {
  cwd: string;
  agentDir?: string;
}): Promise<SessionCore> {
  if (externalSessionHostEnabled(process.env, process.platform)) {
    const sessionId = randomUUID();
    await startSessionHost({
      sessionId,
      cwd: options.cwd,
      isAttached: () => getSession(sessionId)?.core.bridgeOf !== undefined,
    });
    const core = getSession(sessionId)?.core;
    if (core === undefined) throw new Error(`session host for ${sessionId} attached without a core`);
    return core;
  }
  const { session } = await createAgentSession({
    cwd: options.cwd,
    sessionStartEvent: { type: "session_start", reason: "new" },
    ...(options.agentDir !== undefined ? { agentDir: options.agentDir } : {}),
  });
  await applyEnabledModelScope(session);
  // The interactive/rpc/print runners all bind extensions (which emits
  // `session_start`) before serving the session; the in-process web runner
  // must too, or plugins never publish their resting views until a prompt
  // fires an agent event. Bind headlessly: views publish onto the session
  // bus, and the TUI-only `ctx.ui` methods stay safe no-ops.
  await session.bindExtensions({ uiContext: createHeadlessWebUiContext() });
  return register(toCore(session), options.cwd, session.sessionFile ?? "", session);
}

/** Resume a session from its .jsonl file. */
export async function resumeSession(options: {
  sessionFile: string;
  agentDir?: string;
}): Promise<SessionCore> {
  const manager = SessionManager.open(options.sessionFile, undefined);
  const cwd = manager.getCwd();
  const { session } = await createAgentSession({
    cwd,
    sessionManager: manager,
    sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile: options.sessionFile },
    ...(options.agentDir !== undefined ? { agentDir: options.agentDir } : {}),
  });
  await applyEnabledModelScope(session);
  // Same rationale as startSession: a resumed session must republish its
  // resting plugin views the moment it is opened, not on the first turn.
  await session.bindExtensions({ uiContext: createHeadlessWebUiContext() });
  return register(toCore(session), cwd, options.sessionFile, session);
}

/** Register a fake core (tests and fixtures). */
export function registerSession(core: SessionCore, cwd: string, sessionFile = ""): void {
  register(core, cwd, sessionFile);
}

/**
 * Streams watching a session that gets REPLACED (a TUI bridge attaching over
 * an in-process resume, or a re-attach) must end so the browser reconnects
 * and resolves the new owner — otherwise they keep watching a frozen copy.
 */
const replacementListeners = new Map<string, Set<() => void>>();

export function onSessionReplaced(sessionId: string, listener: () => void): () => void {
  let listeners = replacementListeners.get(sessionId);
  if (listeners === undefined) {
    listeners = new Set();
    replacementListeners.set(sessionId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) replacementListeners.delete(sessionId);
  };
}

export function clearSessionsForTests(): void {
  liveSessions.clear();
  bridgeOwnership.clear();
  for (const unsubscribe of directoryTaps.values()) unsubscribe();
  directoryTaps.clear();
  directoryRunning.clear();
  directoryListeners.clear();
}

export function getSession(id: string): SessionHandle | undefined {
  return liveSessions.get(id);
}

/** Drop a live session registration (bridge detach or replacement). */
export function unregisterSession(id: string): void {
  liveSessions.delete(id);
  directoryTaps.get(id)?.();
  directoryTaps.delete(id);
  directoryRunning.delete(id);
  emitDirectory({ type: "session_removed", id });
}

function sessionInfoOf(handle: SessionHandle): SessionInfo {
  const name = sessionNames.get(handle.core.sessionId);
  return {
    id: handle.core.sessionId,
    cwd: handle.cwd,
    sessionFile: handle.sessionFile,
    live: true,
    running: handle.core.getState().isStreaming,
    modifiedAt: handle.lastActivityAt,
    ...(name !== undefined ? { name } : {}),
  };
}

export function listLiveSessions(): SessionInfo[] {
  return [...liveSessions.values()].map(sessionInfoOf);
}

/**
 * What a restart would cost right now. In-process sessions die with this
 * process; bridged ones keep running elsewhere but lose their web front end.
 * The reload guard uses both counts before it stops the server.
 */
export function reloadStateOf(): ServerReloadState {
  const state: ServerReloadState = { liveSessions: 0, runningSessions: 0, bridgedSessions: 0 };
  for (const handle of liveSessions.values()) {
    if (handle.core.bridgeOf !== undefined) state.bridgedSessions++;
    else state.liveSessions++;
    if (handle.core.getState().isStreaming) state.runningSessions++;
  }
  return state;
}

/**
 * How many disk sessions a search considers.
 *
 * The list window is small on purpose — the sidebar shows recent work, and a
 * name scan costs a backwards read of the session file. A *search* is
 * different: the user is looking for one session they know exists, and a
 * generated title on an older session must still be found. So a query widens
 * the scan; the returned rows stay bounded by what actually matches.
 */
const SEARCH_SCAN_LIMIT = 500;

/** Whether one row matches a lower-cased needle: id, project path, or name. */
function matchesQuery(row: SessionInfo, needle: string): boolean {
  return row.id.toLowerCase().includes(needle)
    || row.cwd.toLowerCase().includes(needle)
    || (row.name?.toLowerCase().includes(needle) ?? false);
}

/**
 * Narrow rows to a query. A plugin may take over through
 * `service:session.search`; without a host, or without a service, the host's
 * own matcher runs — a query is never silently ignored.
 */
async function narrowToQuery(
  host: PluginHost<WebPluginDescriptor> | null,
  rows: SessionInfo[],
  query: string,
): Promise<SessionInfo[]> {
  const service = host?.services.resolve<
    (rows: SessionInfo[], q: string) => SessionInfo[] | Promise<SessionInfo[]>
  >("session.search");
  if (service !== undefined) {
    const matched = await service(rows, query);
    if (Array.isArray(matched)) return matched;
  }
  const needle = query.toLowerCase();
  return rows.filter((row) => matchesQuery(row, needle));
}

/**
 * The name a row shows: what this process was told, else what the file holds.
 *
 * `sessionNames` is the directory's memory of every rename it observed (a
 * `session_info_changed`, a bridge `session_name`, an attach-time `state.name`),
 * so it is at least as fresh as the file for a session this process watched.
 * The fallback matters because a session's row outlives its liveness: when a
 * TUI-owned session detaches, its row becomes a disk row, and a bridge writes
 * the name in the *TUI* process — so the web server's copy of the file may
 * never contain the title at all. Reading only the file would drop a generated
 * title from the sidebar at that moment.
 */
function displayNameOf(sessionId: string, fromFile: string | undefined): string | undefined {
  return sessionNames.get(sessionId) ?? fromFile;
}

/**
 * Combined live + disk session snapshot, transformed through `session.list.sort`
 * waterfall hooks and filtered by `service:session.search` when `query` is set.
 */
export async function listAllSessions(options?: { agentDir?: string; query?: string }): Promise<SessionInfo[]> {
  const query = options?.query?.trim() ?? "";
  const live = listLiveSessions();
  const liveIds = new Set(live.map((session) => session.id));
  // A search reaches further back than the sidebar's window, or a titled
  // session that fell out of it would be unfindable by its own title.
  const disk = await listDiskSessions({
    agentDir: options?.agentDir,
    ...(query === "" ? {} : { limit: SEARCH_SCAN_LIMIT }),
  });
  let sessions: SessionInfo[] = [
    ...live,
    ...disk
      .filter((session) => !liveIds.has(session.id))
      .map((session) => {
        const name = displayNameOf(session.id, session.name);
        return {
          id: session.id,
          cwd: session.cwd,
          sessionFile: session.file,
          live: false,
          running: false,
          modifiedAt: session.modifiedAt,
          ...(name !== undefined ? { name } : {}),
        };
      }),
  ];
  const host = getPluginHost();
  if (host !== null) {
    const sorted = await host.hooks.waterfall("session.list.sort", sessions, {});
    if (Array.isArray(sorted)) sessions = sorted;
  }
  return query === "" ? sessions : narrowToQuery(host, sessions, query);
}

export type DeleteSessionResult =
  | { status: "ok" }
  | { status: "not_found" }
  | { status: "vetoed"; reason: string; pluginId: string };

/**
 * Delete a session after consulting `session.before-delete` bail hooks. A veto
 * stops deletion, records the veto in the kernel audit log, and surfaces the
 * plugin's reason to the caller.
 */
export async function deleteSession(id: string, options?: { agentDir?: string }): Promise<DeleteSessionResult> {
  const live = liveSessions.get(id);
  const file = live?.sessionFile || (await resolveSessionFile(id, options?.agentDir));
  if (live === undefined && file === null) {
    return { status: "not_found" };
  }
  const cwd = live?.cwd ?? (file !== null ? ((await readSessionHeader(file))?.cwd ?? "") : "");
  const name = sessionNames.get(id);
  const host = getPluginHost();
  if (host !== null) {
    const veto = await host.hooks.bail("session.before-delete", {
      session: {
        id,
        cwd,
        live: live !== undefined,
        ...(name !== undefined ? { name } : {}),
      },
    });
    if (veto.denied) {
      host.manager.recordVeto(veto.pluginId, "session.before-delete", veto.reason);
      return { status: "vetoed", reason: veto.reason, pluginId: veto.pluginId };
    }
  }
  if (live !== undefined) {
    live.core.dispose?.();
    unregisterSession(id);
  }
  if (isSessionHosted(id)) stopSessionHost(id);
  sessionNames.delete(id);
  if (file !== null && file !== "") {
    diskNameCache.delete(file);
    await unlink(file).catch(() => undefined);
  }
  return { status: "ok" };
}

export interface SessionInfo {
  id: string;
  cwd: string;
  sessionFile: string;
  live: boolean;
  modifiedAt: number;
  /** The session is mid-turn right now (agent streaming), for live sessions. */
  running?: boolean;
  /** The display name: a person's /name, or a generated title. Absent when unnamed. */
  name?: string;
}

function sessionsRoot(agentDir?: string): string {
  return join(agentDir ?? getAgentDir(), "sessions");
}

function sessionIdFromFileName(fileName: string): string | null {
  const withoutExt = fileName.replace(/\.jsonl$/, "");
  const parts = withoutExt.split("_");
  const id = parts[parts.length - 1];
  return /^[0-9a-f-]{8,}$/i.test(id) ? id : null;
}

interface SessionHeaderLike {
  type?: string;
  id?: string;
  cwd?: string;
  timestamp?: string;
}

/**
 * Read only the first line of a session file, streaming: a directory scan
 * must never load whole session files (they run to megabytes) just to read
 * a header.
 */
async function readSessionHeader(file: string): Promise<SessionHeaderLike | null> {
  return new Promise((resolve) => {
    const stream = createReadStream(file, { encoding: "utf-8" });
    let settled = false;
    let buffer = "";
    const finish = (value: SessionHeaderLike | null): void => {
      if (settled) return;
      settled = true;
      stream.destroy();
      resolve(value);
    };
    stream.on("data", (chunk: string | Buffer) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        try {
          const parsed = JSON.parse(buffer.slice(0, newline)) as SessionHeaderLike;
          finish(parsed.type === "session" ? parsed : null);
        } catch {
          finish(null);
        }
        return;
      }
      // A header line never spans 64 KB; stop reading instead of buffering.
      if (buffer.length > 65_536) finish(null);
    });
    stream.on("error", () => finish(null));
    stream.on("end", () => {
      try {
        const parsed = JSON.parse(buffer) as SessionHeaderLike;
        finish(parsed.type === "session" ? parsed : null);
      } catch {
        finish(null);
      }
    });
  });
}

/** Every session .jsonl file under the sessions root, in directory order. */
async function listSessionFiles(root: string): Promise<string[]> {
  let projectDirs: string[];
  try {
    projectDirs = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const projectDir of projectDirs) {
    let entries: string[];
    try {
      entries = await readdir(join(root, projectDir));
    } catch {
      continue;
    }
    for (const fileName of entries) {
      if (fileName.endsWith(".jsonl")) files.push(join(root, projectDir, fileName));
    }
  }
  return files;
}

/** How far back a session file is searched for its latest name, and the step size. */
const NAME_SCAN_LIMIT_BYTES = 4 * 1024 * 1024;
const NAME_SCAN_STEP_BYTES = 64 * 1024;
/** Keyed by file; a name is rescanned only when the file's mtime moves. */
const diskNameCache = new Map<string, { mtimeMs: number; name?: string }>();

/**
 * The name a session_info line carries: its string, `""` for a cleared name,
 * or null when the line is not a session_info entry.
 */
function sessionInfoNameOf(line: string): string | null {
  if (!line.includes('"session_info"')) return null;
  try {
    const entry = JSON.parse(line) as { type?: unknown; name?: unknown };
    if (entry.type !== "session_info") return null;
    return typeof entry.name === "string" ? entry.name : "";
  } catch {
    return null;
  }
}

/**
 * The session's latest name, found by reading the file backwards in steps. The
 * name is written as a session_info entry, which can sit far from the end of a
 * long session, so the search is bounded and the answer is cached by mtime.
 */
async function latestSessionName(file: string, mtimeMs: number): Promise<string | undefined> {
  const cached = diskNameCache.get(file);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.name;
  const name = await scanForLatestName(file);
  diskNameCache.set(file, { mtimeMs, name });
  return name;
}

async function scanForLatestName(file: string): Promise<string | undefined> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    let end = size;
    // The text after `end` whose line has not started yet, in the previous step.
    let pending = "";
    let scanned = 0;
    while (end > 0 && scanned < NAME_SCAN_LIMIT_BYTES) {
      const start = Math.max(0, end - NAME_SCAN_STEP_BYTES);
      const buffer = Buffer.alloc(end - start);
      await handle.read(buffer, 0, buffer.length, start);
      const lines = (buffer.toString("utf-8") + pending).split("\n");
      // The first piece is a partial line unless this step reached the file start.
      pending = start > 0 ? (lines.shift() ?? "") : "";
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const name = sessionInfoNameOf(lines[index]);
        if (name !== null) return name.trim() || undefined;
      }
      scanned += end - start;
      end = start;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

/** A session file found in the directory, before its header is read. */
interface SessionCandidate {
  file: string;
  modifiedAt: number;
}

/** A header read for one file, kept while the file's mtime is unchanged. */
const headerCache = new Map<string, { mtimeMs: number; header: SessionHeaderLike | null }>();

/** Stat every candidate in parallel, newest first. A file that vanished since the listing is dropped. */
async function statCandidates(files: string[]): Promise<SessionCandidate[]> {
  const stats = await Promise.all(files.map(async (file) => {
    try {
      return { file, modifiedAt: (await stat(file)).mtimeMs };
    } catch {
      return null;
    }
  }));
  return stats
    .filter((candidate): candidate is SessionCandidate => candidate !== null)
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
}

async function headerOf(candidate: SessionCandidate): Promise<SessionHeaderLike | null> {
  const cached = headerCache.get(candidate.file);
  if (cached !== undefined && cached.mtimeMs === candidate.modifiedAt) return cached.header;
  const header = await readSessionHeader(candidate.file);
  headerCache.set(candidate.file, { mtimeMs: candidate.modifiedAt, header });
  return header;
}

/**
 * The newest `limit` sessions with a valid header. Headers are read only until
 * the limit is full, so a directory of thousands of older sessions costs about
 * `limit` reads, not one per file. Invalid files do not count toward the limit.
 */
async function sessionsNewestFirst(candidates: SessionCandidate[], limit: number): Promise<DiskSession[]> {
  const found: DiskSession[] = [];
  for (const candidate of candidates) {
    if (found.length >= limit) break;
    const header = await headerOf(candidate);
    if (header?.id === undefined || header.cwd === undefined) continue;
    found.push({ id: header.id, cwd: header.cwd, file: candidate.file, modifiedAt: candidate.modifiedAt });
  }
  return found;
}

/** Sessions on disk under the agent dir, newest first, capped. */
export async function listDiskSessions(options?: {
  agentDir?: string;
  limit?: number;
}): Promise<DiskSession[]> {
  const root = sessionsRoot(options?.agentDir);
  if (!existsSync(root)) return [];
  const limit = options?.limit ?? 30;
  const found = await sessionsNewestFirst(await statCandidates(await listSessionFiles(root)), limit);
  // Names are read only for the sessions returned, never for the whole directory.
  return Promise.all(found.map(async (session) => {
    const name = await latestSessionName(session.file, session.modifiedAt);
    return name === undefined ? session : { ...session, name };
  }));
}

/**
 * The session's project directory: the live handle's cwd when it is running,
 * otherwise the session header's recorded cwd (read-only, no resume). Null when
 * the session is unknown or its header is unreadable.
 */
export async function resolveSessionRoot(id: string, agentDir?: string): Promise<string | null> {
  const live = liveSessions.get(id);
  if (live !== undefined) return live.cwd;
  const file = await resolveSessionFile(id, agentDir);
  if (file === null) return null;
  const header = await readSessionHeader(file);
  return typeof header?.cwd === "string" && header.cwd !== "" ? header.cwd : null;
}

/** Find a session file by id, matching the header id or the filename suffix. */
export async function resolveSessionFile(id: string, agentDir?: string): Promise<string | null> {
  if (!/^[0-9a-zA-Z-]+$/.test(id)) return null;
  const root = sessionsRoot(agentDir);
  if (!existsSync(root)) return null;
  for (const file of await listSessionFiles(root)) {
    if (sessionIdFromFileName(basename(file)) === id) return file;
  }
  return null;
}

function contentToBlocks(content: unknown): HistoryBlock[] {
  if (typeof content === "string") {
    return content ? [{ kind: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: HistoryBlock[] = [];
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ kind: "text", text: block.text });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      blocks.push({ kind: "thinking", thinking: block.thinking });
    } else if (block.type === "image" && typeof block.data === "string") {
      blocks.push({
        kind: "image",
        data: block.data,
        mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/png",
      });
    } else if (block.type === "toolCall") {
      // pi's on-disk spelling is { id, name, arguments }; the browser's is
      // { toolCallId, toolName, rawInput }. Accept both.
      const args = typeof block.arguments === "object" && block.arguments !== null
        ? (block.arguments as Record<string, unknown>)
        : undefined;
      blocks.push({
        kind: "toolCall",
        toolCallId: typeof block.toolCallId === "string"
          ? block.toolCallId
          : (typeof block.id === "string" ? block.id : ""),
        toolName: typeof block.toolName === "string"
          ? block.toolName
          : (typeof block.name === "string" ? block.name : "tool"),
        rawInput: typeof block.rawInput === "string"
          ? block.rawInput
          : args !== undefined && Object.keys(args).length > 0 ? JSON.stringify(args) : "",
      });
    }
  }
  return blocks;
}

/** Tool-result message content → plain text, images and the edit diff. */
function contentToResult(content: unknown): {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
} {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };
  const parts: string[] = [];
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const raw of content) {
    if (typeof raw === "object" && raw !== null) {
      const block = raw as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (block.type === "image" && typeof block.data === "string") {
        images.push({ data: block.data, mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/png" });
      }
    }
  }
  return { text: parts.join("\n"), images };
}

/** The edit tool's diff from a tool result's `details`. */
function detailsDiff(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const diff = (details as { diff?: unknown }).diff;
  return typeof diff === "string" && diff !== "" ? diff : undefined;
}

/**
 * Parse the transcript entries and tool results from a session file — the
 * LAST `limit` entries, not the first. A session file grows unboundedly
 * (thousands of entries over a working day); the visible window is its
 * tail. Reading from the head would show the conversation's opening and
 * silently drop every later message — the web looking "not synced" on any
 * long-running session.
 */
/** Lines pi writes for transcript entries; a tool result is also a message line, so it is excluded below. */
const ENTRY_LINE_PREFIXES = [Buffer.from('{"type":"message"'), Buffer.from('{"type":"compaction"')];
const TOOL_RESULT_ROLE = Buffer.from('"role":"toolResult"');

/** Whether one line (no line break) is a transcript entry that the window may hold. */
function isEntryLine(line: Buffer): boolean {
  const looksLikeEntry = ENTRY_LINE_PREFIXES.some((prefix) => line.subarray(0, prefix.length).equals(prefix));
  return looksLikeEntry && !line.includes(TOOL_RESULT_ROLE);
}

/**
 * Offset of the line that starts the last `needed` entry lines, or 0 when there
 * are fewer. A byte scan from the end: no JSON is parsed here. It can still
 * miscount (a formatting change in pi's JSON), so the caller checks the parsed
 * window and widens the region when it falls short.
 */
export function tailStartOffset(buffer: Buffer, needed: number): number {
  let found = 0;
  let lineEnd = buffer.length;
  while (lineEnd > 0) {
    const newline = buffer.lastIndexOf(0x0a, lineEnd - 1);
    const lineStart = newline + 1;
    if (isEntryLine(buffer.subarray(lineStart, lineEnd))) {
      found++;
      if (found >= needed) return lineStart;
    }
    if (newline < 0) break;
    lineEnd = newline;
  }
  return 0;
}

/** A session's transcript can be tens of megabytes; a reply needs its tail. */
const HISTORY_TAIL_WINDOW_BYTES = 1024 * 1024;

async function readTail(handle: Awaited<ReturnType<typeof open>>, size: number, window: number): Promise<Buffer> {
  const length = Math.min(window, size);
  if (length === 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, size - length);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

/** Drop a partial first line when the window starts in the middle of the file. */
function alignTail(bytes: Buffer, size: number, window: number): Buffer {
  if (window >= size) return bytes;
  const newline = bytes.indexOf(0x0a);
  return newline < 0 ? bytes : bytes.subarray(newline + 1);
}

export async function readHistory(sessionFile: string, limit = 200): Promise<SessionHistory> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(sessionFile, "r");
  } catch {
    return { entries: [], toolResults: {} };
  }
  try {
    const { size } = await handle.stat();
    let window = HISTORY_TAIL_WINDOW_BYTES;
    let needed = limit;
    for (;;) {
      const bytes = alignTail(await readTail(handle, size, window), size, window);
      const start = tailStartOffset(bytes, needed);
      const history = historyFromText(bytes.subarray(start).toString("utf-8"), limit);
      // A full window is the file's exact tail. A short parse from an
      // over-counted line scan widens the search; a short parse at the window
      // boundary means the wanted entries are earlier in the file.
      if (history.entries.length >= limit || window >= size) return history;
      if (start === 0) {
        window *= 2;
        needed = limit;
      } else {
        needed *= 2;
      }
    }
  } finally {
    await handle.close();
  }
}

/** The visible window of a session's text (see readHistory). Pure: the caller reads the file. */
export function historyFromText(text: string, limit: number): SessionHistory {
  // A rolling window over the file in order: the newest `limit` entries
  // survive, the rest roll off. Tool results attach to their calls, which
  // appear earlier in the file than the results, so results are collected
  // while the call is still inside the window.
  const window: HistoryEntry[] = [];
  const windowToolCallIds = new Set<string>();
  const toolResults: Record<string, ToolResultEntry> = {};
  const pushEntry = (entry: HistoryEntry): void => {
    window.push(entry);
    for (const block of entry.blocks) {
      if (block.kind === "toolCall") windowToolCallIds.add(block.toolCallId);
    }
    if (window.length > limit) {
      const rolledOff = window.shift();
      for (const block of rolledOff?.blocks ?? []) {
        if (block.kind === "toolCall") {
          windowToolCallIds.delete(block.toolCallId);
          // Its result leaves with it — the map stays exactly the results
          // of the visible conversation.
          delete toolResults[block.toolCallId];
        }
      }
    }
  };
  const collectToolResult = (toolCallId: string, result: ToolResultEntry): void => {
    // Only results whose calls are (still) in the window — the window and
    // the map stay bounded to the visible conversation.
    if (windowToolCallIds.has(toolCallId)) toolResults[toolCallId] = result;
  };
  for (const line of text.split("\n")) {
    if (!line) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.type === "compaction") {
      // A compaction boundary: pi replaced the context up to this point with
      // a summary. The TUI draws it as a transcript row, so the web does too
      // — without it the conversation appears to jump, and the browser has no
      // way to say why the earlier turns vanished.
      const tokensBefore = typeof parsed.tokensBefore === "number" ? parsed.tokensBefore : undefined;
      pushEntry({
        role: "compaction",
        blocks: [],
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
        ...(tokensBefore !== undefined ? { tokensBefore } : {}),
      });
      continue;
    }
    if (parsed.type !== "message") continue;
    const message = parsed.message;
    if (typeof message !== "object" || message === null) continue;
    const messageRecord = message as Record<string, unknown>;
    const role = messageRecord.role;
    if (role === "toolResult") {
      const toolCallId = messageRecord.toolCallId;
      if (typeof toolCallId === "string" && toolCallId !== "") {
        const { text, images } = contentToResult(messageRecord.content);
        const diff = detailsDiff(messageRecord.details);
        collectToolResult(toolCallId, {
          text,
          isError: messageRecord.isError === true,
          ...(diff !== undefined ? { diff } : {}),
          ...(images.length > 0 ? { images } : {}),
        });
      }
      continue;
    }
    if (role === "bashExecution") {
      // `!` commands the user ran in the TUI: shown in the transcript as a
      // user-side bash row (command, output, exit code).
      const blocks: HistoryBlock[] = [{
        kind: "bash",
        command: typeof messageRecord.command === "string" ? messageRecord.command : "",
        output: typeof messageRecord.output === "string" ? messageRecord.output : "",
        ...(typeof messageRecord.exitCode === "number" ? { exitCode: messageRecord.exitCode } : {}),
        ...(messageRecord.cancelled === true ? { cancelled: true } : {}),
        ...(messageRecord.truncated === true ? { truncated: true } : {}),
      }];
      pushEntry({ role: "user", blocks });
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    const blocks = contentToBlocks(messageRecord.content);
    const entry: HistoryEntry = { role, blocks };
    if (role === "assistant") {
      if (messageRecord.stopReason === "aborted") {
        entry.aborted = true;
      } else if (messageRecord.stopReason === "error") {
        entry.error = typeof messageRecord.errorMessage === "string" && messageRecord.errorMessage !== ""
          ? messageRecord.errorMessage
          : "provider error";
      }
    }
    // An aborted or failed reply carries its status as visible content even
    // when no text block survived (pi persists an errored message with an
    // empty body) — dropping it would lose the error on reload.
    if (blocks.length > 0 || entry.aborted === true || entry.error !== undefined) {
      pushEntry(entry);
    }
  }
  return { entries: window, toolResults };
}

export interface PromptImage {
  data: string;
  mimeType: string;
}

export type SessionCommand =
  | { type: "prompt"; message: string; images?: PromptImage[] }
  | { type: "abort" }
  | { type: "get_state" }
  | { type: "web_command"; name: string; args?: string };

export type CommandResult =
  | { status: "ok"; data: unknown }
  | { status: "not_found" }
  | { status: "error"; error: string };

const validateSessionCommand = compileHttpSchema<SessionCommand>(SESSION_COMMAND_SCHEMA);

/** Schema owns structure; this adapter keeps image-only and command normalization policy. */
export function parseSessionCommand(body: unknown): SessionCommand | { error: string } {
  if (!validateSessionCommand(body)) {
    const error = validateSessionCommand.errors?.[0];
    return { error: error ? sessionCommandSchemaError(error) : "invalid command" };
  }
  if (body.type === "prompt") {
    if (body.message.trim() === "" && body.images === undefined) return { error: "prompt requires a non-empty message" };
    const images = body.images?.map(({ data, mimeType }) => ({ data, mimeType })) ?? [];
    return { type: "prompt", message: body.message, ...(images.length > 0 ? { images } : {}) };
  }
  if (body.type === "web_command") {
    return { type: "web_command", name: body.name.trim(), ...(typeof body.args === "string" ? { args: body.args.slice(0, 4_000) } : {}) };
  }
  return { type: body.type };
}

/** Route a command to a live session (no implicit spawn: the routes ensure liveness). */
export async function sendCommand(id: string, command: SessionCommand): Promise<CommandResult> {
  const handle = liveSessions.get(id);
  if (handle === undefined) return { status: "not_found" };
  handle.lastActivityAt = Date.now();
  const { core } = handle;
  switch (command.type) {
    case "prompt": {
      const state = core.getState();
      if (state.isBashRunning) {
        return {
          status: "error",
          error: "Cannot send a prompt while a shell command is running",
        };
      }
      let message = command.message;
      let images = command.images;
      const host = getPluginHost();
      if (host !== null) {
        const sessionCtx = { session: { id, project: handle.cwd, cwd: handle.cwd } };
        const transformed = await host.hooks.waterfall("prompt.before-send", message, sessionCtx);
        if (typeof transformed === "string") message = transformed;
        if (images !== undefined && images.length > 0) {
          const transformedImages: PromptImage[] = [];
          for (const img of images) {
            const nextImg = await host.hooks.waterfall("attachment.before-upload", img, sessionCtx);
            if (
              typeof nextImg === "object"
              && nextImg !== null
              && typeof (nextImg as PromptImage).data === "string"
              && typeof (nextImg as PromptImage).mimeType === "string"
            ) {
              transformedImages.push(nextImg as PromptImage);
            } else {
              transformedImages.push(img);
            }
          }
          images = transformedImages;
        }
      }
      // The prompt rides as typed — `@file` mentions included. The model
      // reads them with pi's read tool, which natively strips the `@`
      // prefix (resolveReadPath); the server never inlines file content.
      return core
        .prompt(message, images)
        .then((): CommandResult => ({ status: "ok", data: { accepted: true } }))
        .catch((error: unknown): CommandResult => ({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        }));
    }
    case "abort": {
      return core
        .abort()
        .then(() => ({ status: "ok", data: { aborted: true } }) as const)
        .catch((error: unknown) => ({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        }));
    }
    case "get_state": {
      return Promise.resolve({ status: "ok", data: core.getState() });
    }
    case "web_command": {
      // The web core's command channel. Compaction is the core's own, so an
      // in-process session runs it here — no pi process is reachable from a
      // session this server owns, and a bus emit would reach no listener; a
      // bridged session forwards it to the extension that owns the context.
      // Everything else goes to the session owner: the extension registry a
      // bridge relays to, or the runner-registered web-<name> dispatch
      // targets for the commands that need pi's command context.
      if (command.name === "compact" && core.compact !== undefined) {
        return core
          .compact(command.args)
          .then(() => ({ status: "ok", data: { accepted: true } }) as const)
          .catch((error: unknown) => ({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      if (core.webCommand !== undefined) {
        return core
          .webCommand(command.name, command.args ?? "")
          .then(() => ({ status: "ok", data: { accepted: true } }) as const)
          .catch((error: unknown) => ({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      // The runner-registered form: the extension registers the session
      // control commands under web-<name> (all modes), so the prompt path
      // dispatches them through pi's command runner with a valid context.
      return core
        .prompt(`/web-${command.name}${command.args !== undefined && command.args !== "" ? ` ${command.args}` : ""}`)
        .then(() => ({ status: "ok", data: { accepted: true } }) as const)
        .catch((error: unknown) => ({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        }));
    }
  }
}

/** Get the live core for `id`, resuming from disk when it is not live yet. */
export async function ensureSession(
  id: string,
  options?: { agentDir?: string },
): Promise<SessionCore | null> {
  const existing = liveSessions.get(id);
  if (existing !== undefined) return existing.core;
  if (isBridgeOwned(id)) {
    // The session's TUI owner is re-attaching (server restart, bridge
    // drop). Wait it out — every request in the window resolves to the
    // bridge core the moment it lands, and no in-process copy ever splits
    // the session. If the grace expires, the TUI is truly gone and the
    // in-process resume below becomes the correct fallback.
    const deadline = Date.now() + BRIDGE_GRACE_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const landed = liveSessions.get(id);
      if (landed !== undefined) return landed.core;
    }
  }
  const file = await resolveSessionFile(id, options?.agentDir);
  if (file === null) return null;
  if (externalSessionHostEnabled(process.env, process.platform)) {
    const cwd = (await readSessionHeader(file))?.cwd ?? process.cwd();
    await startSessionHost({
      sessionId: id,
      cwd,
      isAttached: () => getSession(id)?.core.bridgeOf !== undefined,
    });
    const core = getSession(id)?.core;
    if (core === undefined) throw new Error(`session host for ${id} attached without a core`);
    return core;
  }
  return resumeSession({ sessionFile: file, ...options });
}
