import test from "node:test";
import assert from "node:assert/strict";
import { addEntryCommand, needsSettingsDispatch, settingsDialog, settingsPages, settingsPluginIds } from "./model-settings.ts";

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

test("settingsPages: the picker first, then every catalogue command by label", () => {
  const pages = settingsPages([
    { name: "router", managesModels: true, settingsEntry: "Router" },
    { name: "provider", managesModels: true, settingsEntry: "Provider" },
    { name: "plain" },
    { name: "unlabelled", managesModels: true },
  ]);
  assert.deepEqual(pages.map((page) => page.label), ["Models", "Provider", "Router", "unlabelled"],
    "a stable order, so the nav does not reshuffle with the extensions' load order");
  assert.equal(pages[0]?.id, "models", "the picker is always first");
});

test("settingsPages: a command without a name contributes no page", () => {
  assert.deepEqual(settingsPages([{ managesModels: true }]).map((page) => page.id), ["models"]);
  assert.deepEqual(settingsPages(undefined).map((page) => page.id), ["models"]);
});

test("addEntryCommand: only addsModels claims the picker's add entry", () => {
  const commands = [
    { name: "router", managesModels: true, settingsEntry: "Router" },
    { name: "provider", managesModels: true, addsModels: true, settingsEntry: "Provider" },
  ];
  assert.equal(addEntryCommand(commands)?.name, "provider",
    "the router manages the catalogue but cannot add a model, so it must not take the entry");
  assert.equal(addEntryCommand([commands[0]!])?.name, "router",
    "a producer from before the flag still gets an entry");
  assert.equal(addEntryCommand([]), undefined);
  assert.equal(addEntryCommand(undefined), undefined);
});
