import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  WEB_PLUGIN_VIEW_EVENT,
  VIEW_MAX_ROWS,
  VIEW_MAX_CELL_CHARS,
  VIEW_MAX_BYTES,
  STATUS_TONES,
  validateView,
} from "../lib/web-plugins/view.ts";

import {
  validatePlugin,
  type WebPluginDescriptor,
} from "../lib/web-plugins/descriptor.ts";

import {
  validateRegistry,
  WEB_PLUGIN_VIEW_EVENT as REGISTRY_VIEW_EVENT,
  type WebPluginSurface,
} from "../lib/web-plugins/registry.ts";
import { publishWebView } from "../lib/web-plugins/publisher.ts";
import { cacheStatsPlugin } from "../web-plugins/cache-stats.ts";
import { todoPlugin } from "../web-plugins/todo.ts";
import { artifactsPlugin } from "../web-plugins/artifacts.ts";
import { subagentCheckpointsPlugin } from "../web-plugins/subagent-checkpoints.ts";
import { dashboardPlugin } from "../web-plugins/dashboard.ts";
import { WEB_PLUGINS, WEB_PLUGIN_OPT_OUT } from "../web-plugins/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function normalizeExtName(name: string): string {
  return name.replace(/\.ts$/, "");
}

function checkEnforcement(
  diskExtensions: string[],
  plugins: readonly { extension: string }[],
  optOut: Record<string, string>,
): { missing: string[]; duplicate: string[]; stale: string[] } {
  const diskSet = new Set(diskExtensions.map(normalizeExtName));
  const registered = new Set(plugins.map((p) => normalizeExtName(p.extension)));
  const optedOut = new Set(Object.keys(optOut).map(normalizeExtName));

  const missing: string[] = [];
  const duplicate: string[] = [];
  const stale: string[] = [];

  for (const ext of diskSet) {
    const inPlugins = registered.has(ext);
    const inOptOut = optedOut.has(ext);

    if (!inPlugins && !inOptOut) {
      missing.push(`extensions/${ext}.ts`);
    } else if (inPlugins && inOptOut) {
      duplicate.push(`extensions/${ext}.ts`);
    }
  }

  for (const ext of optedOut) {
    if (!diskSet.has(ext)) {
      stale.push(`extensions/${ext}.ts`);
    }
  }

  return { missing, duplicate, stale };
}

test("enforcement: every extensions/*.ts appears exactly once across WEB_PLUGINS and WEB_PLUGIN_OPT_OUT", async () => {
  const diskFiles = (await readdir(join(root, "extensions"))).filter((f) => f.endsWith(".ts"));
  const report = checkEnforcement(diskFiles, WEB_PLUGINS, WEB_PLUGIN_OPT_OUT);

  assert.deepEqual(
    report.missing,
    [],
    `Extensions missing from both WEB_PLUGINS and WEB_PLUGIN_OPT_OUT: ${report.missing.join(", ")}`,
  );
  assert.deepEqual(
    report.duplicate,
    [],
    `Extensions present in both WEB_PLUGINS and WEB_PLUGIN_OPT_OUT: ${report.duplicate.join(", ")}`,
  );
  assert.deepEqual(
    report.stale,
    [],
    `Stale opt-out entries naming non-existent files: ${report.stale.join(", ")}`,
  );
});

test("enforcement: synthetic failures on missing, duplicate, and stale opt-outs", () => {
  const fakeDisk = ["alpha.ts", "beta.ts", "gamma.ts"];
  const fakePlugins = [{ extension: "alpha" }];
  const fakeOptOut = {
    beta: "reason for beta",
    stale_ext: "nonexistent extension",
  };

  const cleanReport = checkEnforcement(fakeDisk, fakePlugins, { beta: "reason for beta" });
  assert.equal(cleanReport.missing.length, 1); // gamma is missing
  assert.equal(cleanReport.missing[0], "extensions/gamma.ts");

  const staleReport = checkEnforcement(fakeDisk, fakePlugins, fakeOptOut);
  assert.equal(staleReport.stale.length, 1);
  assert.equal(staleReport.stale[0], "extensions/stale_ext.ts");

  const dupReport = checkEnforcement(
    fakeDisk,
    fakePlugins,
    { alpha: "in both", beta: "only in opt out" },
  );
  assert.equal(dupReport.duplicate.length, 1);
  assert.equal(dupReport.duplicate[0], "extensions/alpha.ts");
});

test("descriptor: every WEB_PLUGINS entry passes validatePlugin against real readdir of extensions/", async () => {
  const diskFiles = (await readdir(join(root, "extensions"))).filter((f) => f.endsWith(".ts"));

  for (const plugin of WEB_PLUGINS) {
    const result = validatePlugin(plugin, diskFiles);
    assert.equal(
      result.ok,
      true,
      `Plugin "${plugin.id}" failed validation: ${!result.ok ? result.error : ""}`,
    );
  }
});

test("registry: validateRegistry(WEB_PLUGINS) returns no errors", () => {
  assert.equal(
    REGISTRY_VIEW_EVENT,
    WEB_PLUGIN_VIEW_EVENT,
    "registry.ts must re-export WEB_PLUGIN_VIEW_EVENT",
  );
  const sampleSurface: WebPluginSurface = { kind: "sidebar" };
  assert.equal(sampleSurface.kind, "sidebar");

  const errors = validateRegistry(WEB_PLUGINS);
  assert.deepEqual(errors, [], `validateRegistry returned errors: ${errors.join("; ")}`);
});

test("descriptor validation: enforces id regex, title, extension check, surfaces, and page path", () => {
  const known = ["cache-stats.ts"];

  const badIdResult = validatePlugin(
    { ...cacheStatsPlugin, id: "123-Invalid" },
    known,
  );
  assert.equal(badIdResult.ok, false);
  assert.match(badIdResult.error, /id must match/);

  const missingTitleResult = validatePlugin(
    { ...cacheStatsPlugin, title: "   " },
    known,
  );
  assert.equal(missingTitleResult.ok, false);
  assert.match(missingTitleResult.error, /title is missing or empty/);

  const unknownExtResult = validatePlugin(
    { ...cacheStatsPlugin, extension: "non-existent-plugin" },
    known,
  );
  assert.equal(unknownExtResult.ok, false);
  assert.match(
    unknownExtResult.error,
    /missing file extensions\/non-existent-plugin\.ts/,
    "Error message must name the missing file extensions/<x>.ts",
  );

  const zeroSurfacesResult = validatePlugin(
    { ...cacheStatsPlugin, surfaces: [] },
    known,
  );
  assert.equal(zeroSurfacesResult.ok, false);
  assert.match(zeroSurfacesResult.error, /must have at least one surface/);

  const unknownSurfaceResult = validatePlugin(
    { ...cacheStatsPlugin, surfaces: [{ kind: "modal" }] },
    known,
  );
  assert.equal(unknownSurfaceResult.ok, false);
  assert.match(unknownSurfaceResult.error, /unknown surface kind/);

  const badPathResult = validatePlugin(
    { ...cacheStatsPlugin, surfaces: [{ kind: "page", path: "/invalid/path" }] },
    known,
  );
  assert.equal(badPathResult.ok, false);
  assert.match(badPathResult.error, /invalid page path/);

  const badPathCharsResult = validatePlugin(
    { ...cacheStatsPlugin, surfaces: [{ kind: "page", path: "/plugins/Bad_Path!" }] },
    known,
  );
  assert.equal(badPathCharsResult.ok, false);
  assert.match(badPathCharsResult.error, /invalid page path/);

  for (const slot of ["top", "center", "bottom", "floating"] as const) {
    const validSlotResult = validatePlugin(
      { ...cacheStatsPlugin, surfaces: [{ kind: "slot", slot }] },
      known,
    );
    assert.equal(validSlotResult.ok, true);
  }

  const badSlotResult = validatePlugin(
    { ...cacheStatsPlugin, surfaces: [{ kind: "slot", slot: "invalid-slot" }] },
    known,
  );
  assert.equal(badSlotResult.ok, false);
  assert.match(badSlotResult.error, /invalid slot/);

  const nonStringSlotResult = validatePlugin(
    { ...cacheStatsPlugin, surfaces: [{ kind: "slot", slot: 123 }] },
    known,
  );
  assert.equal(nonStringSlotResult.ok, false);
  assert.match(nonStringSlotResult.error, /invalid slot/);
});

test("registry validation: detects duplicate plugin ids and duplicate page paths", () => {
  const pluginA: WebPluginDescriptor = {
    id: "dup-id",
    extension: "cache-stats",
    title: "Plugin A",
    surfaces: [{ kind: "page", path: "/plugins/page-a" }],
  };
  const pluginB: WebPluginDescriptor = {
    id: "dup-id",
    extension: "cache-stats",
    title: "Plugin B",
    surfaces: [{ kind: "page", path: "/plugins/page-b" }],
  };
  const errorsDupId = validateRegistry([pluginA, pluginB], ["cache-stats.ts"]);
  assert.ok(errorsDupId.some((e) => e.includes('Duplicate plugin id: "dup-id"')));

  const pluginC: WebPluginDescriptor = {
    id: "plugin-c",
    extension: "cache-stats",
    title: "Plugin C",
    surfaces: [{ kind: "page", path: "/plugins/shared-page" }],
  };
  const pluginD: WebPluginDescriptor = {
    id: "plugin-d",
    extension: "cache-stats",
    title: "Plugin D",
    surfaces: [{ kind: "page", path: "/plugins/shared-page" }],
  };
  const errorsDupPath = validateRegistry([pluginC, pluginD], ["cache-stats.ts"]);
  assert.ok(errorsDupPath.some((e) => e.includes('Duplicate page path: "/plugins/shared-page"')));
});

test("view contract: cell clamping at 500 characters with ellipsis", () => {
  assert.equal(VIEW_MAX_CELL_CHARS, 500);

  const longLabel = "L".repeat(600);
  const longValue = "V".repeat(550);
  const longItem = "I".repeat(700);
  const longStatusText = "S".repeat(800);
  const longTitle = "T".repeat(650);

  // kv view clamping
  const kvResult = validateView({
    type: "kv",
    title: longTitle,
    rows: [{ label: longLabel, value: longValue }],
  });
  assert.equal(kvResult.ok, true);
  if (kvResult.ok) {
    assert.equal(kvResult.view.type, "kv");
    assert.equal(kvResult.view.title?.length, 500);
    assert.ok(kvResult.view.title?.endsWith("…"));
    assert.equal(kvResult.view.rows[0].label.length, 500);
    assert.ok(kvResult.view.rows[0].label.endsWith("…"));
    assert.equal(kvResult.view.rows[0].value.length, 500);
    assert.ok(kvResult.view.rows[0].value.endsWith("…"));
    assert.ok((kvResult.warnings?.length ?? 0) >= 3);
  }

  // list view clamping
  const listResult = validateView({
    type: "list",
    items: [longItem],
  });
  assert.equal(listResult.ok, true);
  if (listResult.ok) {
    assert.equal(listResult.view.type, "list");
    assert.equal(listResult.view.items[0].length, 500);
    assert.ok(listResult.view.items[0].endsWith("…"));
  }

  // status view clamping
  const statusResult = validateView({
    type: "status",
    tone: "neutral",
    text: longStatusText,
  });
  assert.equal(statusResult.ok, true);
  if (statusResult.ok) {
    assert.equal(statusResult.view.type, "status");
    assert.equal(statusResult.view.text.length, 500);
    assert.ok(statusResult.view.text.endsWith("…"));
  }
});

test("view contract: row cap at 200 items/rows", () => {
  assert.equal(VIEW_MAX_ROWS, 200);

  const rows = Array.from({ length: 250 }, (_, i) => ({
    label: `key-${i}`,
    value: `val-${i}`,
  }));

  const kvResult = validateView({ type: "kv", rows });
  assert.equal(kvResult.ok, true);
  if (kvResult.ok) {
    assert.equal(kvResult.view.type, "kv");
    assert.equal(kvResult.view.rows.length, 200);
    assert.equal(kvResult.view.omitted, 50);
  }

  const items = Array.from({ length: 250 }, (_, i) => `item-${i}`);
  const listResult = validateView({ type: "list", items });
  assert.equal(listResult.ok, true);
  if (listResult.ok) {
    assert.equal(listResult.view.type, "list");
    assert.equal(listResult.view.items.length, 200);
    assert.equal(listResult.view.omitted, 50);
  }
});

test("view contract: byte-fit truncation sets omitted > 0 and stays under 64KB", () => {
  assert.equal(VIEW_MAX_BYTES, 65536);

  // 200 rows with 400 chars each = ~160KB total JSON
  const rows = Array.from({ length: 200 }, (_, i) => ({
    label: `label-${i}-${"x".repeat(150)}`,
    value: `value-${i}-${"y".repeat(250)}`,
  }));

  const kvResult = validateView({ type: "kv", rows });
  assert.equal(kvResult.ok, true);
  if (kvResult.ok) {
    assert.equal(kvResult.view.type, "kv");
    const jsonBytes = new TextEncoder().encode(JSON.stringify(kvResult.view)).length;
    assert.ok(
      jsonBytes <= VIEW_MAX_BYTES,
      `Expected byte length ${jsonBytes} <= ${VIEW_MAX_BYTES}`,
    );
    assert.ok(
      (kvResult.view.omitted ?? 0) > 0,
      `Expected omitted count > 0, got ${kvResult.view.omitted}`,
    );
    assert.ok(kvResult.view.rows.length < 200);
  }

  // list view byte fitting
  const items = Array.from({ length: 200 }, (_, i) => `item-${i}-${"z".repeat(450)}`);
  const listResult = validateView({ type: "list", items });
  assert.equal(listResult.ok, true);
  if (listResult.ok) {
    assert.equal(listResult.view.type, "list");
    const jsonBytes = new TextEncoder().encode(JSON.stringify(listResult.view)).length;
    assert.ok(
      jsonBytes <= VIEW_MAX_BYTES,
      `Expected byte length ${jsonBytes} <= ${VIEW_MAX_BYTES}`,
    );
    assert.ok((listResult.view.omitted ?? 0) > 0);
  }
});

test("view contract: rejects unknown types, bad tones, non-string cells, invalid titles", () => {
  assert.deepEqual(STATUS_TONES, ["neutral", "accent", "success", "warning", "danger"]);

  const unknownType = validateView({ type: "table", rows: [] });
  assert.equal(unknownType.ok, false);

  const badTone = validateView({ type: "status", tone: "critical", text: "err" });
  assert.equal(badTone.ok, false);

  const nonStringKvLabel = validateView({
    type: "kv",
    rows: [{ label: 123, value: "val" }],
  });
  assert.equal(nonStringKvLabel.ok, false);

  const nonStringKvVal = validateView({
    type: "kv",
    rows: [{ label: "lbl", value: null }],
  });
  assert.equal(nonStringKvVal.ok, false);

  const nonStringListItem = validateView({
    type: "list",
    items: ["valid", 42],
  });
  assert.equal(nonStringListItem.ok, false);

  const nonStringStatusText = validateView({
    type: "status",
    tone: "accent",
    text: 1234,
  });
  assert.equal(nonStringStatusText.ok, false);

  const nonStringTitle = validateView({
    type: "kv",
    title: 100,
    rows: [],
  });
  assert.equal(nonStringTitle.ok, false);
});

test("view contract: validateView never throws on garbage inputs", () => {
  const invalidInputs = [
    null,
    undefined,
    12345,
    "not-an-object",
    true,
    false,
    [],
    [1, 2, 3],
    {},
    { foo: "bar", nested: { a: 1 } },
    { type: null },
    { type: {} },
    { type: "unknown-type" },
    { type: "kv", rows: "not-an-array" },
    { type: "list", items: "not-an-array" },
    { type: "status" },
    { type: "status", tone: null, text: null },
    { type: "status", tone: "invalid-tone", text: "hello" },
    { type: "kv", rows: [null, undefined, 42, "string", {}] },
    { type: "kv", rows: [{ label: "a" }] },
    { type: "kv", rows: [{ value: "b" }] },
    { type: "list", items: [null, undefined, {}] },
    { type: "kv", title: null, rows: [] },
    { type: "kv", title: 123, rows: [] },
  ];

  for (const input of invalidInputs) {
    assert.doesNotThrow(() => {
      const res = validateView(input);
      assert.equal(res.ok, false);
    });
  }

  // Fuzz testing with arbitrary weird inputs to verify it never throws
  const fuzzInputs: unknown[] = [
    { type: "kv", rows: [], extraProp: { deeply: { nested: true } } },
    { type: "list", items: [], huge: "H".repeat(100_000) },
    { [Symbol("weird")]: "symbol-key" },
    new Date(),
    /regex-pattern/,
    new Uint8Array(10),
  ];

  for (const input of fuzzInputs) {
    assert.doesNotThrow(() => {
      validateView(input);
    });
  }
});

test("view contract: XSS shape is preserved verbatim as data", () => {
  const xssPayload = "<script>alert(1)</script>";
  const htmlTag = '<img src=x onerror="alert(2)">';

  const kvResult = validateView({
    type: "kv",
    title: xssPayload,
    rows: [{ label: xssPayload, value: htmlTag }],
  });
  assert.equal(kvResult.ok, true);
  if (kvResult.ok && kvResult.view.type === "kv") {
    assert.equal(kvResult.view.title, xssPayload);
    assert.equal(kvResult.view.rows[0].label, xssPayload);
    assert.equal(kvResult.view.rows[0].value, htmlTag);
  } else {
    assert.fail("Expected kv view");
  }

  const listResult = validateView({
    type: "list",
    items: [xssPayload],
  });
  assert.equal(listResult.ok, true);
  if (listResult.ok && listResult.view.type === "list") {
    assert.equal(listResult.view.items[0], xssPayload);
  } else {
    assert.fail("Expected list view");
  }

  const statusResult = validateView({
    type: "status",
    tone: "neutral",
    text: xssPayload,
  });
  assert.equal(statusResult.ok, true);
  if (statusResult.ok && statusResult.view.type === "status") {
    assert.equal(statusResult.view.text, xssPayload);
  } else {
    assert.fail("Expected status view");
  }
});

test("publisher: emits on WEB_PLUGIN_VIEW_EVENT with valid view, rejects bad view without emit", () => {
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const stubPi = {
    events: {
      emit(channel: string, data: unknown) {
        emitted.push({ channel, data });
      },
    },
  };

  const validView = {
    type: "status" as const,
    tone: "success" as const,
    text: "Healthy",
  };

  const okResult = publishWebView(stubPi, "cache-stats", validView);
  assert.equal(okResult.ok, true);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].channel, WEB_PLUGIN_VIEW_EVENT);
  assert.deepEqual(emitted[0].data, {
    pluginId: "cache-stats",
    view: validView,
  });

  const badView = {
    type: "status",
    tone: "invalid-tone",
    text: "Healthy",
  };

  const failResult = publishWebView(stubPi, "cache-stats", badView);
  assert.equal(failResult.ok, false);
  assert.equal(emitted.length, 1, "Nothing should be emitted on bad view");

  const badPluginId = publishWebView(stubPi, "", validView);
  assert.equal(badPluginId.ok, false);
});

test("publisher: throwing or stub-less pi never causes publishWebView to throw", () => {
  const validView = {
    type: "status" as const,
    tone: "accent" as const,
    text: "Info",
  };

  const throwingPi = {
    events: {
      emit() {
        throw new Error("Events system exploded");
      },
    },
  };

  assert.doesNotThrow(() => {
    const res = publishWebView(throwingPi, "cache-stats", validView);
    assert.equal(res.ok, true);
  });

  const stublessPiCases = [
    null,
    undefined,
    {},
    { events: undefined },
    { events: {} },
    { events: { emit: null } },
  ];

  for (const piCase of stublessPiCases) {
    assert.doesNotThrow(() => {
      const res = publishWebView(piCase as any, "cache-stats", validView);
      assert.equal(res.ok, true);
    });
  }
});

test("phase 6 placements: WEB_PLUGINS declared with exact slot and page placements", async () => {
  const diskFiles = (await readdir(join(root, "extensions"))).filter((f) => f.endsWith(".ts"));

  // No hard-coded plugin/opt-out counts: they broke on every newly registered
  // plugin, which is the exact flow this system exists to make cheap. Coverage
  // is pinned by the sum (every extension in exactly one list) plus membership.
  assert.equal(WEB_PLUGINS.length + Object.keys(WEB_PLUGIN_OPT_OUT).length, diskFiles.length);
  for (const id of ["cache-stats", "todo", "artifacts", "subagent-checkpoints", "dashboard"]) {
    assert.ok(WEB_PLUGINS.some((plugin) => plugin.id === id), `${id} must be a registered plugin`);
    assert.equal(id in WEB_PLUGIN_OPT_OUT, false, `${id} must not also be opted out`);
  }

  // Exact Phase 6 placement assertions (R2 amended in 23b66e5)
  assert.deepEqual(cacheStatsPlugin.surfaces, [
    { kind: "sidebar" },
    { kind: "slot", slot: "bottom" },
  ]);
  assert.deepEqual(todoPlugin.surfaces, [
    { kind: "sidebar" },
    { kind: "slot", slot: "top" },
  ]);
  assert.deepEqual(artifactsPlugin.surfaces, [
    { kind: "sidebar" },
    { kind: "slot", slot: "floating" },
  ]);
  assert.deepEqual(subagentCheckpointsPlugin.surfaces, [
    { kind: "sidebar" },
    { kind: "slot", slot: "center" },
  ]);
  assert.deepEqual(dashboardPlugin.surfaces, [
    { kind: "sidebar" },
    { kind: "page", path: "/plugins/dashboard" },
  ]);
  assert.ok(dashboardPlugin.actions && dashboardPlugin.actions.length > 0, "dashboard keeps actions");

  for (const descriptor of WEB_PLUGINS) {
    const result = validatePlugin(descriptor, diskFiles);
    assert.equal(result.ok, true, `Descriptor "${descriptor.id}" failed: ${!result.ok ? result.error : ""}`);
  }

  const regErrors = validateRegistry(WEB_PLUGINS, diskFiles);
  assert.deepEqual(regErrors, [], `validateRegistry failed: ${regErrors.join("; ")}`);
});

test("phase 3 views: representative view fixtures for todo, artifacts, and subagent-checkpoints pass validateView", () => {
  // todo: list view mirroring TUI task status and titles
  const todoView = {
    type: "list" as const,
    title: "Todo [Plan] 2/5",
    items: [
      "✔ Initialize database",
      "✔ Set up server routes",
      "⟳ Implement auth endpoints",
      "○ Write integration tests",
      "○ Polish API documentation",
    ],
  };
  const todoResult = validateView(todoView);
  assert.equal(todoResult.ok, true);
  if (todoResult.ok) {
    assert.equal(todoResult.view.type, "list");
    assert.equal(todoResult.view.title, "Todo [Plan] 2/5");
    assert.equal(todoResult.view.items.length, 5);
  }

  // artifacts: list view mirroring workspace artifact icons and titles
  const artifactsView = {
    type: "list" as const,
    title: "Artifacts 3",
    items: [
      "󰈙 Architecture Specification",
      "󰈙 API Design Document",
      "󰈙 Migration Plan",
    ],
  };
  const artifactsResult = validateView(artifactsView);
  assert.equal(artifactsResult.ok, true);
  if (artifactsResult.ok) {
    assert.equal(artifactsResult.view.type, "list");
    assert.equal(artifactsResult.view.title, "Artifacts 3");
    assert.equal(artifactsResult.view.items.length, 3);
  }

  // subagent-checkpoints: list view mirroring delegated children state
  const subagentsView = {
    type: "list" as const,
    title: "Delegated (2)",
    items: [
      "● research-worker · running · fork",
      "✔ test-runner · completed · digest",
    ],
  };
  const subagentsResult = validateView(subagentsView);
  assert.equal(subagentsResult.ok, true);
  if (subagentsResult.ok) {
    assert.equal(subagentsResult.view.type, "list");
    assert.equal(subagentsResult.view.title, "Delegated (2)");
    assert.equal(subagentsResult.view.items.length, 2);
  }

  // subagent-checkpoints: empty state
  const subagentsEmptyView = {
    type: "list" as const,
    title: "Delegated work",
    items: [],
  };
  const emptyResult = validateView(subagentsEmptyView);
  assert.equal(emptyResult.ok, true);
});

test("phase 3 publisher: publishWebView successfully emits views for phase 3 plugins", () => {
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const stubPi = {
    events: {
      emit(channel: string, data: unknown) {
        emitted.push({ channel, data });
      },
    },
  };

  const todoView = {
    type: "list" as const,
    title: "Todo 1/2",
    items: ["✔ First task", "○ Second task"],
  };
  const r1 = publishWebView(stubPi, "todo", todoView);
  assert.equal(r1.ok, true);
  assert.deepEqual(emitted[0], {
    channel: WEB_PLUGIN_VIEW_EVENT,
    data: { pluginId: "todo", view: todoView },
  });

  const artifactsView = {
    type: "list" as const,
    title: "Artifacts 1",
    items: ["󰈙 Spec v1"],
  };
  const r2 = publishWebView(stubPi, "artifacts", artifactsView);
  assert.equal(r2.ok, true);
  assert.deepEqual(emitted[1], {
    channel: WEB_PLUGIN_VIEW_EVENT,
    data: { pluginId: "artifacts", view: artifactsView },
  });

  const subagentsView = {
    type: "list" as const,
    title: "Delegated (1)",
    items: ["● worker-1 · running"],
  };
  const r3 = publishWebView(stubPi, "subagent-checkpoints", subagentsView);
  assert.equal(r3.ok, true);
  assert.deepEqual(emitted[2], {
    channel: WEB_PLUGIN_VIEW_EVENT,
    data: { pluginId: "subagent-checkpoints", view: subagentsView },
  });
});
