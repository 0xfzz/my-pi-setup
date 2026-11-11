import test from "node:test";
import assert from "node:assert/strict";
import { sseFrameData, takeSseFrames } from "../lib/web-sse.ts";

test("takeSseFrames splits complete frames and keeps the partial frame as remainder", () => {
  const { frames, remainder } = takeSseFrames('data: {"a":1}\n\ndata: {"b":');
  assert.deepEqual(frames, ['data: {"a":1}']);
  assert.equal(remainder, 'data: {"b":');
});

test("takeSseFrames returns no frames when no terminator has arrived yet", () => {
  const { frames, remainder } = takeSseFrames("data: partial");
  assert.deepEqual(frames, []);
  assert.equal(remainder, "data: partial");
});

test("takeSseFrames drains every framed message in order, leaving the tail", () => {
  const { frames, remainder } = takeSseFrames(":hb\n\ndata: one\n\ndata: two\n\ndata: thr");
  assert.deepEqual(frames, [":hb", "data: one", "data: two"]);
  assert.equal(remainder, "data: thr");
});

test("takeSseFrames feeds forward: remainder plus the next chunk complete the frame", () => {
  const first = takeSseFrames('data: {"x"');
  const second = takeSseFrames(first.remainder + ":1}\n\ndata: next\n\n");
  assert.deepEqual(second.frames, ['data: {"x":1}', "data: next"]);
  assert.equal(second.remainder, "");
});

test("sseFrameData strips the optional space after the data: prefix", () => {
  assert.equal(sseFrameData("data: {\"ok\":true}"), '{"ok":true}');
  assert.equal(sseFrameData("data:{\"ok\":true}"), '{"ok":true}');
});

test("sseFrameData joins multi-line data payloads with newlines", () => {
  assert.equal(sseFrameData("data: line one\ndata: line two"), "line one\nline two");
});

test("sseFrameData returns an empty string for heartbeats and comments", () => {
  assert.equal(sseFrameData(":hb"), "");
  assert.equal(sseFrameData(""), "");
});