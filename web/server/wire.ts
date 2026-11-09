// Event projection for the browser wire. Trimmed port of the vendored
// app's agent-event-wire.ts: pi's session events are slimmed to what a
// chat UI consumes — no turn markers, no transcript system messages, no
// re-sent bodies, and message_update deltas without the cumulative
// `partial` snapshots.
//
// Dropped from the vendored version (tracked in the PRD as chrome):
// message-signature stripping and codemode snapshot truncation.

export interface AgentEventLike {
  type: string;
  [key: string]: unknown;
}

/** Heartbeat cadence for the SSE stream, as a data event so EventSource sees it. */
export const AGENT_EVENT_HEARTBEAT_MS = 30_000;

const OMITTED_EVENT_TYPES = new Set([
  "turn_start",
  "turn_end",
  // Carries the whole appended entry (an extension custom entry can be
  // 1 MiB) and the browser transcript never reads it.
  "entry_appended",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A `tool_execution_*` event for a nested call another tool made while it ran
 * (`ctx.executeTool()`). The SDK gives those `parentToolCallId`; the model
 * never sees them as tool calls, and the parent's own updates report them.
 */
export function isNestedToolExecutionEvent(event: AgentEventLike): boolean {
  return (
    (event.type === "tool_execution_start"
      || event.type === "tool_execution_update"
      || event.type === "tool_execution_end")
    && typeof event.parentToolCallId === "string"
    && event.parentToolCallId !== ""
  );
}

/**
 * Nested calls travel as a slim start and end with their progress dropped. A
 * `tool_execution_end` never carries `result`: the browser only reads ids and
 * status, while the raw result can hold up to 1 MiB of bash output.
 */
function toClientToolExecutionEvent(event: AgentEventLike): AgentEventLike | null {
  const nested = isNestedToolExecutionEvent(event);
  if (event.type === "tool_execution_start") {
    if (!nested) return event;
    return {
      type: "tool_execution_start",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      parentToolCallId: event.parentToolCallId,
    };
  }
  if (event.type === "tool_execution_update") {
    if (nested) return null;
    return {
      type: "tool_execution_update",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      partialResult: event.partialResult,
    };
  }
  return {
    type: "tool_execution_end",
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    isError: event.isError,
    ...(nested ? { parentToolCallId: event.parentToolCallId } : {}),
  };
}

/** The `message_update` delta for a streaming tool call, with its ids kept. */
function toolCallMetadata(event: Record<string, unknown>): { id: string; toolName: string } | null {
  if (
    (event.type !== "toolcall_start" && event.type !== "toolcall_delta")
    || !isObject(event.partial)
  ) {
    return null;
  }
  const content = event.partial.content;
  const contentIndex = event.contentIndex;
  if (!Array.isArray(content) || typeof contentIndex !== "number") return null;

  const block = content[contentIndex];
  if (!isObject(block) || block.type !== "toolCall") return null;
  const id = typeof block.id === "string"
    ? block.id
    : (typeof block.toolCallId === "string" ? block.toolCallId : null);
  const toolName = typeof block.name === "string"
    ? block.name
    : (typeof block.toolName === "string" ? block.toolName : null);
  return id !== null && toolName !== null ? { id, toolName } : null;
}

/** A `message_start` / `message_end` for a transcript system message (prompt/tool loadout). */
export function isSystemMessageEvent(event: AgentEventLike): boolean {
  return (event.type === "message_start" || event.type === "message_end")
    && isObject(event.message)
    && event.message.role === "system";
}

/**
 * Project one raw session event to the browser wire.
 * Returns null when the event should not be sent at all.
 */
export function toClientAgentEvent(event: AgentEventLike): AgentEventLike | null {
  if (OMITTED_EVENT_TYPES.has(event.type)) return null;
  // Pi appends the prompt and tool loadout to the transcript as system
  // messages; the browser never renders them, so drop them before they cost
  // bandwidth.
  if (isSystemMessageEvent(event)) return null;
  // The agent loop announces finished non-assistant messages (tool results,
  // delivered user messages) with start/end back to back. The browser builds
  // only an assistant reply from its start; everything else needs the role.
  if (event.type === "message_start" && isObject(event.message) && event.message.role !== "assistant") {
    return { type: "message_start", message: { role: event.message.role } };
  }
  // Assistant starts carry the full message content, which the snapshot
  // replay also sends; slim to the message itself.
  if (event.type === "message_start" || event.type === "message_end") {
    return event;
  }

  if (event.type === "message_update") {
    const rawAssistantMessageEvent = event.assistantMessageEvent;
    if (!isObject(rawAssistantMessageEvent)) return null;

    if (!("partial" in rawAssistantMessageEvent)) {
      return {
        type: "message_update",
        assistantMessageEvent: rawAssistantMessageEvent,
      };
    }
    const metadata = toolCallMetadata(rawAssistantMessageEvent);
    const { partial: _partial, ...deltaEvent } = rawAssistantMessageEvent;
    void _partial;
    return {
      type: "message_update",
      assistantMessageEvent: metadata ? { ...deltaEvent, ...metadata } : deltaEvent,
    };
  }

  if (
    event.type === "tool_execution_start"
    || event.type === "tool_execution_update"
    || event.type === "tool_execution_end"
  ) {
    return toClientToolExecutionEvent(event);
  }

  if (event.type === "agent_end") return { type: "agent_end" };
  return event;
}

/**
 * The session snapshot replay sends `message_start` with the same message
 * object the listener replay emits; skip the duplicate.
 */
export function isEventIncludedInSnapshot(event: AgentEventLike, snapshot: unknown): boolean {
  return snapshot !== undefined
    && (event.type === "message_start" || event.type === "message_update")
    && event.message === snapshot;
}

/**
 * Whether a later event repairs this one if dropped: a `*_delta` only extends
 * a block that its `*_end` replaces, and a `tool_execution_update` carries the
 * whole partial result, superseded by the next update or the end.
 */
export function isDroppableEvent(event: AgentEventLike): boolean {
  if (event.type === "tool_execution_update") return true;
  if (event.type !== "message_update") return false;
  const update = event.assistantMessageEvent;
  return typeof update === "object"
    && update !== null
    && typeof (update as { type?: unknown }).type === "string"
    && (update as { type: string }).type.endsWith("_delta");
}
