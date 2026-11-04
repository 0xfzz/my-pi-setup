import assert from "node:assert/strict";
import test from "node:test";

import { overlayRows, popupOverlayOptions } from "../lib/popup/frame.ts";
import { PopupList } from "../lib/ui/shell.ts";

test("a list sized by overlayRows fits the capped overlay and keeps the selection visible", () => {
  const items = Array.from({ length: 60 }, (_, i) => `a${i}`);
  for (const terminal of [24, 40, 60]) {
    const list = new PopupList<string>({
      items,
      terminalRows: () => overlayRows(terminal, 80),
      renderItem: (item, { selected }) => `${selected ? "→" : " "} ${item}`,
      onSelect() {},
      onCancel() {},
    });
    for (let i = 0; i < 30; i++) list.handleInput("\x1b[B");
    const frame = list.render(100);
    const cap = Math.floor(terminal * 0.8);
    assert.ok(frame.length <= cap, `terminal ${terminal}: ${frame.length} rows exceed the ${cap}-row overlay cap`);
    assert.ok(frame.some(row => row.includes("→ a30")), "selected row is visible");
  }
  assert.equal(popupOverlayOptions("84%", 50, "80%").maxHeight, "80%");
});
