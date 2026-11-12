// The pi session hook: session list, selection, live transcript state.
// One EventSource per selected session carries the agent event wire; user
// messages render optimistically and assistant replies stream in via deltas.

import { useCallback, useEffect, useRef, useState } from "react";
import { getAuth } from "./auth.ts";
import {
  INITIAL_STREAMING_STATE,
  assistantEntryFromMessage,
  streamReducer,
  toAssistantBlocks,
  type AssistantBlock,
  type BashBlock,
  type ClientAssistantEventLike,
  type StreamingState,
  type StreamAction,
} from "./streaming.ts";
import type { WebCommand } from "../shared/commands.ts";
import type { WebPluginDescriptor, WebView, WorkingModelLike } from "./plugins/contract.ts";

export interface WebNotificationLike {
  id: string;
  message: string;
  level: "info" | "warning" | "error";
  timestamp: number;
}

export interface WidgetModelLike {
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

export interface CustomPanelLike {
  method: string;
  lines: string[] | null;
}

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

export interface HistoryEntryLike {
  role: "user" | "assistant";
  blocks: AssistantBlock[];
  /** The assistant reply ended because the run was aborted. */
  aborted?: boolean;
  /** The assistant reply ended in a provider error; its message. */
  error?: string;
}

export interface ToolCallStatus {
  state: "running" | "done" | "error";
  toolName: string;
  /** The call's parsed input, from `tool_execution_start`'s `args`. */
  input?: string;
  /** Live partial output (bash's accumulated snapshot), replaced by the result at the end. */
  partial?: string;
}

/** A tool call's result, joined by toolCallId. */
export interface ToolResultLike {
  text: string;
  isError: boolean;
  /** The edit tool's diff, from the result's `details.diff`. */
  diff?: string;
  images?: Array<{ data: string; mimeType: string }>;
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
/** How long the reloading banner stays before a missing completion signal expires it. */
const RELOAD_INDICATOR_TIMEOUT_MS = 20_000;

export function usePiSession() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
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
  const [userMessages, setUserMessages] = useState<OptimisticUserMessage[]>([]);
  const [streaming, setStreaming] = useState<StreamingState>(INITIAL_STREAMING_STATE);
  const [toolStatus, setToolStatus] = useState<Record<string, ToolCallStatus>>({});
  const [sessionState, setSessionState] = useState<SessionStateLike | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [plugins, setPlugins] = useState<WebPluginDescriptor[]>([]);
  const [pluginViews, setPluginViews] = useState<Record<string, WebView>>({});
  const [working, setWorking] = useState<WorkingModelLike | null>(null);
  const [uiRunning, setUiRunning] = useState(false);
  /** True while a /reload is in flight: the extension is re-running. */
  const [reloading, setReloading] = useState(false);
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
  // Bumped when the TUI-side bridge reconnects after a gap: the effect
  // re-runs, reloading history in case events were missed while it was away.
  const [historyEpoch, setHistoryEpoch] = useState(0);

  const streamingRef = useRef<StreamingState>(INITIAL_STREAMING_STATE);
  const applyStream = useCallback((action: StreamAction) => {
    const next = streamReducer(streamingRef.current, action);
    if (next !== streamingRef.current) {
      streamingRef.current = next;
      setStreaming(next);
    }
  }, []);

  // A /reload re-runs the extension and re-attaches the bridge; if no
  // completion signal lands (commands_changed, bridge_resync, session_state),
  // expire the banner so it never sticks around as a false "still reloading".
  useEffect(() => {
    if (!reloading) return;
    const timer = setTimeout(() => setReloading(false), RELOAD_INDICATOR_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [reloading]);

  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions");
      const body = (await res.json()) as { sessions?: SessionSummary[] };
      setSessions(body.sessions ?? []);
    } catch {
      // Offline: keep the last list.
    }
  }, []);

  // The session list is push-driven: one directory EventSource carries the
  // full snapshot on connect, then only running/idle and add/remove
  // transitions — no polling. A failed stream (server restart) reconnects
  // and re-snapshots on its own.
  useEffect(() => {
    const source = new EventSource("/api/sessions/events");
    source.onmessage = (event: MessageEvent<string>) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (data.type) {
        case "sessions_snapshot": {
          const body = data as { sessions?: SessionSummary[] };
          setSessions(body.sessions ?? []);
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
    };
    return () => source.close();
  }, []);

  const fetchState = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(id)}`);
      const body = (await res.json()) as { running?: boolean; state?: SessionStateLike };
      // Merge, not replace: a session_state push may have landed before this
      // fetch (or between its read and now), and the fetched bridge state
      // can lag a just-applied model. The push is the fresher truth.
      setSessionState((prev) => ({
        isStreaming: body.state?.isStreaming ?? prev?.isStreaming ?? false,
        isBashRunning: body.state?.isBashRunning ?? prev?.isBashRunning ?? false,
        isCompacting: body.state?.isCompacting ?? prev?.isCompacting ?? false,
        model: body.state?.model ?? prev?.model,
        contextUsage: body.state?.contextUsage ?? prev?.contextUsage ?? null,
        thinkingLevel: body.state?.thinkingLevel ?? prev?.thinkingLevel ?? "off",
      }));
    } catch {
      // State reads are best-effort; the stream reports connection health.
    }
  }, []);

  // The plugin registry is static per page load; the surfaces it declares
  // drive slots, pages and shortcut bindings.
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/plugins")
      .then((res) => res.json() as Promise<{ plugins?: WebPluginDescriptor[] }>)
      .then((body) => {
        if (!cancelled) setPlugins(body.plugins ?? []);
      })
      .catch(() => {
        // Registry fetch is best-effort; empty means no plugin surfaces.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Open the event stream (and load history) whenever the selection changes.
  useEffect(() => {
    setUserMessages([]);
    setHistory([]);
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
    streamingRef.current = INITIAL_STREAMING_STATE;
    setStreaming(INITIAL_STREAMING_STATE);

    if (selectedId === null) {
      setConnection("idle");
      return;
    }
    let closed = false;
    setConnection("connecting");

    // The live session's dispatchable slash commands (extension/prompt/
    // skill); built-ins come from the shared list. Best-effort: a failed
    // fetch just leaves the built-ins.
    void fetch(`/api/agent/${encodeURIComponent(selectedId)}/commands`)
      .then((res) => (res.ok ? (res.json() as Promise<{ commands?: WebCommand[] }>) : { commands: [] }))
      .then((body) => {
        if (!closed) setSessionCommands(body.commands ?? []);
      })
      .catch(() => {
        // The palette falls back to the built-ins.
      });

    // The history fetch and the event stream race: an assistant reply that
    // ends while history is still loading must survive the load. Appends are
    // buffered until the load resolves (or fails), then merged in order.
    let historyApplied = false;
    const pendingAppends: HistoryEntryLike[] = [];
    // Whether the entry appended for the current run already carries the
    // aborted marker, so agent_settled only adds one marker per run.
    let lastAppendedAborted = false;
    // A `!` command opened by user_bash and not yet finalized by
    // bash_execution_end; late-attaching streams only see the end event.
    let bashOpen = false;
    // The first `connected` frames the initial snapshot; later ones are
    // reconnects that may have missed events and reload the history.
    let everConnected = false;

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

    /** Structural entry equality — the dedupe key for the overlap window. */
    const sameEntry = (a: HistoryEntryLike, b: HistoryEntryLike): boolean =>
      a.role === b.role
      && a.aborted === b.aborted
      && a.error === b.error
      && JSON.stringify(a.blocks) === JSON.stringify(b.blocks);

    const applyHistory = (
      entries: HistoryEntryLike[],
      diskToolResults: Record<string, ToolResultLike>,
    ): void => {
      if (closed) return;
      historyApplied = true;
      // The overlap window: an entry completing between this stream's
      // subscribe and the history file's read is BOTH a buffered live
      // append AND the history tail. The covered entries are the leading
      // run of pendingAppends matching the trailing run of the loaded
      // entries, in order — drop that run so the entry renders once.
      let drop = 0;
      const maxK = Math.min(pendingAppends.length, entries.length);
      for (let k = maxK; k > 0; k--) {
        const tail = entries.slice(entries.length - k);
        if (pendingAppends.slice(0, k).every((pending, i) => sameEntry(pending, tail[i] ?? pending))) {
          drop = k;
          break;
        }
      }
      setHistory([...entries, ...pendingAppends.slice(drop)]);
      // Results captured live win over the disk snapshot.
      setToolResults((prev) => ({ ...diskToolResults, ...prev }));
    };

    // Subscribe-before-snapshot: the history fetch fires once the stream
    // is `connected` (below), so the file read covers everything before
    // the subscribe and the buffered appends cover everything after — no
    // gap between them where a completed reply would be invisible to both.
    const fetchHistoryOnce = (): void => {
      void fetch(`/api/agent/${encodeURIComponent(selectedId)}/history`)
        .then((res) => res.json() as Promise<{ entries?: HistoryEntryLike[]; toolResults?: Record<string, ToolResultLike> }>)
        .then((body) => {
          applyHistory(body.entries ?? [], body.toolResults ?? {});
        })
        .catch(() => {
          applyHistory([], {});
        });
    };
    // The initial state read (model, thinking, context): the model chip
    // renders from it before any session_state push arrives.
    void fetchState(selectedId);

    const source = new EventSource(`/api/agent/${encodeURIComponent(selectedId)}/events`);
    source.onmessage = (event: MessageEvent<string>) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (data.type) {
        case "connected":
          setConnection("connected");
          applyStream(data.isStreaming ? { type: "run_start" } : { type: "run_end" });
          // First connect: the stream is live, so NOW the history can be
          // read without a loss window. A reconnect (everConnected) may
          // have missed events — a server drop, or the session switching
          // owners (a TUI bridge over this in-process copy) — so the epoch
          // re-runs this whole effect: fresh stream, fresh history.
          if (!everConnected) {
            everConnected = true;
            fetchHistoryOnce();
          } else {
            setHistoryEpoch((epoch) => epoch + 1);
          }
          break;
        case "startup_error":
          setConnection("error");
          source.close();
          // No live stream — the file still renders (best effort).
          if (!everConnected) {
            everConnected = true;
            fetchHistoryOnce();
          }
          break;
        case "agent_start":
          // A run started (perhaps from the TUI): the working line and the
          // streaming reply both key off this, so "pi is thinking" is
          // visible before the first assistant token.
          lastAppendedAborted = false;
          applyStream({ type: "run_start" });
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
          setHistoryEpoch((epoch) => epoch + 1);
          void fetchState(selectedId);
          break;
        }
        case "bridge_resync":
          // The TUI-side bridge re-attached after a drop; reload the history
          // in case events were missed while it was away. Optimistic user
          // messages come back with the reloaded history.
          setReloading(false);
          setUserMessages([]);
          setHistoryEpoch((epoch) => epoch + 1);
          break;
        case "session_state": {
          // The TUI-side model/thinking state, pushed at attach, at each
          // turn start and after any change — this is the sync that keeps
          // the model chip honest in both directions.
          setReloading(false);
          const pushed = data as { model?: { provider?: unknown; id?: unknown }; thinkingLevel?: unknown };
          const pushedModel = typeof pushed.model?.provider === "string" && typeof pushed.model?.id === "string"
            ? { provider: pushed.model.provider, id: pushed.model.id }
            : undefined;
          setSessionState((prev) => ({
            isStreaming: prev?.isStreaming ?? false,
            isBashRunning: prev?.isBashRunning ?? false,
            isCompacting: prev?.isCompacting ?? false,
            model: pushedModel ?? prev?.model,
            contextUsage: prev?.contextUsage ?? null,
            thinkingLevel: typeof pushed.thinkingLevel === "string" ? pushed.thinkingLevel : prev?.thinkingLevel ?? "off",
          }));
          break;
        }
        case "web_models": {
          // The extension's model list for the picker: scoped models when
          // scoping is active, else the available catalogue.
          const pushed = data as { models?: unknown; current?: { provider?: unknown; id?: unknown } };
          const models = Array.isArray(pushed.models)
            ? (pushed.models as ModelRefLike[]).filter(
              (ref) => typeof ref?.provider === "string" && typeof ref?.id === "string",
            )
            : [];
          setModels({
            models,
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
            void fetch(`/api/agent/${encodeURIComponent(selectedId)}/commands`)
              .then((res) => (res.ok ? (res.json() as Promise<{ commands?: WebCommand[] }>) : { commands: [] }))
              .then((body) => {
                if (!closed) setSessionCommands(body.commands ?? []);
              })
              .catch(() => undefined);
          }
          break;
        case "plugin_state": {
          // Plugin views, the working indicator model and the running flag,
          // all scoped to this stream's session.
          setPluginViews((data.views ?? {}) as Record<string, WebView>);
          setWorking((data.working ?? null) as WorkingModelLike | null);
          setUiRunning(data.running === true);
          setStatuses((data.statuses ?? {}) as Record<string, string>);
          setWidgets((data.widgets ?? {}) as Record<string, WidgetModelLike>);
          setCustom((data.custom ?? {}) as Record<string, CustomPanelLike>);
          setNotifications((data.notifications ?? []) as WebNotificationLike[]);
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
    };
    source.onerror = () => {
      // EventSource reconnects on its own; surface the gap as "connecting".
      setConnection((prev) => (prev === "connected" ? "connecting" : "error"));
      // But it gives up for good on a 401 (CLOSED, no retry) — an access token that expired
      // while the stream was down. Refresh the session and open a fresh stream.
      if (source.readyState === EventSource.CLOSED && !closed) {
        void getAuth()
          .recoverStream()
          .then((recovered) => {
            if (recovered && !closed) setHistoryEpoch((epoch) => epoch + 1);
          });
      }
    };

    return () => {
      closed = true;
      source.close();
      setConnection("idle");
    };
  }, [selectedId, historyEpoch, applyStream, fetchState]);

  const newSession = useCallback(async (cwd?: string) => {
    try {
      const res = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cwd !== undefined && cwd.trim() !== "" ? { cwd } : {}),
      });
      const body = (await res.json()) as { sessionId?: string; error?: string };
      if (body.sessionId !== undefined) {
        await refreshSessions();
        setSelectedId(body.sessionId);
        return null;
      }
      return body.error ?? `new session failed (HTTP ${res.status})`;
    } catch {
      return "could not reach the server";
    }
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
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "prompt",
          message: text,
          ...(images.length > 0 ? { images } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSendError(body.error ?? `prompt failed (HTTP ${res.status})`);
      }
    } catch {
      setSendError("prompt could not be delivered — is the server reachable?");
    }
  }, [selectedId]);

  // Dispatch a web core command: the session's extension registry runs it in
  // the pi process (bridged sessions) or the in-process runner handles the
  // re-routed prompt. The composer uses this for commands marked web:true.
  const sendWebCommand = useCallback(async (name: string, args: string) => {
    const id = selectedId;
    if (id === null) return;
    setSendError(null);
    if (name === "reload") setReloading(true);
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "web_command",
          name,
          ...(args !== "" ? { args } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSendError(body.error ?? `/${name} failed (HTTP ${res.status})`);
      }
    } catch {
      setSendError(`/${name} could not be delivered — is the server reachable?`);
    }
  }, [selectedId]);

  const abort = useCallback(async () => {
    const id = selectedId;
    if (id === null) return;
    try {
      await fetch(`/api/agent/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "abort" }),
      });
    } catch {
      // Same as above: the stream reports the true state.
    }
  }, [selectedId]);

  // The web picker's model list. The SSE already streams web_models; the
  // fetch is for sessions that attach without one (in-process) and for a
  // fresh read on open.
  const fetchModels = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(id)}/models`);
      if (!response.ok) return;
      const data = (await response.json()) as ModelsState;
      setModels((prev) => ({
        models: Array.isArray(data.models) ? data.models : prev.models,
        current: data.current ?? prev.current,
      }));
    } catch {
      // The picker falls back to what the SSE already delivered.
    }
  }, []);

  // Apply a model from the web picker. The session acknowledges via the
  // session_state push; the optimistic update keeps the chip instant.
  const setModel = useCallback(async (provider: string, id: string): Promise<string | null> => {
    const sessionId = selectedId;
    if (sessionId === null) return "no session selected";
    setSessionState((prev) => prev === null ? prev : { ...prev, model: { provider, id } });
    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, id }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        return data.error ?? "model not available";
      }
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, [selectedId]);

  const setThinking = useCallback(async (level: string): Promise<string | null> => {
    const sessionId = selectedId;
    if (sessionId === null) return "no session selected";
    // Optimistic like setModel: the session_state push confirms or corrects.
    setSessionState((prev) => prev === null ? prev : { ...prev, thinkingLevel: level });
    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/thinking`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        return data.error ?? "thinking level rejected";
      }
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, [selectedId]);

  const clearDialogRequest = useCallback((): void => {
    setDialogRequest(null);
  }, []);

  return {
    sessions,
    selectedId,
    setSelectedId,
    history,
    userMessages,
    streaming,
    toolStatus,
    sessionState,
    connection,
    plugins,
    pluginViews,
    working,
    uiRunning,
    reloading,
    models,
    fetchModels,
    setModel,
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
