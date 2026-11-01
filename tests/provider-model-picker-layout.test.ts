import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { InteractiveMode, initTheme, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  Container, CURSOR_MARKER, Text, TuiAltScreen, TuiMainScreen, sliceByColumn, visibleWidth,
  type Component, type Terminal,
} from "@earendil-works/pi-tui";
import { ProviderModelPicker, providerModelPicker, type ModelSelection } from "../lib/provider/provider-model-picker.ts";

// Exercise the installed host's native transcript/input-dock allocation, not a
// simulated height subtraction. This helper is internal (not a package export).
const { createChatViewport } = await import(new URL(
  "./modes/interactive/chat-viewport.js", import.meta.resolve("@earendil-works/pi-coding-agent"),
).href);
initTheme("dark", false);

type Custom = ExtensionCommandContext["ui"]["custom"];
type CustomOptions = Parameters<Custom>[1];
type Screen = TuiMainScreen | TuiAltScreen;
type Mode = "regular" | "fullscreen";
type OverlayLayout = { row: number; col: number; width: number; height: number; entry: { component: Component } };
const showCustom = Reflect.get(InteractiveMode.prototype, "showExtensionCustom") as Custom;
// 121 choices permits exact full-page landings at both normal and short
// heights without requiring PageDown to clamp instead of SelectList's wrapping.
const catalog = Array.from({ length: 121 }, (_, i) => ({ id: `model-${String(i).padStart(3, "0")}` }));
const keys = { up: "\x1b[A", down: "\x1b[B", pageUp: "\x1b[5~", pageDown: "\x1b[6~", enter: "\r", escape: "\x1b" };
const plain = (line: string) => stripVTControlCharacters(line
  // oxlint-disable-next-line no-control-regex
  .replaceAll(CURSOR_MARKER, "").replace(/\x1b_pi:\/?fc\x07/g, ""));
const highlight = (lines: string[]) => lines.map(plain).join("\n").match(/→ \[[ x]\] (model-\d+)/)?.[1];

class FakeTerminal implements Terminal {
  columns = 120;
  rows: number;
  kittyProtocolActive = false;
  writes: string[] = [];
  onInput?: (data: string) => void;
  onResize?: () => void;
  constructor(rows: number) { this.rows = rows; }
  start(onInput: (data: string) => void, onResize: () => void) { this.onInput = onInput; this.onResize = onResize; }
  stop() { this.onInput = undefined; this.onResize = undefined; }
  async drainInput() {}
  write(data: string) { this.writes.push(data); }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
  input(data: string) { assert.ok(this.onInput, "screen must be started"); this.onInput(data); }
  resize(rows: number, columns = this.columns) { this.rows = rows; this.columns = columns; this.onResize?.(); }
}

function fixture(mode: Mode, rows = 24) {
  const terminal = new FakeTerminal(rows);
  const tui: Screen = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
  const backgroundInputs: string[] = [];
  let draft = "unsent background draft";
  const editor = {
    focused: false,
    getText: () => draft,
    setText: (text: string) => { draft = text; },
    handleInput: (data: string) => { backgroundInputs.push(data); draft += data; },
    render: () => ["background editor border", draft, "background editor border"],
    invalidate() {},
  };
  const editorContainer = new Container();
  editorContainer.addChild(editor);
  const document = new Text(Array.from({ length: 100 }, (_, i) => `background transcript ${i}`).join("\n"), 0, 0);
  const above = new Text(Array(8).fill("persistent above-editor widget").join("\n"), 0, 0);
  const below = new Text(Array(8).fill("persistent below-editor widget").join("\n"), 0, 0);
  const footer = new Text("persistent footer\nprovider status", 0, 0);
  const empty = new Container();
  const viewport = createChatViewport({ document, pendingMessages: empty, status: empty,
    widgetsAbove: above, editor: editorContainer, widgetsBelow: below, footer, scrollbar: "never" });
  for (const child of [document, above, editorContainer, below, footer]) tui.addChild(child);
  if (tui instanceof TuiAltScreen) tui.setLayoutRoot(viewport.root);
  tui.setFocus(editor);
  tui.start();
  tui.renderNow();
  // showExtensionCustom only needs these fields on the real InteractiveMode host.
  const host = { ui: tui, editor, editorContainer, keybindings: {}, disposeActiveSelector() {} };
  let picker: ProviderModelPicker | undefined;
  let options: CustomOptions;
  let result: Promise<ModelSelection> | undefined;
  const custom: Custom = <T>(factory: Parameters<typeof showCustom<T>>[0], opts?: CustomOptions): Promise<T> => {
    options = opts;
    return showCustom.call(host, (...args) => {
      const component = factory(...args);
      assert.ok(component instanceof ProviderModelPicker, "public helper creates the real picker");
      picker = component;
      return component;
    }, opts) as Promise<T>;
  };
  const ctx = { mode: "tui", ui: { custom } } as unknown as ExtensionCommandContext;
  const frame = () => {
    tui.renderNow();
    // Use real post-compositing renderer state, not component.render() as a proxy
    // for visibility. Main-screen earlier lines belong to terminal scrollback.
    return tui instanceof TuiAltScreen ? tui.getScreenLines() : tui.captureRenderState().previousLines.slice(-terminal.rows);
  };
  return {
    terminal, tui, editor, editorContainer, backgroundInputs, viewport,
    get picker() { assert.ok(picker); return picker; },
    get options() { return options; },
    get result() { assert.ok(result); return result; },
    frame,
    layouts: () => Reflect.get(tui, "renderedOverlayLayouts") as OverlayLayout[],
    async open(legacyInline = false) {
      result = legacyInline
        ? custom((_tui, _theme, _kb, done) => new ProviderModelPicker(catalog, done, () => tui.requestRender(), () => terminal.rows))
        : providerModelPicker(ctx, catalog);
      // showExtensionCustom mounts its synchronous factory in Promise.then().
      // A microtask turn is sufficient; no sleeps or polling for mounted state.
      await Promise.resolve();
      frame();
    },
    input(data: string) { terminal.input(data); return frame(); },
    resize(rows: number, columns = terminal.columns) { terminal.resize(rows, columns); return frame(); },
    stop() { tui.stop({ preserveScreen: true }); },
  };
}

type Fixture = ReturnType<typeof fixture>;
function assertFits(h: Fixture) {
  const screen = h.frame();
  const layouts = h.layouts();
  assert.equal(layouts.length, 1, "picker is composited as one overlay");
  const bounds = layouts[0];
  assert.equal(bounds.entry.component, h.picker);
  assert.ok(bounds.row >= 0 && bounds.col >= 0);
  assert.ok(bounds.row + bounds.height <= h.terminal.rows, "overlay stays above the terminal bottom");
  assert.ok(bounds.col + bounds.width <= h.terminal.columns, "overlay stays inside terminal columns");
  assert.equal(bounds.row, Math.floor((h.terminal.rows - bounds.height) / 2), "overlay is vertically centered");
  assert.equal(bounds.col, Math.floor((h.terminal.columns - bounds.width) / 2), "overlay is horizontally centered");
  assert.equal(h.tui.getFocusedComponent(), h.picker, "overlay owns real keyboard focus");
  assert.equal(h.picker.focused, true, "focus propagates into search Input");
  const raw = h.picker.render(bounds.width);
  assert.ok(raw.length <= h.terminal.rows, "picker budgets its own height, rather than relying on overlay clipping");
  assert.equal(bounds.height, raw.length, "maxHeight must not silently truncate picker rows");
  assert.ok(raw.every(line => visibleWidth(line) <= bounds.width));
  assert.ok(screen.length <= h.terminal.rows);
  const overlay = screen.slice(bounds.row, bounds.row + bounds.height)
    .map(line => plain(sliceByColumn(line, bounds.col, bounds.col + bounds.width)).trimEnd());
  assert.deepEqual(overlay, raw.map(line => plain(line).trimEnd()), "all picker rows survive real host composition");
  assert.match(overlay.join("\n"), /Search:/, "search remains visible even on tiny terminals");
  assert.ok(highlight(overlay), "highlighted model is visible, not below the viewport");
  assert.match(overlay.join("\n"), /\d+\/121/, "large-catalog position indicator is visible");
  assert.match(overlay.join("\n"), /Enter.*Esc/, "confirmation/cancel help survives even at four rows");
  if (h.terminal.rows >= 8) {
    assert.match(overlay.join("\n"), /PgUp\/PgDn/, "navigation help is visible when space permits");
    assert.match(overlay.join("\n"), /Enter .*Esc/, "confirmation/cancel help is visible when space permits");
  }
  return overlay;
}

for (const mode of ["regular", "fullscreen"] as const) {
  test(`native ${mode} inline custom UI reproduces clipping with persistent widgets/footer`, async t => {
    const h = fixture(mode, 12);
    t.after(() => h.stop());
    await h.open(true);
    assert.equal(h.layouts().length, 0);
    assert.equal(h.editorContainer.children[0], h.picker, "legacy custom UI only replaces the editor");
    h.input(keys.up); // SelectList wraps directly to the final model.
    const raw = h.picker.render(h.terminal.columns).map(plain).join("\n");
    const displayed = h.frame().map(plain).join("\n");
    assert.match(raw, /→ \[ \] model-120/, "picker itself has the final model highlighted");
    assert.ok(!displayed.includes("Search:") || !displayed.includes("→ [ ] model-120"),
      "native inline allocation loses search or highlighted model despite bounded standalone output");
    h.input(keys.escape);
    assert.equal(await h.result, undefined);
  });

  for (const rows of [24, 12, 8, 4]) {
    test(`public picker is a focused, unclipped overlay at ${rows} rows in ${mode}`, async t => {
      const h = fixture(mode, rows);
      t.after(() => h.stop());
      await h.open();
      assert.equal(h.options?.overlay, true, "public helper opts out of editor-dock allocation");
      const overlayOptions = h.options?.overlayOptions;
      assert.equal(typeof overlayOptions, "object");
      assert.deepEqual(overlayOptions, { width: "90%", maxHeight: "100%", margin: 0, anchor: "center" });
      assert.deepEqual(h.editorContainer.children, [h.editor], "overlay does not replace background editor");
      assertFits(h);
      h.input(keys.up);
      assert.equal(highlight(assertFits(h)), "model-120");
      h.input(keys.escape);
      assert.equal(await h.result, undefined);
      assert.equal(h.tui.getFocusedComponent(), h.editor, "dismissal restores background focus");
      assert.equal(h.editor.getText(), "unsent background draft");
      assert.deepEqual(h.backgroundInputs, []);
      h.frame();
      assert.equal(h.tui.hasOverlayEntries, false, "dismissal removes the actual overlay entry");
    });
  }

  for (const rows of [24, 12, 8, 4]) test(`many-model keyboard paging reaches final visible model at ${rows} rows without touching ${mode} background`, async t => {
    const h = fixture(mode, rows);
    t.after(() => h.stop());
    await h.open();
    const scrollTop = h.viewport.transcript.scrollTop;
    h.input("\x1b[200~model-\x1b[201~");
    let reachedEnd = false;
    for (let page = 0; page <= catalog.length; page++) {
      const lines = assertFits(h);
      assert.match(lines.join("\n"), /Search: model-/, "paging does not edit the search");
      assert.equal(h.viewport.transcript.scrollTop, scrollTop, "paging never scrolls background");
      if (highlight(lines) === "model-120") { reachedEnd = true; break; }
      h.input(keys.pageDown);
    }
    assert.ok(reachedEnd, "bounded keyboard paging reaches the last model");
    h.input(keys.pageUp);
    assert.notEqual(highlight(assertFits(h)), "model-120", "PageUp navigates within picker");
    h.input(keys.down);
    assert.ok(highlight(assertFits(h)));
    assert.equal(h.viewport.transcript.scrollTop, scrollTop);
    assert.deepEqual(h.backgroundInputs, []);
    assert.equal(h.editor.getText(), "unsent background draft");
    h.input(keys.escape);
    await h.result;
  });

  test(`native ${mode} resize keeps selected/highlighted model visible at 24/12/8/4 rows`, async t => {
    const h = fixture(mode);
    t.after(() => h.stop());
    await h.open();
    h.input(keys.up);
    h.input(" ");
    for (const [rows, columns] of [[12, 100], [8, 80], [4, 60], [24, 120], [12, 120], [24, 120]]) {
      h.resize(rows, columns);
      const lines = assertFits(h);
      assert.match(lines.join("\n"), /→ \[x\] model-120/);
      assert.deepEqual(h.backgroundInputs, []);
    }
    h.input(keys.enter);
    assert.deepEqual(await h.result, { ids: ["model-120"] });
    assert.equal(h.editor.getText(), "unsent background draft");
  });
}

test("fullscreen routes real SGR wheel coordinates into overlay instead of background transcript", async t => {
  const h = fixture("fullscreen");
  t.after(() => h.stop());
  await h.open();
  const lines = assertFits(h);
  const bounds = h.layouts()[0];
  const itemRow = lines.findIndex(line => /→ \[ \]/.test(line));
  assert.ok(itemRow >= 0);
  const top = h.viewport.transcript.scrollTop;
  const before = highlight(lines);
  // SGR coordinates are one-based; list location comes from the rendered frame,
  // so this also verifies the renderer's screen-to-overlay coordinate retargeting.
  h.input(`\x1b[<65;${bounds.col + 5};${bounds.row + itemRow + 1}M`);
  assert.notEqual(highlight(assertFits(h)), before, "wheel changes picker highlight");
  assert.equal(h.viewport.transcript.scrollTop, top, "wheel did not scroll background transcript");
  assert.deepEqual(h.backgroundInputs, []);
  h.input(keys.escape);
  await h.result;
});
