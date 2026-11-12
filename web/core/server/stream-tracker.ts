// The streaming snapshot tracker — the piece that makes (re)connects sync.
//
// A browser stream that attaches mid-turn never saw `message_start`, so the
// client's delta accumulator has nothing to append to and drops every
// delta (the reply pops in fully-formed at `message_end`). This tracker
// taps the session's RAW events (pi's message_update carries `partial`,
// the cumulative in-flight message — the wire layer strips it for steady
// streaming, so the tap sits BEFORE that) and remembers the current
// in-flight state. Every new browser stream replays it as a synthetic
// `message_start` right after `connected`, and deltas continue from there.
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

const isAssistantMessage = (message: unknown): message is AssistantMessageLike =>
  typeof message === "object" && message !== null && (message as { role?: unknown }).role === "assistant";

export interface StreamTracker {
  /** Feed one raw session event (before wire normalization). */
  feed(event: unknown): void;
  /** The current in-flight state, for stream replay. */
  snapshot(): StreamSnapshot;
}

export function createStreamTracker(): StreamTracker {
  let started = false;
  let message: { role: "assistant"; content: unknown } | null = null;

  return {
    feed(event: unknown): void {
      if (typeof event !== "object" || event === null) return;
      const typed = event as {
        type?: unknown;
        message?: unknown;
        assistantMessageEvent?: unknown;
      };
      switch (typed.type) {
        case "message_start": {
          // The start carries the (empty) message; the partial fills in on
          // updates. A non-assistant start (a user echo) does not stream.
          if (isAssistantMessage(typed.message)) {
            started = true;
            const content = typed.message.content;
            message = { role: "assistant", content };
          }
          return;
        }
        case "message_update": {
          // pi's update events carry the cumulative `partial`; when present
          // it is the live snapshot (tool-call metadata variants do not
          // carry it and leave the last snapshot standing).
          const update = typed.assistantMessageEvent;
          if (typeof update === "object" && update !== null) {
            const partial = (update as { partial?: unknown }).partial;
            if (isAssistantMessage(partial)) {
              message = { role: "assistant", content: partial.content };
            }
          }
          return;
        }
        case "message_end": {
          // The message is committed: the client's `message_end` handler
          // appends the authoritative entry; streaming state resets.
          if (isAssistantMessage(typed.message)) {
            started = false;
            message = null;
          }
          return;
        }
        case "agent_end":
        case "agent_settled":
        case "session_shutdown": {
          started = false;
          message = null;
          return;
        }
        default:
          return;
      }
    },

    snapshot(): StreamSnapshot {
      return { started, message };
    },
  };
}
