import test from "node:test";
import assert from "node:assert/strict";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import modes from "../extensions/modes.ts";

// Regression: the editor slot is single-occupancy. `modes` used to replace
// whatever factory was installed, silently disabling pi-paster (inline images)
// and prompt-history. It must compose over the previous factory instead.
test("modes composes the previously installed editor instead of replacing it", async () => {
  let slot: any;
  const order: string[] = [];
  const hooks: Function[] = [];
  const pi: any = {
    on(n: string, f: Function) { if (n === "session_start") hooks.push(f); },
    events: { on() {}, emit() {} }, registerCommand() {}, registerTool() {},
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, appendEntry() {},
  };

  // Stand-in for pi-paster: claims the slot and marks its editor.
  class PasterEditor extends CustomEditor {
    pasterFeature = true;
    handleInput(data: string) { order.push("paster:" + data); super.handleInput(data); }
  }
  let pasterInstances = 0;
  slot = ((tui: any, theme: any, kb: any) => { pasterInstances++; return new PasterEditor(tui, theme, kb); }) as any;

  const ctx: any = {
    mode: "tui", hasUI: true, isIdle: () => true,
    sessionManager: { getBranch: () => [] },
    ui: {
      get theme() { return { fg: (_t: string, s: string) => s, bold: (s: string) => s }; },
      notify() {}, setWidget() {}, addAutocompleteProvider() {},
      getEditorComponent: () => slot,
      setEditorComponent: (f: any) => { slot = f; },
    },
  };

  modes(pi);
  for (const h of hooks) await h({ type: "session_start" }, ctx);

  const fakeTui: any = { terminal: { columns: 100, rows: 40 }, requestRender() {}, mode: "fullscreen" };
  const theme: any = { fg: (_t: string, s: string) => s, bold: (s: string) => s };
  let shiftTab = false;
  const kb: any = { matches: (key: string) => shiftTab && key === "shift+tab", getKeys: () => [], getDisplayText: () => "", keybindings: {} };
  const editor: any = slot(fakeTui, theme, kb);

  assert.equal(pasterInstances, 1, "paster factory must still be invoked");
  assert.equal(editor.pasterFeature, true, "paster editor features must survive");

  // The base editor still receives ordinary keys.
  order.length = 0;
  editor.handleInput("x");
  assert.ok(order.includes("paster:x"), "base editor handleInput must still run");

  // Shift+Tab is claimed by `modes` and must not reach the base editor,
  // preserving the original shortcut behaviour.
  shiftTab = true;
  order.length = 0;
  editor.handleInput("\x1b[Z");
  assert.equal(order.includes("paster:\x1b[Z]"), false, "Shift+Tab must be consumed by modes");
});
