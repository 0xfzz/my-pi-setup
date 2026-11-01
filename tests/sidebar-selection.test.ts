import test from "node:test";
import assert from "node:assert/strict";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { SelectionBoundaryController } from "../lib/sidebar/sidebar-selection.ts";

function createMockTui(columns = 120, rows = 34) {
  const terminal = {
    columns,
    rows,
    write() {},
    start() {},
    stop() {},
    hideCursor() {},
    showCursor() {},
  };
  return new TuiAltScreen(terminal as any);
}

test("resolveRegion categorizes sidebar, conversation, and prompt regions accurately", () => {
  const tui = createMockTui(120, 34);
  const controller = new SelectionBoundaryController(tui as any, {
    enabled: () => true,
    width: () => 24,
  });

  // sideX = 120 - 24 = 96
  // dockY default fallback = 34 - 5 = 29
  const side = controller.resolveRegion(100, 10);
  assert.equal(side.type, "sidebar");
  assert.equal(side.minX, 96);
  assert.equal(side.maxX, 119);
  assert.equal(side.minY, 0);
  assert.equal(side.maxY, 33);

  const convo = controller.resolveRegion(50, 10);
  assert.equal(convo.type, "conversation");
  assert.equal(convo.minX, 0);
  assert.equal(convo.maxX, 95);
  assert.equal(convo.minY, 0);
  assert.equal(convo.maxY, 28);

  const prompt = controller.resolveRegion(50, 31);
  assert.equal(prompt.type, "prompt");
  assert.equal(prompt.minX, 0);
  assert.equal(prompt.maxX, 95);
  assert.equal(prompt.minY, 29);
  assert.equal(prompt.maxY, 33);
});

test("mouse drag coordinates are strictly clamped to origin container", () => {
  const tui = createMockTui(120, 34);
  const controller = new SelectionBoundaryController(tui as any, {
    enabled: () => true,
    width: () => 24,
  });

  const dispose = controller.install();

  // 1. Sidebar selection: press at x=105, y=10, then drag into conversation at x=20, y=10
  (tui as any).handleSelectionMouseEvent({ x: 105, y: 10, button: 0 });
  assert.equal(controller.getActiveRegion()?.type, "sidebar");

  (tui as any).handleSelectionMouseEvent({ x: 20, y: 10, button: 32 }); // Drag left into conversation
  const sidebarFocus = Reflect.get(tui, "selectionFocus");
  assert.ok(sidebarFocus);
  assert.equal(sidebarFocus.col, 96, "Sidebar drag was clamped to minX=96");

  // Release
  (tui as any).handleSelectionMouseEvent({ x: 20, y: 10, button: 0, release: true });

  // 2. Prompt selection: press at x=40, y=31, then drag up into convo at y=5 and right into sidebar at x=110
  (tui as any).handleSelectionMouseEvent({ x: 40, y: 31, button: 0 });
  assert.equal(controller.getActiveRegion()?.type, "prompt");

  (tui as any).handleSelectionMouseEvent({ x: 110, y: 5, button: 32 }); // Drag into conversation and sidebar
  const promptFocus = Reflect.get(tui, "selectionFocus");
  assert.ok(promptFocus);
  assert.equal(promptFocus.col, 95, "Prompt drag x was clamped to maxX=95");
  assert.equal(promptFocus.row, 29, "Prompt drag y was clamped to minY=29");

  // Release
  (tui as any).handleSelectionMouseEvent({ x: 110, y: 5, button: 0, release: true });

  dispose();
});

test("applySelection isolates visual inverse highlight to container bounds", () => {
  const tui = createMockTui(120, 10);
  const controller = new SelectionBoundaryController(tui as any, {
    enabled: () => true,
    width: () => 24, // sideX = 96
  });
  const dispose = controller.install();

  const screenLines = [
    "Line 0: Conversation message 0                                                 │ Sidebar Section 1",
    "Line 1: Conversation message 1                                                 │ Sidebar Section 2",
    "Line 2: Conversation message 2                                                 │ Sidebar Section 3",
    "Line 3: Conversation message 3                                                 │ Sidebar Section 4",
    "Line 4: Conversation message 4                                                 │ Sidebar Section 5",
    "Line 5: Conversation message 5                                                 │ Sidebar Section 6",
    "Line 6: Conversation message 6                                                 │ Sidebar Section 7",
    "Line 7: Prompt input text box                                                  │ Sidebar Section 8",
    "Line 8: Prompt input second line                                               │ Sidebar Section 9",
    "Line 9: Prompt footer                                                          │ Sidebar Section 10",
  ];
  Reflect.set(tui, "previousScreen", screenLines);

  // 1. Simulate selection in sidebar (press at x=105, y=1)
  (tui as any).handleSelectionMouseEvent({ x: 105, y: 1, button: 0 });
  (tui as any).handleSelectionMouseEvent({ x: 110, y: 3, button: 32 });

  const sidebarHighlighted = (tui as any).applySelection(screenLines);
  // Row 2 is fully between rows 1 and 3. Without isolation, row 2 starts highlighting at col 0.
  // With isolation, the left conversation part (cols 0-95) must NOT contain inverse highlight!
  const leftPart = sidebarHighlighted[2].slice(0, 80);
  assert.equal(leftPart.includes("\x1b[7m"), false, "Conversation part on row 2 is not highlighted by sidebar selection");
  // The right sidebar part (col >= 96) SHOULD contain highlight
  const rightPart = sidebarHighlighted[2].slice(96);
  assert.equal(rightPart.includes("\x1b[7m"), true, "Sidebar part on row 2 is highlighted");

  dispose();
});

test("triple-click installs a semantic table-cell range and copies only that cell", () => {
  const tui = createMockTui(120, 24);
  const controller = new SelectionBoundaryController(tui as any, {
    enabled: () => true,
    width: () => 24,
  });
  const dispose = controller.install();
  Reflect.set(tui, "previousScreen", [
    "┌─────┬─────┐",
    "│ one │ two │",
    "│ 1a  │ 2a  │",
    "├─────┼─────┤",
    "│ red │ blue│",
    "└─────┴─────┘",
  ]);

  for (let i = 0; i < 3; i++) {
    (tui as any).handleSelectionMouseEvent({ x: 2, y: 2, button: 0 });
    (tui as any).handleSelectionMouseEvent({ x: 2, y: 2, button: 0, release: true });
  }

  assert.equal((tui as any).getActiveSelectionText(), "one\n1a");
  dispose();
});

test("clicking a wrapped OSC 8 link resolves the URL from the continuation line", () => {
  const tui = createMockTui(120, 24);
  const controller = new SelectionBoundaryController(tui as any, {
    enabled: () => true,
    width: () => 24,
  });
  const dispose = controller.install();
  const open = "\x1b]8;;https://example.com/very/long\x1b\\";
  const close = "\x1b]8;;\x1b\\";
  Reflect.set(tui, "previousScreen", [
    `${open}https://example.com/very`,
    `long${close} tail`,
  ]);

  (tui as any).handleSelectionMouseEvent({ x: 1, y: 1, button: 0 });
  assert.equal(Reflect.get(tui, "pressedUrl"), "https://example.com/very/long");
  dispose();
});
