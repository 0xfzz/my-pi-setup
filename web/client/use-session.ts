// The pi session hook: session list, selection, live transcript state.
// One EventSource per selected session carries the agent event wire; user
// messages render optimistically and assistant replies stream in via deltas.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  INITIAL_STREAMING_STATE,
  streamReducer,
  toAssistantBlocks,
  type AssistantBlock,
  type ClientAssistantEventLike,
  type StreamingState,
  type StreamAction,
} from "./streaming.ts";

export interface SessionSummary {
  id: string;
  cwd: string;
  live: boolean;
  modifiedAt: number;
}

export interface HistoryEntryLike {
  role: "user" | "assistant";
  blocks: AssistantBlock[];
}

export interface ToolCallStatus {
  state: "running" | "done" | "error";
  toolName: string;
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

export function usePiSession() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntryLike[]>([]);
  const [userMessages, setUserMessages] = useState<OptimisticUserMessage[]>([]);
  const [streaming, setStreaming] = useState<StreamingState>(INITIAL_STREAMING_STATE);
  const [toolStatus, setToolStatus] = useState<Record<string, ToolCallStatus>>({});
  const [sessionState, setSessionState] = useState<SessionStateLike | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("idle");

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

  // Open the event stream (and load history) whenever the selection changes.
  useEffect(() => {
    setUserMessages([]);
    setHistory([]);
    setToolStatus({});
    setSessionState(null);
    streamingRef.current = INITIAL_STREAMING_STATE;
    setStreaming(INITIAL_STREAMING_STATE);

    if (selectedId === null) {
      setConnection("idle");
      return;
    }
    let closed = false;
    setConnection("connecting");

    void fetch(`/api/agent/${encodeURIComponent(selectedId)}/history`)
      .then((res) => res.json() as Promise<{ entries?: HistoryEntryLike[] }>)
      .then((body) => {
        if (!closed) setHistory(body.entries ?? []);
      })
      .catch(() => {
        if (!closed) setHistory([]);
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
          const message = data.message as { role?: unknown; content?: unknown } | undefined;
          if (message?.role === "assistant") {
            setHistory((prev) => [
              ...prev,
              { role: "assistant", blocks: toAssistantBlocks(message.content) },
            ]);
            applyStream({ type: "end" });
            void fetchState(selectedId);
          }
          // User and tool-result ends are not rendered: user messages are
          // optimistic, tool results surface as tool-call status lines.
          break;
        }
        case "tool_execution_start": {
          const id = typeof data.toolCallId === "string" ? data.toolCallId : "";
          const toolName = typeof data.toolName === "string" ? data.toolName : "tool";
          if (id !== "") {
            setToolStatus((prev) => ({ ...prev, [id]: { state: "running", toolName } }));
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
              },
            }));
          }
          break;
        }
        case "agent_end":
          applyStream({ type: "end" });
          break;
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
  }, [selectedId, applyStream, fetchState]);

  const newSession = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json()) as { sessionId?: string };
      if (body.sessionId !== undefined) {
        await refreshSessions();
        setSelectedId(body.sessionId);
      }
    } catch {
      // The button press is user-visible; failures show up in the list poll.
    }
  }, [refreshSessions]);

  const sendPrompt = useCallback(async (text: string) => {
    const id = selectedId;
    if (id === null || text.trim() === "") return;
    setUserMessages((prev) => [...prev, { key: Date.now() + prev.length, text }]);
    try {
      await fetch(`/api/agent/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "prompt", message: text }),
      });
    } catch {
      // Delivery failures surface through the event stream error state.
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
    newSession,
    sendPrompt,
    abort,
    refreshSessions,
  };
}
