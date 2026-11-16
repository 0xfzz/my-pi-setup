import test from "node:test";
import assert from "node:assert/strict";
import { BoundedSseEvents, encodedSseBytes, MAIN_SSE_LIMITS, sseAdmission } from "../lib/sse-pressure.ts";

test("SSE byte estimates count UTF-8 data, escaped newlines and retry fields", () => {
  const encoded = JSON.stringify({ text: "世界\nhello" });
  assert.equal(encodedSseBytes(encoded), Buffer.byteLength(`data: ${encoded}\n\n`));
  assert.equal(encodedSseBytes(encoded, 2000), Buffer.byteLength(`data: ${encoded}\nretry: 2000\n\n`));
});

test("staged SSE events bound UTF-8 bytes, coalesce by key and release accounting on removal", () => {
  const events = new BoundedSseEvents();
  const value = { text: "世界" };
  const bytes = Buffer.byteLength(JSON.stringify(value)) + 8;
  assert.equal(events.put("a", value, bytes), true);
  assert.equal(events.bytes, bytes);
  assert.equal(events.put("b", value, bytes), false);
  assert.equal(events.bytes, bytes, "rejected admission does not mutate the buffer");
  assert.equal(events.put("a", { text: "x" }, bytes), true);
  assert.ok(events.bytes < bytes);
  assert.deepEqual([...events.consume()], [{ text: "x" }]);
  assert.equal(events.bytes, 0);
  assert.equal(events.put("a", value, bytes), true);
  events.delete("a");
  events.delete("a");
  assert.equal(events.bytes, 0);
  events.put("a", value, bytes);
  events.clear();
  assert.deepEqual([...events.consume()], []);
  assert.equal(events.bytes, 0);
});

test("staged events cannot grow by producer mutation after byte admission", () => {
  const events = new BoundedSseEvents();
  const frame = { text: "small" };
  assert.equal(events.put("a", frame, 100), true);
  const bytes = events.bytes;
  frame.text = "large".repeat(1_000);
  assert.equal(events.bytes, bytes);
  assert.deepEqual([...events.consume()], [{ text: "small" }]);
});

test("invalid staged events are refused without unbounded retention", () => {
  const events = new BoundedSseEvents();
  const circular = { self: {} };
  circular.self = circular;
  for (const event of [undefined, circular, { value: 1n }]) assert.equal(events.put("a", event, 100), false);
  assert.equal(events.bytes, 0);
});

test("main stream budgets retain 512 KiB soft pressure and 16 MiB hard pressure", () => {
  assert.deepEqual(MAIN_SSE_LIMITS, { dropAboveBytes: 512 * 1024, closeAboveBytes: 16 * 1024 * 1024 });
});

test("SSE admission drops rebuildable frames only beyond the soft threshold", () => {
  const limits = { dropAboveBytes: 10, closeAboveBytes: 100 };
  assert.equal(sseAdmission({ bufferedBytes: 10, frameBytes: 1, droppable: true, limits }), "send");
  assert.equal(sseAdmission({ bufferedBytes: 11, frameBytes: 1, droppable: true, limits }), "drop");
  assert.equal(sseAdmission({ bufferedBytes: 11, frameBytes: 1, droppable: false, limits }), "send");
});

test("hard SSE pressure includes the incoming frame and cannot be bypassed by droppable traffic", () => {
  const limits = { dropAboveBytes: 10, closeAboveBytes: 100 };
  assert.equal(sseAdmission({ bufferedBytes: 99, frameBytes: 1, droppable: false, limits }), "send");
  for (const droppable of [false, true]) {
    assert.equal(sseAdmission({ bufferedBytes: 99, frameBytes: 2, droppable, limits }), "close");
    assert.equal(sseAdmission({ bufferedBytes: 0, frameBytes: 101, droppable, limits }), "close");
    assert.equal(sseAdmission({ bufferedBytes: 101, frameBytes: 0, droppable, limits }), "close");
  }
});
