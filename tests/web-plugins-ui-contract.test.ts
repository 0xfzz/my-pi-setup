import test from "node:test";
import assert from "node:assert/strict";
import { contributionsOf, validateContributions, validatePlacement, resolveOverrides, type WebPluginUiContribution } from "../web/core/plugin-contracts/ui-contracts.ts";
import { validatePlugin } from "../web/core/plugin-contracts/descriptor.ts";
import { validateRegistry } from "../web/core/plugin-contracts/registry.ts";
import { WEB_PLUGINS } from "../web/plugins/index.ts";

const contribution = {
  id: "working",
  component: "ui.working-indicator.v1",
  scope: "session",
  placement: { kind: "anchor", anchor: "chat.working" },
  override: { target: "ui.working-indicator.v1", mode: "replace", fallback: "builtin" },
} satisfies WebPluginUiContribution;
test("UI contract: anchor catalog, bounded overlay and responsive constraints", () => {
  assert.equal(validateContributions([contribution], "fixture").ok, true);
  assert.equal(validatePlacement({ kind: "overlay", maxWidth: 320, maxHeight: 240, mobileFallback: "chat.after", inset: { bottom: 12 } }).ok, true);
  assert.equal(validatePlugin({ id: "fixture", title: "Fixture", extension: "fixture", surfaces: [], ui: [contribution] }).ok, true);
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
  const malformed: unknown[] = [
    { ...contribution, component: "ui.auth.v1" },
    { ...contribution, priority: Infinity },
    { ...contribution, strategy: "javascript:alert(1)" },
    { ...contribution, scope: undefined },
    { ...contribution, override: { target: "ui.auth.v1", mode: "hide", fallback: "builtin" } },
    // An override target with no ComponentOverrideHost is a declaration
    // nothing mounts, so the validator refuses it.
    { ...contribution, override: { target: "ui.plugin-view.v1", mode: "replace", fallback: "builtin" } },
    { ...contribution, override: { target: contribution.component, mode: "replace" } },
    { ...contribution, component: "ui.working-indicator.v2" },
  ];
  for (const bad of malformed) {
    const result = validateContributions([bad], "fixture");
    assert.equal(result.ok, false, JSON.stringify(bad));
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
test("adopted plugins declare their placement once, in ui", () => {
  for (const plugin of WEB_PLUGINS) {
    // A page-only or dialog-only plugin places no view of its own, so it
    // declares no ui contribution rather than an inert one that exists only
    // to satisfy the registry.
    if (plugin.ui === undefined) {
      assert.deepEqual(contributionsOf(plugin), [], `${plugin.id} places no view`);
      continue;
    }
    assert.ok(plugin.ui.length > 0, `${plugin.id} must explicitly declare its UI`);
    assert.equal(validateContributions(plugin.ui, plugin.id).ok, true);
    assert.ok(plugin.ui.every(c => c.scope === "session"), plugin.id);
    // No surface repeats a placement: `slot` is not a surface kind any more.
    assert.deepEqual(
      plugin.surfaces.filter(surface => (surface as { kind: string }).kind === "slot"),
      [],
      `${plugin.id} must not declare a slot surface`,
    );
  }
  const monitor = WEB_PLUGINS.find(plugin => plugin.id === "subagent-monitor");
  assert.deepEqual(monitor?.ui?.[0]?.placement, { kind: "anchor", anchor: "session.sidebar", collision: "shrink" });
});
test("UI registry: conflicting exclusive replacements name both owners", () => {
  const plugins = ["first", "second"].map(id => ({ id, title: id, extension: "fixture", surfaces: [], ui: [contribution] }));
  assert.match(validateRegistry(plugins).join("\n"), /second.*working.*first\/working/);
});
test("plugin navigation rides the shared session state instead of a separate fetch", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile("web/core/client/plugin-system/PluginLayout.tsx", "utf8");
  // The minimal client's nav is prop-driven: one session hook owns the single
  // EventSource, so navigation surfaces never open their own connections.
  assert.match(source, /plugins\s*:\s*readonly WebPluginDescriptor\[\]/);
  assert.doesNotMatch(source, /\bfetch\s*\(|\bEventSource\s*\(/);
});
test("PRD AC3: no pi-web UI source contains a plugin-ID-specific renderer branch", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const roots = ["web/core/client", "web/core/shared"];
  for (const root of roots) {
    for (const entry of await readdir(root, { recursive: true })) {
      if (!entry.endsWith(".tsx") && !entry.endsWith(".ts")) continue;
      const source = await readFile(join(root, entry), "utf8");
      assert.doesNotMatch(source, /bubbly/i, `${entry} must not branch on a plugin id`);
    }
  }
});
