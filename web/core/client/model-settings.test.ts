import test from "node:test";
import assert from "node:assert/strict";
import { needsSettingsDispatch, settingsDialog, settingsPluginIds } from "./model-settings.ts";

test("settings content uses the announced owner even when no dialog plugin is listed", () => {
  const view = { type: "dialog", title: "Providers", lines: ["acme"] };
  const result = settingsDialog({ settingsPlugin: "providers" }, { unrelated: { type: "dialog", lines: ["Other"] }, providers: view });
  assert.equal(result?.pluginId, "providers");
  assert.equal(result?.view.title, "Providers");
});

test("a pending settings view never borrows another plugin's popup", () => {
  assert.equal(settingsDialog({ settingsPlugin: "providers" }, { other: { type: "dialog", lines: ["Other"] } }), undefined);
  assert.equal(settingsDialog(undefined, {}), undefined);
  assert.equal(settingsDialog({}, {}), undefined);
});

test("closed settings views remain identifiable and non-dialog views are refused", () => {
  assert.equal(settingsDialog({ settingsPlugin: "providers" }, { providers: { type: "dialog", open: false } })?.view.open, false);
  assert.equal(settingsDialog({ settingsPlugin: "providers" }, { providers: { type: "status", text: "No" } }), undefined);
});

test("every settings plugin's dialog is owned by the pane, not the standalone layer", () => {
  const commands = [
    { name: "provider", managesModels: true, settingsPlugin: "providers" },
    { name: "router", managesModels: true, settingsPlugin: "router" },
    { name: "models", managesModels: false, settingsPlugin: "ignored" },
    { name: "plain" },
  ];
  assert.deepEqual(settingsPluginIds(commands), ["providers", "router"]);
  assert.deepEqual(settingsPluginIds([]), []);
  assert.deepEqual(settingsPluginIds(undefined), []);
});

test("opening a page dispatches only when the extension is not mid-wizard", () => {
  // Nothing published yet: the extension has to be asked to start.
  assert.equal(needsSettingsDispatch(undefined), true);
  // A closed view is a finished wizard: the next visit starts a fresh one.
  assert.equal(needsSettingsDispatch({ view: { open: false } }), true);
  // An open view is a wizard in flight. Re-dispatching restarts it and drops
  // the answers the user is in the middle of giving, so render it instead.
  assert.equal(needsSettingsDispatch({ view: { open: true } }), false);
  assert.equal(needsSettingsDispatch({ view: {} }), false);
});
