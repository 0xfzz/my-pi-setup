import test from "node:test";
import assert from "node:assert/strict";
import type { WebPluginDescriptor } from "./plugin-system/contract.ts";
import { buildPanelEntries } from "./plugin-system/panel-entry.ts";

function plugin(id: string, title: string, surfaces: WebPluginDescriptor["surfaces"]): WebPluginDescriptor {
  return { id, title, extension: id, icon: "puzzle-piece", surfaces };
}

/** The Files plugin ships as a manifest (pi-web-plugin.json), not a descriptor module. */
const filesPlugin: WebPluginDescriptor = {
  id: "files",
  extension: "web-core.files",
  title: "Files",
  icon: "files",
  surfaces: [{ kind: "sidebar" }],
  sessionPanel: true,
};

test("buildPanelEntries lists sidebar-eligible plugins including sessionPanel plugins in registry order", () => {
  const entries = buildPanelEntries(
    [
      plugin("a", "Alpha", [{ kind: "sidebar" }]),
      plugin("b", "Beta", [{ kind: "slot", slot: "top" }]), // inline only
      plugin("c", "Gamma", [{ kind: "override", region: "composer" }]), // not a panel
      plugin("d", "Delta", [{ kind: "slot", slot: "center" }]),
      filesPlugin,
    ],
    new Set(["a", "d", "files"]),
    true,
  );
  assert.deepEqual(
    entries.map((e) => [e.id, e.available]),
    [["a", true], ["d", true], ["files", true]],
  );
  assert.equal(entries[0].title, "Alpha");
  assert.equal(entries[2].icon, "files");
  assert.equal(entries[2].title, "Files");
});

test("unavailable plugins carry a reason and sessionPanel plugins reflect session absence", () => {
  const entries = buildPanelEntries(
    [plugin("a", "Alpha", [{ kind: "sidebar" }]), filesPlugin],
    new Set(),
    false,
  );
  assert.equal(entries[0].available, false);
  assert.equal(entries[0].unavailableReason, "No view published yet");
  assert.equal(entries[1].available, false);
  assert.equal(entries[1].unavailableReason, "No session selected");
});
