// The pi session hook: session list, selection, live transcript state.
// One EventSource per selected session carries the agent event wire; user
// messages render optimistically and assistant replies stream in via deltas.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  INITIAL_STREAMING_STATE,
  streamReducer,
  toAssistantBlocks,
  type AssistantBlock,
  type BashBlock,
  type ClientAssistantEventLike,
  type StreamingState,
  type StreamAction,
} from "./streaming.ts";
import type { WebPluginDescriptor, WebView, WorkingModelLike } from "./plugins/contract.ts";

export interface SessionSummary {
  id: string;
  cwd: string;
  live: boolean;
  modifiedAt: number;
  /** The session is mid-turn right now (agent streaming), for live sessions. */
  running?: boolean;
}

export interface HistoryEntryLike {
  role: "user" | "assistant";
  blocks: AssistantBlock[];
  /** The assistant reply ended because the run was aborted. */
  aborted?: boolean;
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
}

/** localStorage key for the selected session: reloads and plugin-page navigation keep the session context. */
const SELECTED_SESSION_KEY = "pi-web-minimal:selected-session";

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
  const [toolResults, setToolResults] = useState<Record<string, ToolResultLike>>({});
  /** Last prompt delivery failure, shown at the composer until the next send. */
  const [sendError, setSendError] = useState<string | null>(null);
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

  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions");
      const body = (await res.json()) as { sessions?: SessionSummary[] };
      setSessions(body.sessions ?? []);
    } catch {
      // Offline: keep the last list; the poll retries.
    }
  }, []);

  useEffect(() => {
    void refreshSessions();
    const timer = setInterval(() => {
      void refreshSessions();
    }, 5000);
    return () => clearInterval(timer);
  }, [refreshSessions]);

  const fetchState = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(id)}`);
      const body = (await res.json()) as { running?: boolean; state?: SessionStateLike };
      setSessionState(body.state ?? null);
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
    setToolResults({});
    streamingRef.current = INITIAL_STREAMING_STATE;
    setStreaming(INITIAL_STREAMING_STATE);

    if (selectedId === null) {
      setConnection("idle");
      return;
    }
    let closed = false;
    setConnection("connecting");

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

    const applyHistory = (
      entries: HistoryEntryLike[],
      diskToolResults: Record<string, ToolResultLike>,
    ): void => {
      if (closed) return;
      historyApplied = true;
      setHistory([...entries, ...pendingAppends]);
      // Results captured live win over the disk snapshot.
      setToolResults((prev) => ({ ...diskToolResults, ...prev }));
    };

    void fetch(`/api/agent/${encodeURIComponent(selectedId)}/history`)
      .then((res) => res.json() as Promise<{ entries?: HistoryEntryLike[]; toolResults?: Record<string, ToolResultLike> }>)
      .then((body) => {
        applyHistory(body.entries ?? [], body.toolResults ?? {});
      })
      .catch(() => {
        applyHistory([], {});
      });

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
          applyStream(data.isStreaming ? { type: "start" } : { type: "end" });
          break;
        case "startup_error":
          setConnection("error");
          source.close();
          break;
        case "agent_start":
          // A run started (perhaps from the TUI): the working line and the
          // streaming reply both key off this, so "pi is thinking" is
          // visible before the first assistant token.
          lastAppendedAborted = false;
          applyStream({ type: "start" });
          break;
        case "agent_end":
          applyStream({ type: "end" });
          break;
        case "agent_settled":
          // The run settled; `aborted` marks a cancellation (Escape in the
          // TUI, Stop in the web). If no assistant message ended — the
          // model was still thinking — append a bare marker entry.
          applyStream({ type: "end" });
          if (data.aborted === true && !lastAppendedAborted) {
            appendEntry({ role: "assistant", blocks: [], aborted: true });
          }
          lastAppendedAborted = false;
          void fetchState(selectedId);
          break;
        case "message_start": {
          const message = data.message as { role?: unknown; content?: unknown } | undefined;
          if (message?.role === "assistant") {
            applyStream({ type: "start" });
            applyStream({ type: "snapshot", message });
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
            details?: { diff?: unknown };
          } | undefined;
          if (message?.role === "assistant") {
            const entry: HistoryEntryLike = {
              role: "assistant",
              blocks: toAssistantBlocks(message.content),
              ...(message.stopReason === "aborted" ? { aborted: true } : {}),
            };
            appendEntry(entry);
            applyStream({ type: "end" });
            void fetchState(selectedId);
          } else if (message?.role === "user") {
            // A prompt typed in the TUI (or the confirmed echo of one sent
            // from here): render it, dropping the optimistic twin.
            const entry: HistoryEntryLike = {
              role: "user",
              blocks: toAssistantBlocks(message.content),
            };
            const text = messageText(entry.blocks);
            if (text !== "") {
              setUserMessages((prev) => {
                for (let i = prev.length - 1; i >= 0; i--) {
                  if (prev[i].text === text) {
                    const next = [...prev];
                    next.splice(i, 1);
                    return next;
                  }
                }
                return prev;
              });
            }
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
        case "bridge_resync":
          // The TUI-side bridge re-attached after a drop; reload the history
          // in case events were missed while it was away. Optimistic user
          // messages come back with the reloaded history.
          setUserMessages([]);
          setHistoryEpoch((epoch) => epoch + 1);
          break;
        case "plugin_state": {
          // Plugin views, the working indicator model and the running flag,
          // all scoped to this stream's session.
          setPluginViews((data.views ?? {}) as Record<string, WebView>);
          setWorking((data.working ?? null) as WorkingModelLike | null);
          setUiRunning(data.running === true);
          break;
        }
        default:
          // heartbeat and any future event types pass silently.
          break;
      }
    };
    source.onerror = () => {
      // EventSource reconnects on its own; surface the gap as "connecting".
      setConnection((prev) => (prev === "connected" ? "connecting" : "error"));
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

  const sendPrompt = useCallback(async (text: string) => {
    const id = selectedId;
    if (id === null || text.trim() === "") return;
    setUserMessages((prev) => [...prev, { key: Date.now() + prev.length, text }]);
    setSendError(null);
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "prompt", message: text }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSendError(body.error ?? `prompt failed (HTTP ${res.status})`);
      }
    } catch {
      setSendError("prompt could not be delivered — is the server reachable?");
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
    toolResults,
    sendError,
    newSession,
    sendPrompt,
    abort,
    refreshSessions,
  };
}
