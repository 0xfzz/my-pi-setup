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
export interface ImageBlock {
  kind: "image";
  data: string;
  mimeType: string;
}
/** A user-run `!` command from the TUI: command, output, exit code. */
export interface BashBlock {
  kind: "bash";
  command: string;
  output: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
}
export type AssistantBlock = TextBlock | ThinkingBlock | ToolCallBlock | ImageBlock | BashBlock;

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

/**
 * Two lifecycles, deliberately split:
 *  - the RUN (agent_start → agent_settled): the whole turn, including tool
 *    calls and gaps between messages. `isStreaming` means "the run is
 *    active" — it must NOT flicker between messages, or every tool call
 *    blips the working indicator and the sidebar's running mark.
 *  - the MESSAGE (message_start → message_end): one assistant message
 *    streaming inside the run. Ending it clears the message; the run goes
 *    on ("pi is working…" through tool execution).
 */
export type StreamAction =
  | { type: "run_start" }
  | { type: "message_start"; message: { role?: unknown; content?: unknown } }
  | { type: "snapshot"; message: { role?: unknown; content?: unknown } }
  | { type: "delta"; event: ClientAssistantEventLike }
  | { type: "message_end" }
  | { type: "run_end" };

export const INITIAL_STREAMING_STATE: StreamingState = {
  isStreaming: false,
  streamingMessage: null,
};

/**
 * Normalize pi's native message content to the client's block shapes. Tool
 * calls arrive in two spellings — pi's `{ id, name, arguments }` (live wire
 * before normalization, disk history) and the browser's
 * `{ toolCallId, toolName, rawInput }` — and both are accepted.
 */
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
    } else if (block.type === "image" && typeof block.data === "string") {
      blocks.push({
        kind: "image",
        data: block.data,
        mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/png",
      });
    } else if (block.type === "toolCall") {
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

/** The failure markers an assistant message's stop reason implies. */
export interface AssistantFailure {
  /** The reply ended because the run was aborted (Escape in the TUI, Stop here). */
  aborted?: boolean;
  /** The reply ended in a provider error; its message. */
  error?: string;
}

/** Fallback when the provider reports a failure with an empty message. */
const PROVIDER_ERROR_DEFAULT = "provider error";

/**
 * A finished assistant message → its transcript entry: the normalized blocks
 * plus the failure marker its stop reason carries. `stopReason: "error"` is a
 * model/API failure (its `errorMessage` is the provider's own report);
 * `stopReason: "aborted"` is an interrupt; a normal stop has neither.
 */
export function assistantEntryFromMessage(message: {
  content?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}): { blocks: AssistantBlock[] } & AssistantFailure {
  const blocks = toAssistantBlocks(message.content);
  if (message.stopReason === "aborted") return { blocks, aborted: true };
  if (message.stopReason === "error") {
    return {
      blocks,
      error: typeof message.errorMessage === "string" && message.errorMessage !== ""
        ? message.errorMessage
        : PROVIDER_ERROR_DEFAULT,
    };
  }
  return { blocks };
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
      return updateContentBlock(state, event.contentIndex, (current) => ({
        kind: "toolCall",
        toolCallId: event.toolCall?.id ?? (current?.kind === "toolCall" ? current.toolCallId : ""),
        toolName: event.toolCall?.name ?? (current?.kind === "toolCall" ? current.toolName : "tool"),
        // The end's parsed arguments are authoritative; keep the streamed
        // JSON when the end carries none (aborted mid-argument).
        rawInput: event.toolCall?.arguments !== undefined && typeof event.toolCall.arguments === "object"
          ? JSON.stringify(event.toolCall.arguments)
          : (current?.kind === "toolCall" ? current.rawInput : ""),
      }));
    default:
      return state;
  }
}

export function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "run_start":
      return { isStreaming: true, streamingMessage: null };
    case "message_start":
    case "snapshot": {
      if (action.message.role !== "assistant") return state;
      return {
        isStreaming: true,
        streamingMessage: { role: "assistant", content: toAssistantBlocks(action.message.content) },
      };
    }
    case "delta":
      return applyDelta(state, action.event);
    case "message_end":
      // The message committed; the run may continue (a tool call, the next
      // message). Keep `isStreaming` — the working line and the sidebar's
      // running mark stay steady until the run settles.
      return { isStreaming: true, streamingMessage: null };
    case "run_end":
      return INITIAL_STREAMING_STATE;
    default:
      return state;
  }
}
