import test from "node:test";
import assert from "node:assert/strict";
import { settingsDialog } from "./model-settings.ts";

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
