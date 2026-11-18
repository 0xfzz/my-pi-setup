// The pi session hook: session list, selection, live transcript state.
// The protocol client owns one subscribed event stream per selected session;
// user messages render optimistically and replies stream in via delta payloads.

import { useCallback, useEffect, useRef, useState } from "react";
import { getAuth } from "./auth.ts";
import {
  mergeHistoryEntries,
  type HistoryEntryLike,
  type HistoryPageResponse,
  type ToolResultLike,
} from "./history-pages.ts";
import { createFrameCoalescer, type FrameCoalescer } from "./frame-coalescer.ts";
import {
  INITIAL_STREAMING_STATE,
  assistantEntryFromMessage,
  streamCommitTiming,
  streamReducer,
  toAssistantBlocks,
  type AssistantBlock,
  type BashBlock,
  type ClientAssistantEventLike,
  type StreamingState,
  type StreamAction,
} from "./streaming.ts";
import type { WebCommand } from "../shared/commands.ts";
import type {
  CustomPanelLike,
  WebNotificationLike,
  WebPluginDescriptor,
  WebView,
  WidgetModelLike,
  WorkingModelLike,
} from "./plugin-system/contract.ts";
import { pluginStateFrameOf } from "../shared/plugin-state.ts";
import { buildVerdict, ownBuildId } from "./build-identity.ts";
import { isCompactionReason, type CompactionReason } from "./compaction.ts";
import { HISTORY_FETCH_TIMEOUT_MS, historyRetryDelayMs } from "./history-retry.ts";
import { directoryProtocolClient, protocolClient, setPluginSession, type ProtocolResult } from "./protocol-client.ts";

export type { CustomPanelLike, WebNotificationLike, WidgetModelLike };
export type { HistoryEntryLike, ToolResultLike } from "./history-pages.ts";

export interface UiPromptLike {
  kind: string;
  title?: string;
}

export interface ModelRefLike {
  provider: string;
  id: string;
}

export interface ModelsState {
  models: ModelRefLike[];
  /** Every model the registry offers, scoped or not (picker's "all" tab). */
  all?: ModelRefLike[];
  current?: ModelRefLike;
}

export interface DialogRequest {
  dialog: string;
  nonce: number;
}

export interface SessionSummary {
  id: string;
  cwd: string;
  live: boolean;
  modifiedAt: number;
  /** The session is mid-turn right now (agent streaming), for live sessions. */
  running?: boolean;
  /** The display name: a person's /name, or a generated title. Absent when unnamed. */
  name?: string;
}

export interface ToolCallStatus {
  state: "running" | "done" | "error";
  toolName: string;
  /** The call's parsed input, from `tool_execution_start`'s `args`. */
  input?: string;
  /** Live partial output (bash's accumulated snapshot), replaced by the result at the end. */
  partial?: string;
}

/** Tool-result message content → plain text (TextContent blocks only). */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw === "object" && raw !== null) {
      const block = raw as { type?: unknown; text?: unknown };
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
  }
  return parts.join("\n");
}

/** Tool-result message content → its image blocks. */
function toolResultImages(content: unknown): Array<{ data: string; mimeType: string }> | undefined {
  if (!Array.isArray(content)) return undefined;
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const raw of content) {
    if (typeof raw === "object" && raw !== null) {
      const block = raw as { type?: unknown; data?: unknown; mimeType?: unknown };
      if (block.type === "image" && typeof block.data === "string") {
        images.push({ data: block.data, mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/png" });
      }
    }
  }
  return images.length > 0 ? images : undefined;
}

/** The diff from a tool result's `details`, when the tool produced one. */
function toolResultDiff(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const diff = (details as { diff?: unknown }).diff;
  return typeof diff === "string" && diff !== "" ? diff : undefined;
}

/** The text of an assistant/user message (its text blocks joined). */
function messageText(blocks: AssistantBlock[]): string {
  return blocks
    .filter((block): block is { kind: "text"; text: string } => block.kind === "text")
    .map((block) => block.text)
    .join("\n");
}

/** Stringify a tool execution's `args` (already an object) for display. */
function argsToInput(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const keys = Object.keys(args as Record<string, unknown>);
  if (keys.length === 0) return undefined;
  return JSON.stringify(args, null, 2);
}

/** Text of a live `tool_execution_update` partial result. */
function partialResultText(partial: unknown): string | undefined {
  if (typeof partial !== "object" || partial === null) return undefined;
  const record = partial as Record<string, unknown>;
  if (typeof record.stdout === "string") return record.stdout;
  if (Array.isArray(record.content)) {
    const text = toolResultText(record.content);
    return text === "" ? undefined : text;
  }
  return undefined;
}

export interface SessionStateLike {
  isStreaming: boolean;
  isBashRunning: boolean;
  isCompacting: boolean;
  model?: { provider: string; id: string };
  contextUsage: { percent: number; contextWindow: number; tokens: number } | null;
  thinkingLevel: string;
}

export type ConnectionState = "idle" | "connecting" | "connected" | "error";

interface OptimisticUserMessage {
  key: number;
  text: string;
  /** Images attached to the prompt (base64, already downscaled). */
  images?: Array<{ data: string; mimeType: string }>;
}

/** localStorage key for the selected session: reloads and plugin-page navigation keep the session context. */
const SELECTED_SESSION_KEY = "pi-web-minimal:selected-session";
/** One page of the transcript; older turns load on demand through a cursor. */
const HISTORY_PAGE_LIMIT = 50;
/** A session with no transcript file is an empty conversation, not a failed read. */
const EMPTY_HISTORY_PAGE: HistoryPageResponse = {};
/** How long the reloading banner stays before a missing completion signal expires it. */
const RELOAD_INDICATOR_TIMEOUT_MS = 20_000;

/** A resync carries the next opaque protocol cursor alongside the history page. */
type ResyncPage = HistoryPageResponse & { cursor?: string };

/** A session with no transcript file is empty, not a failed read worth retrying. */
function pageFrom(outcome: ProtocolResult<HistoryPageResponse>): HistoryPageResponse {
  if (outcome.ok) return outcome.value;
  if (outcome.error.code === "SESSION_NOT_FOUND") return EMPTY_HISTORY_PAGE;
  throw new Error(outcome.error.message);
}

/** Directory adapters return the same session rows the old list route returned. */
function sessionsFrom(value: unknown): SessionSummary[] {
  if (Array.isArray(value)) return value as SessionSummary[];
  if (typeof value === "object" && value !== null) {
    const sessions = (value as { sessions?: unknown }).sessions;
    if (Array.isArray(sessions)) return sessions as SessionSummary[];
  }
  return [];
}

export function usePiSession() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [selectedId, setSelectedIdState] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(SELECTED_SESSION_KEY);
    } catch {
      return null;
    }
  });
  // Persist the selection so a reload (or a /plugins/:id navigation, which
  // is a fresh page load in the SPA-fallback setup) reconnects the stream.
  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIdState(id);
    try {
      if (id === null) window.localStorage.removeItem(SELECTED_SESSION_KEY);
      else window.localStorage.setItem(SELECTED_SESSION_KEY, id);
    } catch {
      // Storage is best-effort; the selection still works for this page load.
    }
  }, []);
  const [history, setHistory] = useState<HistoryEntryLike[]>([]);
  const [historyLoading, setHistoryLoading] = useState(selectedId !== null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [userMessages, setUserMessages] = useState<OptimisticUserMessage[]>([]);
  const [streaming, setStreaming] = useState<StreamingState>(INITIAL_STREAMING_STATE);
  const [toolStatus, setToolStatus] = useState<Record<string, ToolCallStatus>>({});
  const [sessionState, setSessionState] = useState<SessionStateLike | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [plugins, setPlugins] = useState<WebPluginDescriptor[]>([]);
  const [pluginViews, setPluginViews] = useState<Record<string, WebView>>({});
  const [working, setWorking] = useState<WorkingModelLike | null>(null);
  const [uiRunning, setUiRunning] = useState(false);
  /** True while a /reload or a code-change server reload is in flight. */
  const [reloading, setReloading] = useState(false);
  /** Banner text while reloading (defaults to "pi is reloading…" when null). */
  const [reloadingMessage, setReloadingMessage] = useState<string | null>(null);
  /** Model list for the web picker (web_models events + /models fetch). */
  const [models, setModels] = useState<ModelsState>({ models: [] });
  /** A session-side command asked the web to open one of its dialogs. */
  const [dialogRequest, setDialogRequest] = useState<DialogRequest | null>(null);
  /** Footer-style status lines (ui.status.changed). */
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  /** Editor widgets (ui.widget.changed), rendered above/below the composer. */
  const [widgets, setWidgets] = useState<Record<string, WidgetModelLike>>({});
  /** Custom panels (ui.custom.changed) — the web's popup primitive. */
  const [custom, setCustom] = useState<Record<string, CustomPanelLike>>({});
  /** Transient toasts (ui.notify). */
  const [notifications, setNotifications] = useState<WebNotificationLike[]>([]);
  /** A TUI-side dialog is open (ui_prompt_start); the web can only say so. */
  const [uiPrompt, setUiPrompt] = useState<UiPromptLike | null>(null);
  const [toolResults, setToolResults] = useState<Record<string, ToolResultLike>>({});
  /** Last prompt delivery failure, shown at the composer until the next send. */
  const [sendError, setSendError] = useState<string | null>(null);
  /** Slash commands the selected live session can dispatch. */
  const [sessionCommands, setSessionCommands] = useState<WebCommand[]>([]);
  /**
   * A compaction running right now (compaction_start → compaction_end), with
   * what triggered it. Its own state, not `isStreaming`: a compaction is not a
   * reply, so the working line has to say which work is happening.
   */
  const [compacting, setCompacting] = useState<CompactionReason | null>(null);
  /** The selected session's git branch, or null when its directory has none. */
  const [workspaceBranch, setWorkspaceBranch] = useState<string | null>(null);

  const streamingRef = useRef<StreamingState>(INITIAL_STREAMING_STATE);
  // Cursors live outside React state: the SSE handler reads the latest page
  // position without re-subscribing the event stream on every append.
  const historyCursorRef = useRef<{ older: string | null; newer: string | null }>({ older: null, newer: null });
  // The binding's resume cursor is distinct from the history page cursor used
  // for duplicate-free merging; the next resync resumes from this one.
  const protocolCursorRef = useRef<string | null>(null);
  const loadingOlderRef = useRef(false);
  // Latest selection, read by async callbacks (fetchModels) that must not
  // apply a response belonging to a session the user already left.
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;
  // The boot id of the server we first connected to: when a subsequent
  // `sessions_snapshot` carries a different bootId, the server restarted
  // onto a new build/runtime and the page reloads onto the fresh bundle.
  const bootIdRef = useRef<string | null>(null);
  // The build this page is running, from the meta tag the server stamps into
  // its HTML, and the last build this tab reloaded for. A server that serves a
  // different id has a newer bundle; a page that already reloaded once for an
  // id stops instead of reloading forever.
  const ownBuildRef = useRef<string | null>(ownBuildId(document));
  const reloadedBuildRef = useRef<string | null>(null);

  /** Reload onto `served` when this page runs an older bundle, once per build. */
  const convergeOnBuild = useCallback((served: string | null) => {
    const verdict = buildVerdict(ownBuildRef.current, served, reloadedBuildRef.current);
    if (verdict !== "stale" || served === null) return;
    reloadedBuildRef.current = served;
    setReloadingMessage("There are code changes — reloading…");
    setReloading(true);
    window.location.reload();
  }, []);
  // Token deltas render at most once per frame; the render reads the latest
  // state, so a frame always shows everything applied so far. Structural
  // actions flush at once (see streamCommitTiming).
  const [streamRender] = useState<FrameCoalescer>(() => createFrameCoalescer<number>(
    () => setStreaming(streamingRef.current),
    {
      request: (callback) => requestAnimationFrame(callback),
      cancel: (handle) => cancelAnimationFrame(handle),
    },
  ));
  useEffect(() => () => streamRender.dispose(), [streamRender]);
  const applyStream = useCallback((action: StreamAction) => {
    const next = streamReducer(streamingRef.current, action);
    if (next === streamingRef.current) return;
    streamingRef.current = next;
    if (streamCommitTiming(action) === "frame") streamRender.request();
    else streamRender.flush();
  }, [streamRender]);

  // A /reload re-runs the extension and re-attaches the bridge; if no
  // completion signal lands (commands_changed, bridge_resync, session_state),
  // expire the banner so it never sticks around as a false "still reloading".
  useEffect(() => {
    if (!reloading) return;
    const timer = setTimeout(() => {
      setReloading(false);
      setReloadingMessage(null);
    }, RELOAD_INDICATOR_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [reloading]);

  const refreshSessions = useCallback(async () => {
    const outcome = await directoryProtocolClient().query<unknown>("session.list");
    if (!outcome.ok) return; // Offline: keep the last list.
    setSessions(sessionsFrom(outcome.value));
  }, []);

  // The latest search the user typed. A slower earlier response must not
  // replace the results for a query the box has already moved past.
  const searchQueryRef = useRef("");
  /**
   * Search the whole session directory, not just the loaded window. The
   * sidebar filters what it holds instantly; this is what lets a generated
   * title on an older session still be found.
   */
  const searchSessions = useCallback(async (query: string): Promise<SessionSummary[]> => {
    const trimmed = query.trim();
    searchQueryRef.current = trimmed;
    if (trimmed === "") return [];
    const outcome = await directoryProtocolClient().query<unknown>("session.search", { query: trimmed });
    if (!outcome.ok || searchQueryRef.current !== trimmed) return [];
    return sessionsFrom(outcome.value);
  }, []);

  // The plugin registry is fetched once per page load; the surfaces it declares
  // drive slots, pages and shortcut bindings. The server pushes
  // `plugins_changed` when the served set moves (enable, disable, reload,
  // quarantine, safe mode), so an open tab converges instead of keeping the
  // registry it was opened with.
  const refreshPlugins = useCallback(() => {
    void fetch("/api/plugins")
      .then((res) => res.json() as Promise<{ plugins?: WebPluginDescriptor[] }>)
      .then((body) => setPlugins(body.plugins ?? []))
      .catch(() => {
        // Registry fetch is best-effort; empty means no plugin surfaces.
      });
  }, []);

  useEffect(() => {
    refreshPlugins();
  }, [refreshPlugins, convergeOnBuild]);

  // The session list is push-driven: the protocol client holds one directory
  // event stream, whose envelopes carry the snapshot then only running/idle
  // and add/remove transitions — no polling.
  useEffect(() => {
    const leave = directoryProtocolClient().subscribe("session.directory.events", (envelope) => {
      const data = envelope.payload as Record<string, unknown>;
      switch (data.type) {
        case "sessions_snapshot": {
          const body = data as { bootId?: unknown; buildId?: unknown; sessions?: SessionSummary[] };
          // A reconnect onto a server serving another bundle: converge even when
          // its boot id is unchanged (a rebuild without a restart).
          convergeOnBuild(typeof body.buildId === "string" ? body.buildId : null);
          if (typeof body.bootId === "string" && body.bootId !== "") {
            if (bootIdRef.current !== null && bootIdRef.current !== body.bootId) {
              bootIdRef.current = body.bootId;
              setReloadingMessage("There are code changes — reloading…");
              setReloading(true);
              window.location.reload();
              return;
            }
            bootIdRef.current = body.bootId;
          }
          setSessions(body.sessions ?? []);
          setSessionsLoading(false);
          break;
        }
        case "build_changed": {
          // The bundle on disk was rebuilt under this page: move onto it, so
          // every tab runs the same client build.
          const frame = data as { buildId?: unknown };
          convergeOnBuild(typeof frame.buildId === "string" ? frame.buildId : null);
          break;
        }
        case "plugins_changed": {
          // The served registry moved: re-read it so this tab lists the same
          // plugins as every other tab and as the server.
          refreshPlugins();
          break;
        }
        case "code_changes": {
          const frame = data as { message?: unknown };
          const text = typeof frame.message === "string" && frame.message.trim() !== ""
            ? frame.message.trim()
            : "There are code changes — reloading…";
          setReloadingMessage(text);
          setReloading(true);
          break;
        }
        case "session_running": {
          const frame = data as { id?: unknown; running?: unknown };
          const id = frame.id;
          const running = frame.running;
          if (typeof id !== "string" || typeof running !== "boolean") return;
          setSessions((prev) =>
            prev.map((session) =>
              session.id === id ? { ...session, running } : session,
            ),
          );
          break;
        }
        case "session_added": {
          const added = (data as { session?: SessionSummary }).session;
          if (added === undefined || typeof added.id !== "string") return;
          setSessions((prev) => {
            const index = prev.findIndex((session) => session.id === added.id);
            if (index === -1) return [...prev, added];
            const next = [...prev];
            next[index] = added;
            return next;
          });
          break;
        }
        case "session_renamed": {
          // A generated or typed name replaces the cwd label; an empty name clears it.
          const frame = data as { id?: unknown; name?: unknown };
          if (typeof frame.id !== "string" || typeof frame.name !== "string") return;
          const id = frame.id;
          const name = frame.name;
          setSessions((prev) =>
            prev.map((session) => {
              if (session.id !== id) return session;
              const next: SessionSummary = { ...session };
              if (name === "") delete next.name;
              else next.name = name;
              return next;
            }),
          );
          break;
        }
        case "session_removed": {
          const removedId = (data as { id?: unknown }).id;
          if (typeof removedId !== "string") return;
          setSessions((prev) =>
            prev.filter((session) => session.id !== removedId),
          );
          break;
        }
        default:
          // heartbeat and future frame types pass silently.
          break;
      }
    });
    return leave;
  }, [refreshPlugins, convergeOnBuild]);

  const fetchState = useCallback(async (id: string) => {
    const outcome = await protocolClient(id).query<{ state?: SessionStateLike }>("session.get");
    if (!outcome.ok) return; // The stream reports connection health.
    const body = outcome.value;
    // Merge, not replace: a session_state push may have landed before this
    // read (or between it and now), and the fetched bridge state can lag a
    // just-applied model. The push is the fresher truth.
    setSessionState((prev) => ({
      isStreaming: body.state?.isStreaming ?? prev?.isStreaming ?? false,
      isBashRunning: body.state?.isBashRunning ?? prev?.isBashRunning ?? false,
      isCompacting: body.state?.isCompacting ?? prev?.isCompacting ?? false,
      model: body.state?.model ?? prev?.model,
      contextUsage: body.state?.contextUsage ?? prev?.contextUsage ?? null,
      thinkingLevel: body.state?.thinkingLevel ?? prev?.thinkingLevel ?? "off",
    }));
  }, []);

  /**
   * The selected session's git branch for the composer's workspace line.
   *
   * Best-effort and one-shot per selection: a null branch (not a worktree, or
   * no git) simply leaves the line to the path alone, and a failed read never
   * blocks the session.
   */
  const fetchWorkspaceBranch = useCallback(async (id: string) => {
    const outcome = await protocolClient(id).query<{ branch?: unknown }>("session.branch");
    if (!outcome.ok) return; // No branch is a valid answer for this line.
    const branch = outcome.value.branch;
    setWorkspaceBranch(typeof branch === "string" && branch !== "" ? branch : null);
  }, []);

  // The web picker's model list. The SSE `web_models` push keeps it live;
  // this fetch is the initial read so a session switch never shows the
  // previous session's list.
  const fetchModels = useCallback(async (id: string) => {
    const outcome = await protocolClient(id).query<ModelsState>("session.models");
    // A slow response for a session the user already left must not
    // overwrite the now-selected session's list.
    if (!outcome.ok || selectedIdRef.current !== id) return;
    const data = outcome.value;
    setModels((prev) => ({
      models: Array.isArray(data.models) ? data.models : prev.models,
      all: Array.isArray(data.all) ? data.all : prev.all,
      current: data.current ?? prev.current,
    }));
  }, []);

  /** Fetch the preceding transcript page without disturbing the live stream. */
  const loadOlder = useCallback((): void => {
    const id = selectedIdRef.current;
    const cursor = historyCursorRef.current.older;
    if (id === null || cursor === null || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const params = { limit: HISTORY_PAGE_LIMIT, cursor, direction: "older" };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HISTORY_FETCH_TIMEOUT_MS);
    void protocolClient(id).query<HistoryPageResponse>("session.history", params, controller.signal)
      .then(pageFrom)
      .then((page) => {
        setHistory((prev) => mergeHistoryEntries(prev, page.entries ?? [], "prepend"));
        setToolResults((prev) => ({ ...page.toolResults, ...prev }));
        historyCursorRef.current.older = page.hasOlder === true ? (page.olderCursor ?? null) : null;
        setHasOlder(page.hasOlder === true);
      })
      .catch(() => {
        // The button stays available; a transient read failure is not destructive.
      })
      .finally(() => {
        clearTimeout(timeout);
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      });
  }, []);

  // Open the event stream (and load history) whenever the selection changes.
  useEffect(() => {
    setUserMessages([]);
    setHistory([]);
    setHistoryLoading(selectedId !== null);
    setHasOlder(false);
    setLoadingOlder(false);
    loadingOlderRef.current = false;
    historyCursorRef.current = { older: null, newer: null };
    setToolStatus({});
    setSessionState(null);
    setPluginViews({});
    setWorking(null);
    setUiRunning(false);
    setReloading(false);
    setStatuses({});
    setWidgets({});
    setCustom({});
    setNotifications([]);
    setUiPrompt(null);
    setToolResults({});
    setSessionCommands([]);
    // Never carry a compaction from the previous session across the switch.
    setCompacting(null);
    // The workspace line belongs to the selection: never carry the previous
    // session's branch onto the next one.
    setWorkspaceBranch(null);
    // The picker must not carry the previous session's models across the
    // switch; the fetch below (or the session's web_models push) refills it.
    setModels({ models: [] });
    streamingRef.current = INITIAL_STREAMING_STATE;
    setStreaming(INITIAL_STREAMING_STATE);

    setPluginSession(selectedId);
    if (selectedId === null) {
      setConnection("idle");
      return;
    }
    let closed = false;
    setConnection("connecting");

    // The live session's dispatchable slash commands (extension/prompt/
    // skill); built-ins come from the shared list. Best-effort: a failed
    // fetch just leaves the built-ins.
    void protocolClient(selectedId).query<{ commands?: WebCommand[] }>("session.commands")
      .then((outcome) => {
        if (!outcome.ok || closed) return;
        setSessionCommands(outcome.value.commands ?? []);
      })
      .catch(() => {
        // The palette falls back to the built-ins.
      });

    // The picker's initial read for this session, so the chip and the
    // selector are correct without opening the picker first.
    void fetchModels(selectedId);

    // The initial page and the event stream race: an assistant reply that
    // ends while history is loading is buffered until the page lands. After
    // that the SSE events append directly, and a reconnect fetches only the
    // entries written since the page's cursor.
    let historyApplied = false;
    const pendingAppends: HistoryEntryLike[] = [];
    // Whether the entry appended for the current run already carries the
    // aborted marker, so agent_settled only adds one marker per run.
    let lastAppendedAborted = false;
    // A `!` command opened by user_bash and not yet finalized by
    // bash_execution_end; late-attaching streams only see the end event.
    let bashOpen = false;
    let everConnected = false;
    let historyRetry: ReturnType<typeof setTimeout> | undefined;

    const appendEntry = (entry: HistoryEntryLike): void => {
      if (closed) return;
      lastAppendedAborted = entry.aborted === true;
      if (!historyApplied) {
        pendingAppends.push(entry);
        return;
      }
      setHistory((prev) => [...prev, entry]);
    };

    /** Replace the last open bash block (a live `!` command), newest-last. */
    const updateLastBash = (update: (block: BashBlock) => BashBlock): void => {
      if (closed) return;
      if (!historyApplied) {
        for (let i = pendingAppends.length - 1; i >= 0; i--) {
          const blocks = pendingAppends[i].blocks;
          for (let j = blocks.length - 1; j >= 0; j--) {
            const block = blocks[j];
            if (block.kind === "bash") {
              blocks[j] = update(block);
              return;
            }
          }
        }
        return;
      }
      setHistory((prev) => {
        for (let i = prev.length - 1; i >= 0; i--) {
          const blocks = [...prev[i].blocks];
          for (let j = blocks.length - 1; j >= 0; j--) {
            const block = blocks[j];
            if (block.kind === "bash") {
              blocks[j] = update(block);
              const entries = [...prev];
              entries[i] = { ...prev[i], blocks };
              return entries;
            }
          }
        }
        return prev;
      });
    };

    type PagePlacement = "initial" | "prepend" | "append";
    const applyPage = (page: HistoryPageResponse, placement: PagePlacement): void => {
      if (closed) return;
      const entries = page.entries ?? [];
      if (placement === "initial") {
        historyApplied = true;
        setHistoryLoading(false);
        setHistory(mergeHistoryEntries(entries, pendingAppends, "append"));
        setHasOlder(page.hasOlder === true);
      } else {
        setHistory((prev) => mergeHistoryEntries(prev, entries, placement === "prepend" ? "prepend" : "append"));
      }
      // Results captured live win over the disk snapshot.
      setToolResults((prev) => ({ ...page.toolResults, ...prev }));
      if (placement === "initial" && page.newerCursor !== undefined) {
        historyCursorRef.current.newer = page.newerCursor;
      }
      if (placement === "initial" && page.olderCursor !== undefined) {
        historyCursorRef.current.older = page.hasOlder === true ? page.olderCursor : null;
      }
      if (placement === "append" && page.newerCursor !== undefined) {
        historyCursorRef.current.newer = page.newerCursor;
      }
    };

    // Subscribe-before-snapshot: the page read fires once the stream is
    // `connected`, so its cursor covers everything before the subscribe and
    // buffered SSE appends cover everything after — no invisible gap.
    const fetchPage = (options: {
      placement: PagePlacement;
      cursor?: string;
      direction?: "older" | "newer";
      attempt?: number;
    }): void => {
      if (closed || (options.placement === "initial" && historyApplied)) return;
      const params: Record<string, string | number> = { limit: HISTORY_PAGE_LIMIT };
      if (options.cursor !== undefined) {
        params.cursor = options.cursor;
        params.direction = options.direction ?? "older";
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HISTORY_FETCH_TIMEOUT_MS);
      void protocolClient(selectedId).query<HistoryPageResponse>("session.history", params, controller.signal)
        .then(pageFrom)
        .then((page) => {
          clearTimeout(timeout);
          applyPage(page, options.placement);
        })
        .catch(() => {
          clearTimeout(timeout);
          if (closed) return;
          if (options.placement !== "initial") return;
          historyRetry = setTimeout(
            () => fetchPage({ ...options, attempt: (options.attempt ?? 0) + 1 }),
            historyRetryDelayMs(options.attempt ?? 0),
          );
        });
    };

    /** A tree switch replaces the branch; keep the stream, replace the page. */
    const reloadHistory = (): void => {
      clearTimeout(historyRetry);
      historyApplied = false;
      pendingAppends.length = 0;
      historyCursorRef.current = { older: null, newer: null };
      setHistoryLoading(true);
      setHasOlder(false);
      fetchPage({ placement: "initial" });
    };

    /**
     * Reconnect and bridge-gap recovery read a page from the binding's cursor;
     * the history page cursor stays the merge key so overlap never renders twice.
     */
    const resyncHistory = (): void => {
      if (!historyApplied) return;
      // The first resync has no opaque binding cursor yet; the server then
      // returns one, and the next gap resumes from it. newerCursor stays the
      // local merge key so an overlapping snapshot never duplicates a row.
      const params = protocolCursorRef.current === null ? {} : { cursor: protocolCursorRef.current };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HISTORY_FETCH_TIMEOUT_MS);
      void protocolClient(selectedId).query<ResyncPage>("session.resync", params, controller.signal)
        .then((outcome) => {
          if (!outcome.ok) throw new Error(outcome.error.message);
          return outcome.value;
        })
        .then((page) => {
          if (typeof page.cursor === "string") protocolCursorRef.current = page.cursor;
          applyPage(page, "append");
        })
        .catch(() => {
          // The next stream event retries; the transcript keeps its last page.
        })
        .finally(() => clearTimeout(timeout));
    };

    // The initial state read (model, thinking, context): the model chip
    // renders from it before any session_state push arrives.
    void fetchState(selectedId);
    void fetchWorkspaceBranch(selectedId);

    protocolCursorRef.current = null;
    let leaveEvents: () => void = () => {};
    leaveEvents = protocolClient(selectedId).subscribe(
      "session.events",
      (envelope) => {
        const data = envelope.payload as Record<string, unknown>;
        switch (data.type) {
        case "connected":
          setConnection("connected");
          applyStream(data.isStreaming ? { type: "run_start" } : { type: "run_end" });
          // First connect: the stream is live, so NOW the history page can
          // be read without a loss window. A reconnect may have missed events,
          // so read only the entries appended after the stored cursor.
          if (!everConnected) {
            everConnected = true;
            fetchPage({ placement: "initial" });
          } else {
            resyncHistory();
          }
          break;
        case "startup_error":
          setConnection("error");
          leaveEvents();
          // No live stream — the file still renders (best effort).
          if (!everConnected) {
            everConnected = true;
            fetchPage({ placement: "initial" });
          } else {
            resyncHistory();
          }
          break;
        case "agent_start":
          // A run started (perhaps from the TUI): the working line and the
          // streaming reply both key off this, so "pi is thinking" is
          // visible before the first assistant token.
          lastAppendedAborted = false;
          applyStream({ type: "run_start" });
          break;
        case "compaction_start":
          // The context is being summarized: the working line switches to the
          // compaction's own wording, so a long pause reads as work rather
          // than a hang. The reason decides the wording (manual, threshold,
          // overflow recovery).
          setCompacting(isCompactionReason(data.reason) ? data.reason : "manual");
          break;
        case "compaction_end": {
          setCompacting(null);
          void fetchState(selectedId);
          // A failed compaction changed nothing, so there is no entry on disk
          // to mark it. Automatic ones (threshold, overflow recovery) have no
          // HTTP response to carry the error either, so the marker itself is
          // the only place the reason survives. A manual /compact reports its
          // error on the command response, which the composer shows.
          const errorMessage = typeof data.errorMessage === "string" ? data.errorMessage : "";
          if (errorMessage !== "" && data.reason !== "manual") {
            appendEntry({ role: "compaction", blocks: [], summary: "", error: errorMessage });
          }
          break;
        }
        case "compaction_applied":
          // A compaction entry landed without the start/end events above: an
          // extension's own compactor appends it as a `turn_end` boundary
          // draft (`lib/vcc/controller.ts`), which pi commits directly. The
          // event carries no summary, and reading it back from the session
          // file keeps one source of truth for the marker — a custom
          // compactor's row renders exactly like pi's own.
          resyncHistory();
          break;
        case "agent_end":
          applyStream({ type: "run_end" });
          break;
        case "agent_settled":
          // The run settled; `aborted` marks a cancellation (Escape in the
          // TUI, Stop in the web). If no assistant message ended — the
          // model was still thinking — append a bare marker entry.
          applyStream({ type: "run_end" });
          if (data.aborted === true && !lastAppendedAborted) {
            appendEntry({ role: "assistant", blocks: [], aborted: true });
          }
          lastAppendedAborted = false;
          void fetchState(selectedId);
          break;
        case "message_start": {
          const message = data.message as { role?: unknown; content?: unknown } | undefined;
          if (message?.role === "assistant") {
            applyStream({ type: "message_start", message });
          }
          break;
        }
        case "message_update":
          applyStream({
            type: "delta",
            event: (data.assistantMessageEvent ?? {}) as ClientAssistantEventLike,
          });
          break;
        case "message_end": {
          const message = data.message as {
            role?: unknown;
            content?: unknown;
            toolCallId?: unknown;
            isError?: unknown;
            stopReason?: unknown;
            errorMessage?: unknown;
            details?: { diff?: unknown };
          } | undefined;
          if (message?.role === "assistant") {
            const entry: HistoryEntryLike = {
              role: "assistant",
              ...assistantEntryFromMessage(message),
            };
            appendEntry(entry);
            // Message-level end: the message committed, the run may still
            // be going (a tool call is executing, another message is next)
            // — the working line stays on until agent_settled.
            applyStream({ type: "message_end" });
            void fetchState(selectedId);
          } else if (message?.role === "user") {
            // A prompt typed in the TUI (or the confirmed echo of one sent
            // from here): render it, dropping the optimistic twin (matched on
            // text and image count — an image-only prompt has empty text).
            const entry: HistoryEntryLike = {
              role: "user",
              blocks: toAssistantBlocks(message.content),
            };
            const text = messageText(entry.blocks);
            const imageCount = entry.blocks.filter((block) => block.kind === "image").length;
            setUserMessages((prev) => {
              for (let i = prev.length - 1; i >= 0; i--) {
                if (prev[i].text === text && (prev[i].images?.length ?? 0) === imageCount) {
                  const next = [...prev];
                  next.splice(i, 1);
                  return next;
                }
              }
              return prev;
            });
            appendEntry(entry);
          } else if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
            // Tool results arrive as their own message; join them to the
            // assistant's tool call by id so the collapsible row can show
            // both the input and the outcome.
            const toolCallId = message.toolCallId;
            const text = toolResultText(message.content);
            const images = toolResultImages(message.content);
            const diff = toolResultDiff(message.details);
            setToolResults((prev) => ({
              ...prev,
              [toolCallId]: {
                text,
                isError: message.isError === true,
                ...(diff !== undefined ? { diff } : {}),
                ...(images !== undefined ? { images } : {}),
              },
            }));
          }
          break;
        }
        case "tool_execution_start": {
          const id = typeof data.toolCallId === "string" ? data.toolCallId : "";
          const toolName = typeof data.toolName === "string" ? data.toolName : "tool";
          if (id !== "") {
            const input = argsToInput(data.args);
            setToolStatus((prev) => ({
              ...prev,
              [id]: { state: "running", toolName, ...(input !== undefined ? { input } : {}) },
            }));
          }
          break;
        }
        case "tool_execution_update": {
          const id = typeof data.toolCallId === "string" ? data.toolCallId : "";
          const partial = partialResultText(data.partialResult);
          if (id !== "" && partial !== undefined) {
            setToolStatus((prev) => {
              const current = prev[id];
              if (current === undefined || current.state !== "running") return prev;
              return { ...prev, [id]: { ...current, partial } };
            });
          }
          break;
        }
        case "tool_execution_end": {
          const id = typeof data.toolCallId === "string" ? data.toolCallId : "";
          if (id !== "") {
            setToolStatus((prev) => ({
              ...prev,
              [id]: {
                state: data.isError === true ? "error" : "done",
                toolName: typeof data.toolName === "string" ? data.toolName : (prev[id]?.toolName ?? "tool"),
                input: prev[id]?.input,
              },
            }));
          }
          break;
        }
        case "user_bash": {
          // A `!` command the user ran in the TUI: show the row immediately,
          // output streams in below.
          const command = typeof data.command === "string" ? data.command : "";
          bashOpen = true;
          appendEntry({ role: "user", blocks: [{ kind: "bash", command, output: "" }] });
          break;
        }
        case "bash_execution_update": {
          if (bashOpen && typeof data.delta === "string" && data.delta !== "") {
            updateLastBash((block) => ({ ...block, output: (block.output + data.delta).slice(0, 8_000) }));
          }
          break;
        }
        case "bash_execution_end": {
          const command = typeof data.command === "string" ? data.command : "";
          const output = typeof data.output === "string" ? data.output : "";
          const closed: BashBlock = {
            kind: "bash",
            command,
            output,
            ...(typeof data.exitCode === "number" ? { exitCode: data.exitCode } : {}),
            ...(data.cancelled === true ? { cancelled: true } : {}),
            ...(data.truncated === true ? { truncated: true } : {}),
          };
          if (bashOpen) {
            updateLastBash(() => closed);
          } else {
            // The start event was missed (stream attached mid-command): the
            // end carries the whole row.
            appendEntry({ role: "user", blocks: [closed] });
          }
          bashOpen = false;
          break;
        }
        case "session_tree": {
          // A tree navigation (/tree, a fork): pi moved the session's
          // position — reload the history to the new branch, exactly like
          // the TUI redraws its transcript. Optimistic messages come back
          // with the reload.
          setUserMessages([]);
          reloadHistory();
          void fetchState(selectedId);
          break;
        }
        case "bridge_resync":
          // The TUI-side bridge re-attached after a drop; read only the
          // entries appended since this stream's last history cursor.
          setReloading(false);
          setUserMessages([]);
          resyncHistory();
          break;
        case "session_state": {
          // The TUI-side model/thinking/context state, pushed at attach, at
          // each turn start and continuously while a turn runs — this keeps
          // the model chip and context-window figure live.
          setReloading(false);
          const pushed = data as {
            model?: { provider?: unknown; id?: unknown };
            thinkingLevel?: unknown;
            contextUsage?: { percent?: unknown; contextWindow?: unknown; tokens?: unknown } | null;
          };
          const pushedModel = typeof pushed.model?.provider === "string" && typeof pushed.model?.id === "string"
            ? { provider: pushed.model.provider, id: pushed.model.id }
            : undefined;
          const pushedContextUsage = typeof pushed.contextUsage?.percent === "number"
            && typeof pushed.contextUsage?.contextWindow === "number"
            && typeof pushed.contextUsage?.tokens === "number"
            ? {
              percent: pushed.contextUsage.percent,
              contextWindow: pushed.contextUsage.contextWindow,
              tokens: pushed.contextUsage.tokens,
            }
            : undefined;
          setSessionState((prev) => ({
            isStreaming: prev?.isStreaming ?? false,
            isBashRunning: prev?.isBashRunning ?? false,
            isCompacting: prev?.isCompacting ?? false,
            model: pushedModel ?? prev?.model,
            contextUsage: pushedContextUsage ?? prev?.contextUsage ?? null,
            thinkingLevel: typeof pushed.thinkingLevel === "string" ? pushed.thinkingLevel : prev?.thinkingLevel ?? "off",
          }));
          break;
        }
        case "web_models": {
          // The extension's model list for the picker: scoped models when
          // scoping is active, else the available catalogue; `all` carries
          // every registry model for the picker's "all" tab.
          const pushed = data as { models?: unknown; all?: unknown; current?: { provider?: unknown; id?: unknown } };
          const refsOf = (value: unknown): ModelRefLike[] =>
            Array.isArray(value)
              ? (value as ModelRefLike[]).filter(
                (ref) => typeof ref?.provider === "string" && typeof ref?.id === "string",
              )
              : [];
          setModels({
            models: refsOf(pushed.models),
            all: refsOf(pushed.all),
            current: typeof pushed.current?.provider === "string" && typeof pushed.current?.id === "string"
              ? { provider: pushed.current.provider, id: pushed.current.id }
              : undefined,
          });
          break;
        }
        case "web_dialog_request": {
          // A command dispatched to the session asked the web to open one of
          // its native dialogs (bare /model, /thinking …).
          if (typeof data.dialog === "string") {
            setDialogRequest({ dialog: data.dialog, nonce: Date.now() });
          }
          break;
        }
        case "commands_changed":
          // The session posted a new command list (web_commands): refetch so
          // the palette and the dispatch channel stay current.
          setReloading(false);
          if (selectedId !== null) {
            void protocolClient(selectedId).query<{ commands?: WebCommand[] }>("session.commands")
              .then((outcome) => {
                if (outcome.ok && !closed) setSessionCommands(outcome.value.commands ?? []);
              })
              .catch(() => undefined);
          }
          break;
        case "plugin_state": {
          // Plugin views, the working indicator model and the running flag,
          // all scoped to this stream's session. One shared reader turns the
          // frame into its declared type; nothing here casts a field.
          const frame = pluginStateFrameOf(data);
          if (frame === undefined) break;
          setPluginViews(frame.views);
          setWorking(frame.working);
          setUiRunning(frame.running);
          setStatuses(frame.statuses);
          setWidgets(frame.widgets);
          setCustom(frame.custom);
          setNotifications(frame.notifications);
          break;
        }
        case "ui_prompt_start": {
          // A TUI-side extension dialog opened (select/confirm/input/custom):
          // pi is blocked on it there; the web can show that it is waiting.
          setUiPrompt({
            kind: typeof data.kind === "string" ? data.kind : "dialog",
            ...(typeof data.title === "string" ? { title: data.title } : {}),
          });
          break;
        }
        case "ui_prompt_end":
          setUiPrompt(null);
          break;
        default:
          // heartbeat and any future event types pass silently.
          break;
        }
      },
      (source) => {
        // EventSource reconnects on its own; surface the gap as "connecting".
        setConnection((prev) => (prev === "connected" ? "connecting" : "error"));
        // It gives up for good on a 401 (CLOSED, no retry) — an access token that
        // expired while the stream was down. Refresh, then resync from a gap.
        if (source.readyState === EventSource.CLOSED && !closed) {
          void getAuth()
            .recoverStream()
            .then((recovered) => {
              if (recovered && !closed) resyncHistory();
            });
        }
      },
    );

    return () => {
      closed = true;
      clearTimeout(historyRetry);
      leaveEvents();
      setConnection("idle");
    };
  }, [selectedId, applyStream, fetchState, fetchModels]);

  /** Result keys (session + tool call) already requested, so an expansion fetches once. */
  const requestedToolResults = useRef(new Set<string>());

  /**
   * Fetch one tool result in full: the images a history response leaves out
   * until their tool call is expanded. A failed fetch can be retried.
   */
  const loadToolResult = useCallback((toolCallId: string) => {
    if (selectedId === null) return;
    const key = `${selectedId}\u0000${toolCallId}`;
    if (requestedToolResults.current.has(key)) return;
    requestedToolResults.current.add(key);
    void protocolClient(selectedId).query<ToolResultLike>("session.tool-result", { toolCallId })
      .then((outcome) => {
        if (!outcome.ok) throw new Error(outcome.error.message);
        return outcome.value;
      })
      .then((full) => {
        setToolResults((prev) => ({ ...prev, [toolCallId]: full }));
      })
      .catch(() => {
        requestedToolResults.current.delete(key);
      });
  }, [selectedId]);

  const newSession = useCallback(async (cwd?: string) => {
    const outcome = await directoryProtocolClient().invoke<{ sessionId?: string }>(
      "session.create",
      cwd !== undefined && cwd.trim() !== "" ? { cwd } : {},
    );
    if (!outcome.ok) return outcome.error.message;
    if (outcome.value.sessionId === undefined) return "new session failed";
    await refreshSessions();
    setSelectedId(outcome.value.sessionId);
    return null;
  }, [refreshSessions]);

  const sendPrompt = useCallback(async (
    text: string,
    images: Array<{ data: string; mimeType: string }> = [],
  ) => {
    const id = selectedId;
    if (id === null || (text.trim() === "" && images.length === 0)) return;
    setUserMessages((prev) => [
      ...prev,
      {
        key: Date.now() + prev.length,
        text,
        ...(images.length > 0 ? { images } : {}),
      },
    ]);
    setSendError(null);
    const outcome = await protocolClient(id).invoke("session.prompt", {
      text,
      ...(images.length > 0 ? { images } : {}),
    });
    if (!outcome.ok) setSendError(outcome.error.message);
  }, [selectedId]);

  // Dispatch a web core command: the session's extension registry runs it in
  // the pi process (bridged sessions) or the in-process runner handles the
  // re-routed prompt. The composer uses this for commands marked web:true.
  const sendWebCommand = useCallback(async (name: string, args: string) => {
    const id = selectedId;
    if (id === null) return;
    setSendError(null);
    if (name === "reload") setReloading(true);
    const outcome = await protocolClient(id).invoke("web-command.dispatch", {
      name,
      ...(args !== "" ? { args } : {}),
    });
    if (!outcome.ok) setSendError(outcome.error.message);
  }, [selectedId]);

  const abort = useCallback(async () => {
    const id = selectedId;
    if (id === null) return;
    await protocolClient(id).invoke("session.abort", {});
    // The stream reports the true state; a refused abort needs no banner.
  }, [selectedId]);

  // Apply a model from the web picker. The session acknowledges via the
  // session_state push; the optimistic update keeps the chip instant.
  const setModel = useCallback(async (provider: string, id: string): Promise<string | null> => {
    const sessionId = selectedId;
    if (sessionId === null) return "no session selected";
    setSessionState((prev) => prev === null ? prev : { ...prev, model: { provider, id } });
    const outcome = await protocolClient(sessionId).invoke("session.set-model", { provider, id });
    return outcome.ok ? null : outcome.error.message;
  }, [selectedId]);

  const setThinking = useCallback(async (level: string): Promise<string | null> => {
    const sessionId = selectedId;
    if (sessionId === null) return "no session selected";
    // Optimistic like setModel: the session_state push confirms or corrects.
    setSessionState((prev) => prev === null ? prev : { ...prev, thinkingLevel: level });
    const outcome = await protocolClient(sessionId).invoke("session.set-thinking", { level });
    return outcome.ok ? null : outcome.error.message;
  }, [selectedId]);

  const clearDialogRequest = useCallback((): void => {
    setDialogRequest(null);
  }, []);

  return {
    sessions,
    sessionsLoading,
    historyLoading,
    hasOlder,
    loadingOlder,
    loadOlder,
    loadToolResult,
    selectedId,
    setSelectedId,
    history,
    userMessages,
    streaming,
    toolStatus,
    sessionState,
    /**
     * The compaction running right now: `reason` is null when only the
     * session's own state says one is in progress (a bridged session reports
     * isCompacting before its events arrive). Null when nothing is compacting.
     */
    compacting: compacting !== null
      ? { reason: compacting }
      : sessionState?.isCompacting === true
        ? { reason: null }
        : null,
    workspaceBranch,
    connection,
    plugins,
    pluginViews,
    working,
    uiRunning,
    reloading,
    reloadingMessage,
    models,
    fetchModels,
    setModel,
    searchSessions,
    setThinking,
    dialogRequest,
    clearDialogRequest,
    statuses,
    widgets,
    custom,
    notifications,
    uiPrompt,
    toolResults,
    sendError,
    sessionCommands,
    newSession,
    sendPrompt,
    sendWebCommand,
    abort,
    refreshSessions,
  };
}
