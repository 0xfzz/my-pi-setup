// Shrink one session event before it crosses the bridge to the web server.
//
// Pi's message_update carries the cumulative message (`message`), and each
// assistantMessageEvent carries a cumulative `partial`. Posting both with every
// token makes the bytes per event grow with the answer, so a long turn costs
// quadratic work in the pi process that also runs the TUI (measured at 575 MB
// posted for a 59 KB answer).
//
// The browser builds text, thinking and tool input from the deltas alone, and
// the server's stream tracker rebuilds a block from its *_start and *_end
// events. So deltas keep only their delta and the top-level message is dropped;
// block boundaries keep `partial`, which is needed to create and close a block.
// Message start and end keep their message: they are the commit points.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isDelta = (type: unknown): boolean =>
  typeof type === "string" && type.endsWith("_delta");

export function slimBridgeEvent(event: unknown): unknown {
  if (!isRecord(event) || event.type !== "message_update") return event;
  const { message: _message, ...withoutMessage } = event;
  void _message;
  const update = event.assistantMessageEvent;
  if (!isRecord(update) || !("partial" in update) || !isDelta(update.type)) return withoutMessage;
  const { partial: _partial, ...delta } = update;
  void _partial;
  return { ...withoutMessage, assistantMessageEvent: delta };
}
