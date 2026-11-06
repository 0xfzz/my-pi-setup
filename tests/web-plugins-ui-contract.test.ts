import test from "node:test";
import assert from "node:assert/strict";
import { validateContributions, validatePlacement, normalizeContributions, resolveOverrides, type WebPluginUiContribution } from "../lib/web-plugins/ui-contract.ts";
import { validatePlugin } from "../lib/web-plugins/descriptor.ts";
import { validateRegistry } from "../lib/web-plugins/registry.ts";

const contribution: WebPluginUiContribution = { id: "working", component: "ui.working-indicator.v1", scope: "session", placement: { kind: "anchor", anchor: "chat.working" }, override: { target: "ui.working-indicator.v1", mode: "replace", fallback: "builtin" } };
test("UI contract: anchor catalog, bounded overlay, responsive constraints and legacy normalization", () => {
  assert.equal(validateContributions([contribution], "fixture").ok, true);
  assert.equal(validatePlacement({ kind: "overlay", maxWidth: 320, maxHeight: 240, mobileFallback: "chat.after", inset: { bottom: 12 } }).ok, true);
  assert.deepEqual(normalizeContributions({ surfaces: [{ kind: "slot", slot: "top" }] })[0]?.placement, { kind: "region", region: "top" });
  assert.equal(validatePlugin({ id: "fixture", title: "Fixture", extension: "fixture", surfaces: [], ui: [contribution] }, ["fixture"]).ok, true);
});
test("UI contract: malformed/unsafe placements and contribution fields are named and rejected", () => {
  for (const placement of [
    { kind: "anchor", anchor: "#auth" }, { kind: "region", region: "viewport" },
    { kind: "overlay" }, { kind: "overlay", anchor: "app.header", maxWidth: 300, maxHeight: 200 },
    { kind: "overlay", maxWidth: 300, maxHeight: 200, inset: { left: -1 } },
    { kind: "anchor", anchor: "chat.before", minWidth: 400, maxWidth: 100 },
    { kind: "anchor", anchor: "chat.before", maxWidth: NaN },
    { kind: "anchor", anchor: "chat.before", zIndex: 99999 },
    { kind: "anchor", anchor: "chat.before", mobileFallback: "auth" },
    { kind: "anchor", anchor: "chat.before", style: "position:fixed" },
  ]) assert.equal(validatePlacement(placement).ok, false, JSON.stringify(placement));
  for (const bad of [{ ...contribution, component: "ui.auth.v1" }, { ...contribution, priority: Infinity }, { ...contribution, strategy: "javascript:alert(1)" }, { ...contribution, scope: undefined }, { ...contribution, override: { target: "ui.auth.v1", mode: "hide", fallback: "builtin" } }, { ...contribution, override: { target: contribution.component, mode: "replace" } }, { ...contribution, component: "ui.working-indicator.v2" }]) {
    const result = validateContributions([bad], "fixture");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /Plugin "fixture" contribution "working"/);
  }
  assert.equal(validateContributions([contribution, contribution], "fixture").ok, false);
});
test("UI contract: deterministic override priority/user preference, wrap/hide and disabled builtin fallback", () => {
  const low = { pluginId: "low", contribution: { ...contribution, priority: 1 } };
  const high = { pluginId: "high", contribution: { ...contribution, priority: 9 } };
  const wrap = { pluginId: "wrap", contribution: { ...contribution, override: { target: contribution.component, mode: "wrap" as const, fallback: "builtin" as const } } };
  const entries = [low, wrap, high];
  assert.equal(resolveOverrides(contribution.component, entries).replacement?.pluginId, "high");
  assert.equal(resolveOverrides(contribution.component, [...entries].reverse()).replacement?.pluginId, "high");
  assert.equal(resolveOverrides(contribution.component, entries, new Set(), "low/working").replacement?.pluginId, "low");
  assert.equal(resolveOverrides(contribution.component, entries).wrappers[0]?.pluginId, "wrap");
  assert.equal(resolveOverrides(contribution.component, entries, new Set(["high/working", "low/working"])).replacement, undefined);
  assert.equal(resolveOverrides(contribution.component, [{ pluginId: "hide", contribution: { ...contribution, override: { target: contribution.component, mode: "hide", fallback: "builtin" } } }]).hidden, true);
});
test("UI registry: conflicting exclusive replacements name both owners", () => {
  const plugins = ["first", "second"].map(id => ({ id, title: id, extension: "fixture", surfaces: [], ui: [contribution] }));
  assert.match(validateRegistry(plugins, ["fixture"]).join("\n"), /second.*working.*first\/working/);
});
test("PRD AC3: no pi-web UI source contains a plugin-ID-specific renderer branch", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const roots = ["vendor/pi-web/components", "vendor/pi-web/hooks"];
  for (const root of roots) {
    for (const entry of await readdir(root, { recursive: true })) {
      if (!entry.endsWith(".tsx") && !entry.endsWith(".ts")) continue;
      const source = await readFile(join(root, entry), "utf8");
      assert.doesNotMatch(source, /bubbly/i, `${entry} must not branch on a plugin id`);
    }
  }
});
