import assert from "node:assert/strict";
import { test } from "node:test";
import { blockSelectionAt, extractBlockText } from "../lib/selection/blocks.ts";

const OPEN = (url: string) => `\x1b]8;;${url}\x1b\\`;
const CLOSE = "\x1b]8;;\x1b\\";

test("triple-click selects one table cell across its wrapped lines", () => {
  const lines = [
    "┌─────┬─────┐",
    "│ one │ two │",
    "│ 1a  │ 2a  │",
    "├─────┼─────┤",
    "│ red │ blue│",
    "└─────┴─────┘",
  ];
  const selected = blockSelectionAt(lines, 2, 2);
  assert.equal(selected?.kind, "table-cell");
  assert.deepEqual(selected?.columns, { start: 2, end: 5 });
  assert.equal(extractBlockText(lines, selected!), "one\n1a");
});

test("triple-click on a table border selects the whole row", () => {
  const lines = [
    "┌─────┬─────┐",
    "│ one │ two │",
    "├─────┼─────┤",
    "│ red │ blue│",
    "└─────┴─────┘",
  ];
  const selected = blockSelectionAt(lines, 2, 0);
  assert.equal(selected?.kind, "table-row");
  const text = extractBlockText(lines, selected!);
  assert.match(text, /one/);
  assert.match(text, /two/);
});

test("triple-click in a quote copies only quote text", () => {
  const lines = ["│ first line", "│ second line", "", "outside"];
  const selected = blockSelectionAt(lines, 0, 3);
  assert.equal(selected?.kind, "quote");
  assert.equal(extractBlockText(lines, selected!), "first line\nsecond line");
});

test("triple-click inside a fenced code block excludes the fences", () => {
  const lines = ["```ts", "const answer = 42;", "```"];
  const selected = blockSelectionAt(lines, 0, 0);
  assert.equal(selected?.kind, "code-block");
  assert.equal(extractBlockText(lines, selected!), "const answer = 42;");
});

test("triple-click in a list item includes wrapped continuation lines", () => {
  const lines = ["- first item", "  continuation", "- second item"];
  const selected = blockSelectionAt(lines, 1, 3);
  assert.equal(selected?.kind, "list-item");
  assert.equal(extractBlockText(lines, selected!), "- first item\n  continuation");
});

test("triple-click in a paragraph stops at a blank line", () => {
  const lines = ["alpha", "beta", "", "gamma"];
  const selected = blockSelectionAt(lines, 1, 1);
  assert.equal(selected?.kind, "paragraph");
  assert.equal(extractBlockText(lines, selected!), "alpha\nbeta");
});

test("double-click on a wrapped link selects the link across lines", () => {
  const lines = [
    `${OPEN("https://example.com/very/long")}https://example.com/very`,
    `long${CLOSE} tail`,
  ];
  const selected = blockSelectionAt(lines, 1, 1, 2);
  assert.equal(selected?.kind, "link");
  assert.equal(selected?.linkUrl, "https://example.com/very/long");
  const text = extractBlockText(lines, selected!);
  assert.match(text, /https:\/\/example\.com\/very/);
  assert.match(text, /long/);
});

test("unknown content falls back to a physical line", () => {
  const lines = ["  ", "  "];
  const selected = blockSelectionAt(lines, 0, 0);
  assert.equal(selected?.kind, "line");
});
