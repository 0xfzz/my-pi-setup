import test from "node:test";
import assert from "node:assert/strict";
import { createStreamTracker } from "./stream-tracker.ts";

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
