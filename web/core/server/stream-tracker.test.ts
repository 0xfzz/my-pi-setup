import test from "node:test";
import assert from "node:assert/strict";
import { createStreamTracker } from "./stream-tracker.ts";
import { slimBridgeEvent } from "../../../lib/bridge-event-slim.ts";

test("the tracker follows the streaming lifecycle", () => {
  const tracker = createStreamTracker();
  // Idle: nothing in flight.
  assert.deepEqual(tracker.snapshot(), { started: false, message: null });

  // A turn begins and the assistant message starts empty.
  tracker.feed({ type: "agent_start" });
  tracker.feed({ type: "message_start", message: { role: "assistant", content: [] } });
  assert.deepEqual(tracker.snapshot(), { started: true, message: { role: "assistant", content: [] } });

  // Updates carry the cumulative partial — the snapshot is always the
  // latest, not a delta to be applied.
  tracker.feed({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, partial: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
  });
  assert.deepEqual(tracker.snapshot(), {
    started: true,
    message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
  });
  tracker.feed({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, partial: { role: "assistant", content: [{ type: "text", text: "hello world" }] } },
  });
  assert.deepEqual(
    tracker.snapshot().message?.content,
    [{ type: "text", text: "hello world" }],
  );

  // The message commits: streaming state resets (the client's message_end
  // appends the authoritative entry itself).
  tracker.feed({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello world" }] } });
  assert.deepEqual(tracker.snapshot(), { started: false, message: null });

  // End-of-turn events reset regardless of shape.
  tracker.feed({ type: "message_start", message: { role: "assistant", content: [] } });
  tracker.feed({ type: "agent_settled", aborted: false });
  assert.deepEqual(tracker.snapshot(), { started: false, message: null });
});

test("non-assistant and non-streaming events leave the tracker alone", () => {
  const tracker = createStreamTracker();
  // A user echo does not start streaming.
  tracker.feed({ type: "message_start", message: { role: "user", content: [] } });
  assert.deepEqual(tracker.snapshot(), { started: false, message: null });
  // Updates without a partial (tool progress metadata) keep the last state.
  tracker.feed({ type: "message_start", message: { role: "assistant", content: [] } });
  tracker.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } });
  assert.deepEqual(tracker.snapshot().message, { role: "assistant", content: [] });
  // Garbage is ignored, never thrown.
  tracker.feed(null);
  tracker.feed("not-an-event");
  tracker.feed({ type: 42 });
  assert.equal(tracker.snapshot().started, true);
});

/** A pi-shaped assistant turn: text, then a tool call, as full events and as the slim bridge form. */
function turnEvents(): Array<{ full: unknown; slim: unknown }> {
  const events: unknown[] = [];
  const message = (content: unknown[]) => ({ role: "assistant", content });
  events.push({ type: "message_start", message: message([]) });
  const text = (value: string) => [{ type: "text", text: value }];
  events.push({ type: "message_update", message: message(text("")), assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: message(text("")) } });
  let accumulated = "";
  for (const chunk of ["Hel", "lo, ", "wor", "ld"]) {
    accumulated += chunk;
    events.push({ type: "message_update", message: message(text(accumulated)), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk, partial: message(text(accumulated)) } });
  }
  events.push({ type: "message_update", message: message(text(accumulated)), assistantMessageEvent: { type: "text_end", contentIndex: 0, content: accumulated, partial: message(text(accumulated)) } });
  const call = (args: Record<string, unknown>) => [{ type: "text", text: accumulated }, { type: "toolCall", id: "call-1", name: "bash", arguments: args }];
  events.push({ type: "message_update", message: message(call({})), assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "call-1", toolName: "bash", partial: message(call({})) } });
  events.push({ type: "message_update", message: message(call({})), assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"cmd":"ls"}', id: "call-1", toolName: "bash", partial: message(call({ cmd: "ls" })) } });
  events.push({ type: "message_update", message: message(call({ cmd: "ls" })), assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, partial: message(call({ cmd: "ls" })) } });
  events.push({ type: "message_end", message: message(call({ cmd: "ls" })) });
  return events.map((full) => ({ full, slim: slimBridgeEvent(full) }));
}

test("a text delta without its partial extends the in-flight text block", () => {
  const tracker = createStreamTracker();
  tracker.feed({ type: "message_start", message: { role: "assistant", content: [] } });
  tracker.feed({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: { role: "assistant", content: [{ type: "text", text: "" }] } } });
  tracker.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ab" } });
  tracker.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "c" } });
  assert.deepEqual(tracker.snapshot().message?.content, [{ type: "text", text: "abc" }]);
});

test("a thinking delta without its partial extends the in-flight thinking block", () => {
  const tracker = createStreamTracker();
  tracker.feed({ type: "message_start", message: { role: "assistant", content: [] } });
  tracker.feed({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: { role: "assistant", content: [{ type: "thinking", thinking: "" }] } } });
  tracker.feed({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hm" } });
  assert.deepEqual(tracker.snapshot().message?.content, [{ type: "thinking", thinking: "hm" }]);
});

test("a delta for a block that never started is ignored, not invented", () => {
  const tracker = createStreamTracker();
  tracker.feed({ type: "message_start", message: { role: "assistant", content: [] } });
  tracker.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 3, delta: "lost" } });
  assert.deepEqual(tracker.snapshot().message?.content, []);
});

test("tool-call arguments follow the accumulated JSON once it parses, and keep the last good value until then", () => {
  const tracker = createStreamTracker();
  tracker.feed({ type: "message_start", message: { role: "assistant", content: [] } });
  tracker.feed({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "bash", partial: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] } } });
  tracker.feed({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"cmd":' } });
  assert.deepEqual(tracker.snapshot().message?.content, [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }], "incomplete JSON does not replace the arguments");
  tracker.feed({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '"ls"}' } });
  assert.deepEqual(tracker.snapshot().message?.content, [{ type: "toolCall", id: "c1", name: "bash", arguments: { cmd: "ls" } }]);
});

test("a slim feed reproduces the full feed's snapshot at every event, for text and at block boundaries for tool calls", () => {
  const full = createStreamTracker();
  const slim = createStreamTracker();
  for (const { full: fullEvent, slim: slimEvent } of turnEvents()) {
    full.feed(fullEvent);
    slim.feed(slimEvent);
    const type = (fullEvent as { type: string }).type;
    const update = (fullEvent as { assistantMessageEvent?: { type: string } }).assistantMessageEvent?.type;
    // Tool-call argument text mid-stream is best-effort on the slim path; compare at every other event.
    if (update === "toolcall_delta") continue;
    assert.deepEqual(slim.snapshot(), full.snapshot(), `${type} ${update ?? ""}`);
  }
  assert.equal(slim.snapshot().started, false);
});
