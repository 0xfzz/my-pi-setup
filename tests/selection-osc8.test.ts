import assert from "node:assert/strict";
import { test } from "node:test";
import { plainText, repairOsc8Wrapping, resolveHyperlinkAt, scanOsc8 } from "../lib/selection/osc8.ts";

const OPEN = (url: string) => `\x1b]8;;${url}\x1b\\`;
const CLOSE = "\x1b]8;;\x1b\\";

test("scanOsc8 reports visible spans and strips the escape sequence", () => {
  const line = `${OPEN("https://example.com/a")}click here${CLOSE}`;
  const scan = scanOsc8(line);
  assert.equal(scan.text, "click here");
  assert.deepEqual(scan.spans, [{ url: "https://example.com/a", start: 0, end: 10 }]);
  assert.equal(plainText(line), "click here");
});

test("resolveHyperlinkAt carries an open URL across a wrapped line", () => {
  const lines = [
    `${OPEN("https://example.com/very/long/path")}https://example.com/very`,
    `long/path${CLOSE}`,
  ];
  assert.equal(resolveHyperlinkAt(lines, 0, 2), "https://example.com/very/long/path");
  assert.equal(resolveHyperlinkAt(lines, 1, 2), "https://example.com/very/long/path");
  assert.equal(resolveHyperlinkAt(lines, 1, 50), undefined);
});

test("a closed link does not leak into the next line", () => {
  const lines = [`${OPEN("https://a.example")}a${CLOSE}`, "plain text"];
  assert.equal(resolveHyperlinkAt(lines, 0, 0), "https://a.example");
  assert.equal(resolveHyperlinkAt(lines, 1, 0), undefined);
});

test("repairOsc8Wrapping reopens the link on continuation lines", () => {
  const lines = [
    `${OPEN("https://example.com/x")}start `,
    "end",
  ];
  const repaired = repairOsc8Wrapping(lines);
  // OSC 8 bytes are the subject under test.
  // oxlint-disable-next-line no-control-regex
  assert.match(repaired[0]!, /\x1b\]8;;https:\/\/example.com\/x/);
  // oxlint-disable-next-line no-control-regex
  assert.match(repaired[1]!, /^\x1b\]8;;https:\/\/example\.com\/x/);
  assert.equal(plainText(repaired[1]!), "end");
  // One open and one close are present on the continuation line.
  // oxlint-disable-next-line no-control-regex
  assert.equal((repaired[1]!.match(/\x1b\]8;;/g) ?? []).length, 2);
});

test("repairOsc8Wrapping leaves non-link lines unchanged", () => {
  const lines = ["plain", "text"];
  assert.deepEqual(repairOsc8Wrapping(lines), lines);
});
