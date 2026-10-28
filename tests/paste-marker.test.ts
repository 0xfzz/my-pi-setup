import assert from "node:assert/strict";
import { test } from "node:test";
import { paintPasteMarkers, pasteMarkerSpans } from "../lib/paste-marker.ts";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

const wrap = (text: string) => `[[${text}]]`;

test("both marker shapes are found, including the line/char variants", () => {
  const spans = pasteMarkerSpans("[paste #1 +40 lines] and [paste #2 1234 chars] and [#image 3]");
  assert.equal(spans.length, 3);
  assert.deepEqual(stripTerminalSequences(wrap("x")).length, 5);
});

test("only markers are painted; the rest of the line is untouched", () => {
  const painted = paintPasteMarkers(["ab [paste #1 +40 lines] cd"], wrap);
  assert.deepEqual(painted, ["ab [[[paste #1 +40 lines]]] cd"]);
});

test("a line without markers comes back byte-identical", () => {
  const line = "plain prompt text with no chips";
  assert.equal(paintPasteMarkers([line], wrap)[0], line);
});

test("painting preserves existing ANSI styling around the marker", () => {
  const line = "\x1b[31mred \x1b[0m[paste #4 +2 lines]\x1b[32mgreen\x1b[0m";
  const [painted] = paintPasteMarkers([line], wrap);
  assert.ok(painted!.includes("\x1b[31m"), "the red segment keeps its escape");
  assert.ok(painted!.includes("\x1b[32m"), "the green segment keeps its escape");
  assert.equal(stripTerminalSequences(painted!), "red [[[paste #4 +2 lines]]]green");
});

test("visible width is unchanged, so the editor layout does not shift", () => {
  const line = "x [paste #7 99 chars] y";
  const [painted] = paintPasteMarkers([line], text => `\x1b[48;5;236m${text}\x1b[0m`);
  assert.equal(stripTerminalSequences(painted!), stripTerminalSequences(line));
});

test("several markers on one line are each painted", () => {
  const [painted] = paintPasteMarkers(["[paste #1 +2 lines] [paste #2 +3 lines]"], wrap);
  assert.equal(stripTerminalSequences(painted!), "[[[paste #1 +2 lines]]] [[[paste #2 +3 lines]]]");
});
