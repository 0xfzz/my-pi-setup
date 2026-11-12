import test from "node:test";
import assert from "node:assert/strict";
import type { WebPluginDescriptor } from "./plugin-system/contract.ts";
import { buildPanelEntries, FILES_PANEL_ID } from "./plugin-system/panel-entry.ts";

function plugin(id: string, title: string, surfaces: WebPluginDescriptor["surfaces"]): WebPluginDescriptor {
  return { id, title, extension: id, icon: "puzzle-piece", surfaces };
}

test("buildPanelEntries lists sidebar-eligible plugins then the Files panel", () => {
  const entries = buildPanelEntries(
    [
      plugin("a", "Alpha", [{ kind: "sidebar" }]),
      plugin("b", "Beta", [{ kind: "slot", slot: "top" }]), // inline only
      plugin("c", "Gamma", [{ kind: "override", region: "composer" }]), // not a panel
      plugin("d", "Delta", [{ kind: "slot", slot: "center" }]),
    ],
    new Set(["a", "d"]),
    true,
  );
  assert.deepEqual(
    entries.map((e) => [e.id, e.available]),
    [["a", true], ["d", true], [FILES_PANEL_ID, true]],
  );
  assert.equal(entries[0].title, "Alpha");
});

test("unavailable plugins carry a reason and Files reflects session absence", () => {
  const entries = buildPanelEntries(
    [plugin("a", "Alpha", [{ kind: "sidebar" }])],
    new Set(),
    false,
  );
  assert.equal(entries[0].available, false);
  assert.equal(entries[0].unavailableReason, "No view published yet");
  assert.equal(entries[1].available, false);
  assert.equal(entries[1].unavailableReason, "No session selected");
});

test("the Files entry uses the host 'files' icon", () => {
  const entries = buildPanelEntries([], new Set(), true);
  assert.equal(entries[0].icon, "files");
  assert.equal(entries[0].title, "Files");
});