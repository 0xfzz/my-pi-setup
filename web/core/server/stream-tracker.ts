// The streaming snapshot tracker — the piece that makes (re)connects sync.
//
// A browser stream that attaches mid-turn never saw `message_start`, so the
// client's delta accumulator has nothing to append to and drops every
// delta (the reply pops in fully-formed at `message_end`). This tracker
// taps the session's RAW events and remembers the current in-flight state.
// Every new browser stream replays it as a synthetic `message_start` right
// after `connected`, and deltas continue from there.
//
// The bridge hop sends deltas without their cumulative `partial` (see
// lib/bridge-event-slim.ts), so the tracker builds the in-flight content
// itself: a block is created by its `*_start` (which still carries `partial`),
// grown by each `*_delta`, and replaced by the `*_end`. A `partial` that does
// arrive is taken as the exact content, so full events from an older extension
// still work.
//
// Both hosts feed the same machine: the bridge (raw events from the TUI)
// and in-process sessions (a permanent tap at registration).

export interface StreamSnapshot {
  /** An assistant message is in flight. */
  started: boolean;
  /** The cumulative partial message (content blocks so far), when known. */
  message: { role: "assistant"; content: unknown } | null;
}

interface AssistantMessageLike {
  role?: unknown;
  content?: unknown;
}

type Block = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isAssistantMessage = (message: unknown): message is AssistantMessageLike =>
  isObject(message) && message.role === "assistant";

export interface StreamTracker {
  /** Feed one raw session event (before wire normalization). */
  feed(event: unknown): void;
  /** The current in-flight state, for stream replay. */
  snapshot(): StreamSnapshot;
}

/** The tool-call arguments a JSON prefix parses to, or undefined while the JSON is still incomplete. */
function parsedArguments(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The tool-call block with its parsed argument prefix, if that prefix is JSON. */
function withArguments(block: Block, argumentText: string): Block | undefined {
  if (block.type !== "toolCall") return undefined;
  const args = parsedArguments(argumentText);
  return args === undefined ? block : { ...block, arguments: args };
}

interface TextChunks {
  text?: string[];
  thinking?: string[];
}

/** Join deferred text deltas once, at snapshot time, instead of per token. */
function materializeBlock(block: Block, chunks: TextChunks | undefined): Block {
  if (chunks?.text !== undefined && block.type === "text") return { ...block, text: chunks.text.join("") };
  if (chunks?.thinking !== undefined && block.type === "thinking") return { ...block, thinking: chunks.thinking.join("") };
  return block;
}

export function createStreamTracker(): StreamTracker {
  let started = false;
  let content: Block[] | null = null;
  // The raw JSON text of each tool call's arguments, by content index, as its deltas arrive.
  const argumentText = new Map<number, string>();
  // Text/thinking deltas accumulate as chunks; rebuilding the whole prefix
  // on every token was quadratic in the length of the answer.
  const textChunks = new Map<number, TextChunks>();

  const messageSnapshot = (): StreamSnapshot["message"] =>
    content === null ? null : { role: "assistant", content: content.map((block, index) => materializeBlock(block, textChunks.get(index))) };

  const replaceContent = (partial: AssistantMessageLike): void => {
    content = Array.isArray(partial.content) ? partial.content.filter(isObject) : [];
    textChunks.clear();
  };

  const applyDelta = (update: Record<string, unknown>): void => {
    if (content === null || typeof update.contentIndex !== "number" || typeof update.delta !== "string") return;
    const index = update.contentIndex;
    const block = content[index];
    if (block === undefined || typeof update.type !== "string") return;
    if (update.type === "toolcall_delta") {
      argumentText.set(index, `${argumentText.get(index) ?? ""}${update.delta}`);
      const extended = withArguments(block, argumentText.get(index) ?? "");
      if (extended !== undefined) content[index] = extended;
      return;
    }
    const field = update.type === "text_delta" ? "text" : update.type === "thinking_delta" ? "thinking" : undefined;
    if (field === undefined) return;
    let chunks = textChunks.get(index);
    if (chunks === undefined) {
      chunks = {};
      textChunks.set(index, chunks);
    }
    (chunks[field] ??= []).push(update.delta);
  };

  const applyUpdate = (update: Record<string, unknown>): void => {
    const partial = update.partial;
    if (isAssistantMessage(partial)) {
      // A block boundary (or a full event from an older extension): the partial is exact.
      replaceContent(partial);
      if (update.type === "toolcall_start" && typeof update.contentIndex === "number") argumentText.set(update.contentIndex, "");
      return;
    }
    if (typeof update.type === "string" && update.type.endsWith("_delta")) applyDelta(update);
  };

  return {
    feed(event: unknown): void {
      if (!isObject(event)) return;
      switch (event.type) {
        case "message_start": {
          // The start carries the (empty) message; blocks fill in on updates.
          // A non-assistant start (a user echo) does not stream.
          if (isAssistantMessage(event.message)) {
            started = true;
            argumentText.clear();
            replaceContent(event.message);
          }
          return;
        }
        case "message_update": {
          // Each update's assistantMessageEvent carries the change: a block boundary
          // with its partial, or a delta applied to the block it extends.
          const update = event.assistantMessageEvent;
          if (isObject(update)) applyUpdate(update);
          return;
        }
        case "message_end": {
          // The message is committed: the client's `message_end` handler
          // appends the authoritative entry; streaming state resets.
          if (isAssistantMessage(event.message)) {
            started = false;
            content = null;
            argumentText.clear();
            textChunks.clear();
          }
          return;
        }
        case "agent_end":
        case "agent_settled":
        case "session_shutdown": {
          started = false;
          content = null;
          argumentText.clear();
          textChunks.clear();
          return;
        }
        default:
          return;
      }
    },

    snapshot(): StreamSnapshot {
      return { started, message: messageSnapshot() };
    },
  };
}
