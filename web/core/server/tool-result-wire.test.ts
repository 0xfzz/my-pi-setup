import test from "node:test";
import assert from "node:assert/strict";
import { HISTORY_RESULT_TEXT_LIMIT, toWireToolResult, toWireToolResults } from "./tool-result-wire.ts";

test("text and diff are capped at the transcript's preview limit", () => {
  const long = "x".repeat(HISTORY_RESULT_TEXT_LIMIT + 500);
  const wire = toWireToolResult({ text: long, isError: false, diff: long });
  assert.equal(wire.text.length, HISTORY_RESULT_TEXT_LIMIT);
  assert.equal(wire.diff?.length, HISTORY_RESULT_TEXT_LIMIT);
});

test("short text passes through unchanged, and absent diffs stay absent", () => {
  const wire = toWireToolResult({ text: "ok", isError: true });
  assert.deepEqual(wire, { text: "ok", isError: true });
});

test("images are dropped from the wire but flagged, so the client knows to fetch them", () => {
  const wire = toWireToolResult({ text: "", isError: false, images: [{ data: "AAAA", mimeType: "image/png" }] });
  assert.equal(wire.hasImages, true);
  assert.equal("images" in wire, false);
});

test("an empty images list is not flagged", () => {
  const wire = toWireToolResult({ text: "", isError: false, images: [] });
  assert.equal("hasImages" in wire, false);
});

test("every result in a map is converted", () => {
  const wire = toWireToolResults({
    a: { text: "one", isError: false },
    b: { text: "two", isError: true, images: [{ data: "B", mimeType: "image/png" }] },
  });
  assert.deepEqual(Object.keys(wire).sort(), ["a", "b"]);
  assert.equal(wire.b.hasImages, true);
});
