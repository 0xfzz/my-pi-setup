// Streaming assistant-message accumulator — trimmed port of the vendored
// app's streaming-message.ts, with block shapes unified with the history
// endpoint's. Deltas build content blocks; `*_end` events replace them with
// the authoritative content.

export interface TextBlock {
  kind: "text";
  text: string;
}
export interface ThinkingBlock {
  kind: "thinking";
  thinking: string;
}
export interface ToolCallBlock {
  kind: "toolCall";
  toolCallId: string;
  toolName: string;
  rawInput: string;
}
export type AssistantBlock = TextBlock | ThinkingBlock | ToolCallBlock;

export interface AssistantMessageLite {
  role: "assistant";
  content: AssistantBlock[];
}

export interface ClientAssistantEventLike {
  type: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  id?: string;
  toolName?: string;
  toolCall?: { id?: string; name?: string; arguments?: Record<string, unknown> };
  [key: string]: unknown;
}

export interface StreamingState {
  isStreaming: boolean;
  streamingMessage: AssistantMessageLite | null;
}

export type StreamAction =
  | { type: "start" }
  | { type: "snapshot"; message: { role?: unknown; content?: unknown } }
  | { type: "delta"; event: ClientAssistantEventLike }
  | { type: "end" };

export const INITIAL_STREAMING_STATE: StreamingState = {
  isStreaming: false,
  streamingMessage: null,
};

/** Normalize pi's native message content to the client's block shapes. */
export function toAssistantBlocks(content: unknown): AssistantBlock[] {
  if (typeof content === "string") {
    return content ? [{ kind: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: AssistantBlock[] = [];
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ kind: "text", text: block.text });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      blocks.push({ kind: "thinking", thinking: block.thinking });
    } else if (block.type === "toolCall") {
      const toolName = typeof block.toolName === "string"
        ? block.toolName
        : (typeof block.name === "string" ? block.name : "tool");
      blocks.push({
        kind: "toolCall",
        toolCallId: typeof block.toolCallId === "string" ? block.toolCallId : "",
        toolName,
        rawInput: typeof block.rawInput === "string" ? block.rawInput : "",
      });
    }
  }
  return blocks;
}

function updateContentBlock(
  state: StreamingState,
  contentIndex: number | undefined,
  update: (current: AssistantBlock | undefined) => AssistantBlock | null,
): StreamingState {
  const message = state.streamingMessage;
  if (message === null || !Number.isInteger(contentIndex) || (contentIndex ?? -1) < 0) {
    return state;
  }
  const index = contentIndex as number;
  const content = [...message.content];
  const next = update(content[index]);
  if (next === null) return state;
  content[index] = next;
  return { isStreaming: true, streamingMessage: { ...message, content } };
}

function applyDelta(state: StreamingState, event: ClientAssistantEventLike): StreamingState {
  switch (event.type) {
    case "text_start":
      // Blocks are empty at their `*_start` and grown only by `*_delta`:
      // reset, or a snapshot leak renders the first chunk twice.
      return updateContentBlock(state, event.contentIndex, () => ({ kind: "text", text: "" }));
    case "text_delta":
      return updateContentBlock(state, event.contentIndex, (current) => (
        current?.kind === "text"
          ? { kind: "text", text: current.text + (event.delta ?? "") }
          : null
      ));
    case "text_end":
      return updateContentBlock(state, event.contentIndex, (current) => ({
        kind: "text",
        text: typeof event.content === "string" ? event.content : (current?.kind === "text" ? current.text : ""),
      }));
    case "thinking_start":
      return updateContentBlock(state, event.contentIndex, () => ({ kind: "thinking", thinking: "" }));
    case "thinking_delta":
      return updateContentBlock(state, event.contentIndex, (current) => (
        current?.kind === "thinking"
          ? { kind: "thinking", thinking: current.thinking + (event.delta ?? "") }
          : null
      ));
    case "thinking_end":
      return updateContentBlock(state, event.contentIndex, (current) => ({
        kind: "thinking",
        thinking: typeof event.content === "string" ? event.content : (current?.kind === "thinking" ? current.thinking : ""),
      }));
    case "toolcall_start":
      return updateContentBlock(state, event.contentIndex, (current) => {
        if (current?.kind === "toolCall") {
          return {
            kind: "toolCall",
            toolCallId: event.id ?? current.toolCallId,
            toolName: event.toolName ?? current.toolName,
            rawInput: "",
          };
        }
        if (typeof event.toolName !== "string") return null;
        return {
          kind: "toolCall",
          toolCallId: event.id ?? "",
          toolName: event.toolName,
          rawInput: "",
        };
      });
    case "toolcall_delta":
      return updateContentBlock(state, event.contentIndex, (current) => (
        current?.kind === "toolCall"
          ? {
            kind: "toolCall",
            toolCallId: event.id || current.toolCallId,
            toolName: event.toolName || current.toolName,
            rawInput: current.rawInput + (event.delta ?? ""),
          }
          : null
      ));
    case "toolcall_end":
      return updateContentBlock(state, event.contentIndex, () => ({
        kind: "toolCall",
        toolCallId: event.toolCall?.id ?? "",
        toolName: event.toolCall?.name ?? "tool",
        rawInput: "",
      }));
    default:
      return state;
  }
}

export function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "snapshot": {
      if (action.message.role !== "assistant") return state;
      return {
        isStreaming: true,
        streamingMessage: { role: "assistant", content: toAssistantBlocks(action.message.content) },
      };
    }
    case "delta":
      return applyDelta(state, action.event);
    case "end":
      return INITIAL_STREAMING_STATE;
    default:
      return state;
  }
}
