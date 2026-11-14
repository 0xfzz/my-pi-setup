// Projection of one live session event into the plugin tap vocabulary
// (`web/core/plugin-contracts/kernel/events.ts`).
//
// The tap is a plugin contract, not a browser one, so it gets its own
// projection: the browser wire normalizes tool calls into its own spelling and
// carries whole assistant messages, while a plugin needs a small, stable
// payload it can act on without re-parsing pi's shapes. Every payload here is
// capped — a `message_end` or a bash execution can be megabytes, and the tap
// promises bounded events.
//
// Only types listed in `TAP_PROJECTORS` are published. Streaming deltas
// (`message_update`, `tool_execution_update`) are deliberately absent: a
// subscriber would see hundreds of them per turn for a payload its end event
// already carries.

import type { EventTapRegistry, TapChannel, TapEvent } from "../plugin-contracts/kernel/events.ts";

/** Cap on any text field the tap carries (message text, bash output). */
export const TAP_TEXT_LIMIT = 4_000;

type RawEvent = Record<string, unknown>;

/** One bounded, plugin-safe payload, or null when the event carries nothing usable. */
type Projector = (raw: RawEvent) => Readonly<Record<string, unknown>> | null;

const PROJECTORS: Readonly<Record<string, { channel: TapChannel; project: Projector }>> = {
  agent_start: { channel: "session.lifecycle", project: () => ({}) },
  agent_end: { channel: "session.lifecycle", project: () => ({}) },
  agent_settled: { channel: "session.lifecycle", project: () => ({}) },
  session_shutdown: { channel: "session.lifecycle", project: () => ({}) },
  session_info_changed: {
    channel: "session.lifecycle",
    project: (raw) => (typeof raw.name === "string" ? { name: raw.name } : {}),
  },
  message_start: { channel: "session.message", project: messagePayload },
  message_end: { channel: "session.message", project: messagePayload },
  tool_execution_start: { channel: "session.tool", project: toolPayload },
  tool_execution_end: { channel: "session.tool", project: toolPayload },
  entry_appended: { channel: "session.tool", project: bashPayload },
};

function isObject(value: unknown): value is RawEvent {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > TAP_TEXT_LIMIT ? `${value.slice(0, TAP_TEXT_LIMIT)}…` : value;
}

/** A message's text content, capped; block types kept so a plugin can tell what arrived. */
function messagePayload(raw: RawEvent): Readonly<Record<string, unknown>> | null {
  if (!isObject(raw.message)) return null;
  const message = raw.message;
  const role = typeof message.role === "string" ? message.role : "unknown";
  const content = message.content;
  const blocks = Array.isArray(content) ? content : [];
  const blockTypes = blocks
    .map((block) => (isObject(block) && typeof block.type === "string" ? block.type : undefined))
    .filter((type): type is string => type !== undefined);
  const body = typeof content === "string"
    ? content
    : blocks
      .map((block) => (isObject(block) && typeof block.text === "string" ? block.text : ""))
      .join("");
  return {
    role,
    blockTypes,
    ...(body !== "" ? { text: text(body) } : {}),
  };
}

/** A tool call's identity and outcome. The result body stays off the tap. */
function toolPayload(raw: RawEvent): Readonly<Record<string, unknown>> | null {
  if (typeof raw.toolCallId !== "string" || typeof raw.toolName !== "string") return null;
  return {
    toolCallId: raw.toolCallId,
    toolName: raw.toolName,
    ...(raw.isError === true ? { isError: true } : {}),
    ...(typeof raw.parentToolCallId === "string" ? { parentToolCallId: raw.parentToolCallId } : {}),
  };
}

/** pi appends bash executions as transcript entries; only that entry kind is a tap event. */
function bashPayload(raw: RawEvent): Readonly<Record<string, unknown>> | null {
  if (!isObject(raw.entry) || !isObject(raw.entry.message)) return null;
  const message = raw.entry.message;
  if (message.role !== "bashExecution") return null;
  return {
    command: typeof message.command === "string" ? message.command : "",
    exitCode: typeof message.exitCode === "number" ? message.exitCode : undefined,
    cancelled: message.cancelled === true,
    ...(typeof message.output === "string" ? { output: text(message.output) } : {}),
  };
}

/** The channel a raw pi event type is published on, or null when the tap ignores it. */
export function tapChannelFor(eventType: unknown): TapChannel | null {
  if (typeof eventType !== "string") return null;
  return PROJECTORS[eventType]?.channel ?? null;
}

/** Project one raw session event, or null when it is not tap traffic. */
export function projectTapEvent(sessionId: string, project: string, raw: unknown): TapEvent | null {
  if (!isObject(raw) || typeof raw.type !== "string") return null;
  const projector = PROJECTORS[raw.type];
  if (projector === undefined) return null;
  const payload = projector.project(raw);
  if (payload === null) return null;
  return { channel: projector.channel, sessionId, project, type: raw.type, payload };
}

/**
 * Publish one raw session event to the tap, when somebody listens. The channel
 * is resolved first so an unsubscribed channel costs one lookup and no
 * projection.
 */
export function publishSessionTapEvent(
  tap: EventTapRegistry | null,
  sessionId: string,
  project: string,
  raw: unknown,
): void {
  if (tap === null) return;
  const channel = tapChannelFor(isObject(raw) ? raw.type : undefined);
  if (channel === null || !tap.hasSubscribers(channel)) return;
  const event = projectTapEvent(sessionId, project, raw);
  if (event === null) return;
  void tap.publish(event);
}
