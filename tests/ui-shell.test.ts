import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { PopupList, PopupShell } from "../lib/ui/shell.ts";
import { PLAIN_THEME } from "../lib/popup/frame.ts";

const plain = (lines: string[]) => lines.map(line => stripTerminalSequences(line));

test("PopupShell keeps the header and footer sticky while the body scrolls", () => {
  const body = Array.from({ length: 40 }, (_, index) => `row ${index}`);
  const shell = new PopupShell({
    theme: PLAIN_THEME,
    title: "Detail",
    hint: "Esc close",
    terminalRows: () => 16,
    model: () => ({ header: ["HEADER"], body, footer: ["FOOTER"] }),
  });

  const first = plain(shell.render(80));
  assert.match(first[0]!, /Detail/);
  assert.match(first.join("\n"), /HEADER/);
  assert.match(first.join("\n"), /FOOTER/);
  assert.match(first.join("\n"), /row 0/);
  assert.doesNotMatch(first.join("\n"), /row 39/);

  for (let i = 0; i < 40; i++) shell.handleInput("\x1b[B");
  const later = plain(shell.render(80)).join("\n");
  assert.match(later, /HEADER/);
  assert.match(later, /FOOTER/);
  assert.match(later, /row 39/);
});

test("PopupShell never renders taller than the terminal and never exceeds width", () => {
  const body = Array.from({ length: 40 }, (_, index) => `line ${index} `.repeat(4));
  const shell = new PopupShell({
    theme: PLAIN_THEME,
    terminalRows: () => 12,
    model: () => ({ body }),
  });
  const lines = shell.render(40);
  assert.ok(lines.length <= 12, `rendered ${lines.length} rows`);
  for (const line of lines) {
    assert.ok(visibleWidth(stripTerminalSequences(line)) <= 40);
  }
});

test("PopupShell falls back to horizontal rules on narrow terminals", () => {
  const shell = new PopupShell({
    theme: PLAIN_THEME,
    model: () => ({ body: ["narrow"] }),
  });
  const lines = shell.render(20);
  assert.equal(stripTerminalSequences(lines[0]!).trim(), "─".repeat(20));
  assert.match(stripTerminalSequences(lines[1]!), /narrow/);
});

test("PopupList virtualizes a long list, reveals selection, and selects with Enter", () => {
  const items = Array.from({ length: 100 }, (_, index) => `item ${index}`);
  let chosen: string | undefined;
  const list = new PopupList<string>({
    theme: PLAIN_THEME,
    title: "Pick",
    items,
    terminalRows: () => 14,
    renderItem: (item, { selected }) => `${selected ? "→ " : "  "}${item}`,
    onSelect: (item) => { chosen = item; },
    onCancel: () => {},
  });

  const first = plain(list.render(60)).join("\n");
  assert.match(first, /item 0/);
  assert.doesNotMatch(first, /item 99/);

  for (let i = 0; i < 20; i++) list.handleInput("\x1b[B");
  const later = plain(list.render(60)).join("\n");
  assert.match(later, /→ item 20/);
  assert.doesNotMatch(later, /→ item 0\b/);

  list.handleInput("g");
  list.handleInput("\r");
  assert.equal(chosen, "item 0");
});

test("PopupList supports digits, click, and cancellation", () => {
  const items = ["a", "b", "c"];
  let chosen: string | undefined;
  let cancelled = false;
  const list = new PopupList<string>({
    theme: PLAIN_THEME,
    title: "Pick",
    items,
    numbered: true,
    clickActivates: true,
    renderItem: (item) => item,
    onSelect: (item) => { chosen = item; },
    onCancel: () => { cancelled = true; },
  });

  list.render(60);
  list.handleInput("3");
  assert.equal(chosen, "c");

  list.handleInput("\x1b");
  assert.equal(cancelled, true);

  list.render(60);
  const clicked = list.handleMouse({ type: "click", x: 0, y: 2, button: 0 } as any);
  assert.equal(clicked?.handled, true);
  assert.equal(chosen, "a");
});
