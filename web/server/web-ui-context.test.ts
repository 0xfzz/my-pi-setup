import test from "node:test";
import assert from "node:assert/strict";
import { createHeadlessWebUiContext } from "./web-ui-context.ts";

test("headless web UI context flips hasUI with safe no-op ctx.ui methods", async () => {
  const ui = createHeadlessWebUiContext();

  // Interactive dialogs resolve with safe defaults; no browser round-trip.
  assert.equal(await ui.select("Pick", ["a", "b"]), undefined);
  assert.equal(await ui.confirm("Sure?", "msg"), false);
  assert.equal(await ui.input("What?"), undefined);
  assert.equal(await ui.editor("Edit"), undefined);
  assert.equal(await ui.custom(() => undefined as never), undefined);

  // Stateful TUI methods are no-ops that never throw.
  assert.doesNotThrow(() => {
    ui.notify("hello", "info");
    ui.setStatus("key", "value");
    ui.setWidget("key", ["line"]);
    ui.setTitle("title");
    ui.setEditorText("text");
    ui.setWorkingMessage("working");
    ui.setWorkingVisible(true);
    ui.setWorkingIndicator();
    ui.setHiddenThinkingLabel();
    ui.pasteToEditor("text");
    ui.setFooter(undefined);
    ui.setHeader(undefined);
    ui.addAutocompleteProvider(() => undefined as never);
    ui.setEditorComponent(undefined);
    ui.setToolsExpanded(true);
  });

  assert.equal(ui.getEditorText(), "");
  assert.equal(ui.getEditorComponent(), undefined);
  assert.equal(ui.getToolsExpanded(), false);
  assert.deepEqual(ui.getAllThemes(), []);
  assert.equal(ui.getTheme("anything"), undefined);
  assert.deepEqual(ui.setTheme("anything"), {
    success: false,
    error: "no terminal theme in the web server",
  });

  // Terminal-theme stub passes text through uncoloured.
  const theme = ui.theme as unknown as { fg: (token: string, value: string) => string; bg: (token: string, value: string) => string };
  assert.equal(theme.fg("muted", "hello"), "hello");
  assert.equal(theme.bg("muted", "world"), "world");

  assert.equal(typeof ui.onTerminalInput(() => undefined), "function");
});