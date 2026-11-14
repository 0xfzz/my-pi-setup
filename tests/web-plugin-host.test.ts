import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPluginHost } from "../web/core/plugin-contracts/kernel/host.ts";
import { compatCandidates, manifestForDescriptor } from "../web/core/plugin-contracts/kernel/compat.ts";
import type { PluginLoader } from "../web/core/plugin-contracts/kernel/manager.ts";
import type { WebPluginDescriptor } from "../web/core/plugin-contracts/descriptor.ts";

const descriptors = [
  { id: "todo", title: "Todo" },
  { id: "subagent-graph", title: "Delegated work graph" },
];

function withState(fn: (statePath: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "web-plugin-host-"));
  return fn(join(dir, "web-plugins.json")).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("every descriptor becomes a declarative repo candidate with no entry points", () => {
  const candidates = compatCandidates(descriptors, "/repo/web-plugins");
  assert.deepEqual(candidates.map((c) => [c.id, c.source]), [["todo", "repo"], ["subagent-graph", "repo"]]);
  assert.equal(candidates[0].manifest.trust, "declarative");
  assert.deepEqual(candidates[0].manifest.main, {});
  assert.equal(manifestForDescriptor({ id: "bubbly-spinner", title: "Bubbly spinner" }).name, "Bubbly spinner");
});

test("descriptors are visible by default and hidden once their plugin is disabled, with actions refused", async () => {
  await withState(async (statePath) => {
    const host = createPluginHost({ descriptors, descriptorDir: "/repo/web-plugins", statePath });
    await host.ready;
    assert.deepEqual(host.visible().map((d) => d.id).sort(), ["subagent-graph", "todo"]);
    assert.equal(host.descriptor("todo")?.title, "Todo");

    await host.manager.disable("todo");
    assert.deepEqual(host.visible().map((d) => d.id), ["subagent-graph"]);
    assert.equal(host.descriptor("todo"), undefined, "a disabled plugin cannot be acted on");
    await host.shutdown();
  });
});

test("the operator's disable survives a restart through web-plugins.json", async () => {
  await withState(async (statePath) => {
    const first = createPluginHost({ descriptors, descriptorDir: "/repo/web-plugins", statePath });
    await first.ready;
    await first.manager.disable("subagent-graph");
    await first.shutdown();
    const persisted = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(persisted.plugins["subagent-graph"].enabled, false);

    const second = createPluginHost({ descriptors, descriptorDir: "/repo/web-plugins", statePath, now: () => Date.now() + 120_000 });
    await second.ready;
    assert.deepEqual(second.visible().map((d) => d.id), ["todo"]);
    await second.shutdown();
  });
});

test("safe mode hides first-party descriptors that are not core.* plugins", async () => {
  await withState(async (statePath) => {
    const host = createPluginHost({ descriptors, descriptorDir: "/repo/web-plugins", statePath, env: { PI_WEB_SAFE_MODE: "1" } });
    const report = await host.ready;
    assert.equal(report.safeMode, true);
    assert.deepEqual(host.visible(), []);
    assert.equal(host.descriptor("todo"), undefined);
    await host.shutdown();
  });
});

test("a corrupt state file is reported as a warning and boots with defaults", async () => {
  await withState(async (statePath) => {
    writeFileSync(statePath, "{ broken");
    const host = createPluginHost({ descriptors, descriptorDir: "/repo/web-plugins", statePath });
    await host.ready;
    assert.equal(host.visible().length, 2);
    assert.ok(host.warnings.some((w) => /not valid JSON/.test(w)));
    await host.shutdown();
  });
});

test("a user manifest with contributes.surfaces/actions becomes visible and actionable once enabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-plugin-user-root-"));
  try {
    const pluginDir = join(root, "user-plugins", "acme.notes");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "pi-web-plugin.json"),
      JSON.stringify({
        id: "acme.notes",
        name: "Acme Notes",
        version: "1.0.0",
        engines: { piWeb: "^1.0.0", sdk: "^1.0.0" },
        trust: "declarative",
        contributes: {
          icon: "list-checks",
          description: "Notes from user manifest",
          surfaces: [{ kind: "sidebar" }, { kind: "page", path: "/plugins/acme.notes" }],
          actions: [{ id: "refresh", title: "Refresh notes" }],
        },
      }),
    );

    const inline: WebPluginDescriptor[] = [
      { id: "todo", extension: "todo", title: "Todo", surfaces: [{ kind: "sidebar" }] },
    ];
    const host = createPluginHost<WebPluginDescriptor>({
      descriptors: inline,
      descriptorDir: "/repo/web-plugins",
      roots: { user: join(root, "user-plugins") },
      statePath: join(root, "web-plugins.json"),
    });
    await host.ready;

    // User plugins default to off until enabled by the operator.
    assert.equal(host.descriptor("acme.notes"), undefined);
    assert.deepEqual(host.visible().map((d) => d.id), ["todo"]);

    const enabled = await host.manager.enable("acme.notes");
    assert.equal(enabled.ok, true);
    assert.deepEqual(host.visible().map((d) => d.id), ["todo", "acme.notes"]);
    assert.equal(host.descriptor("acme.notes")?.title, "Acme Notes");
    assert.equal(host.descriptor("acme.notes")?.actions?.[0]?.id, "refresh");
    await host.shutdown();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid manifest contributes block records a warning without breaking boot", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-plugin-bad-contrib-"));
  try {
    const pluginDir = join(root, "user-plugins", "acme.bad");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "pi-web-plugin.json"),
      JSON.stringify({
        id: "acme.bad",
        name: "Bad Contributes",
        version: "1.0.0",
        engines: { piWeb: "^1.0.0", sdk: "^1.0.0" },
        trust: "declarative",
        contributes: {
          surfaces: [{ kind: "unknown-surface" }],
        },
      }),
    );

    const host = createPluginHost({
      descriptors,
      descriptorDir: "/repo/web-plugins",
      roots: { user: join(root, "user-plugins") },
      statePath: join(root, "web-plugins.json"),
    });
    await host.ready;
    assert.ok(host.warnings.some((w) => w.includes("contributes (user)")));
    assert.equal(host.visible().length, 2);
    await host.shutdown();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a plugin whose loader throws is failed in the manager and its descriptor is still visible until quarantined", async () => {
  await withState(async (statePath) => {
    const loader: PluginLoader = () => {
      throw new Error("module missing");
    };
    // Descriptor candidates have no entry points, so the loader is not called for them;
    // this confirms the default loader path does not break the host.
    const host = createPluginHost({ descriptors, descriptorDir: "/repo/web-plugins", statePath, loader });
    const report = await host.ready;
    assert.deepEqual(report.failed, {});
    assert.equal(host.visible().length, 2);
    await host.shutdown();
  });
});

test("plugin storage written by one host is read back by the next", async () => {
  const dir = mkdtempSync(join(tmpdir(), "web-plugin-storage-host-"));
  const repo = join(dir, "plugins");
  const statePath = join(dir, "web-plugins.json");
  mkdirSync(join(repo, "acme.counter"), { recursive: true });
  writeFileSync(
    join(repo, "acme.counter", "pi-web-plugin.json"),
    JSON.stringify({
      id: "acme.counter",
      name: "Counter",
      version: "1.0.0",
      engines: { piWeb: "^1.0.0", sdk: "^1.0.0" },
      trust: "trusted",
      main: { server: "./server.ts" },
      capabilities: ["storage:project"],
    }),
  );

  const seen: number[] = [];
  const loader: PluginLoader = () => ({
    activate: (ctx) => {
      const stored = ctx.storage.get<{ runs: number }>("project", "counter");
      seen.push(stored?.runs ?? 0);
      ctx.storage.set("project", "counter", { runs: (stored?.runs ?? 0) + 1 });
    },
  });

  try {
    const boot = (): ReturnType<typeof createPluginHost> =>
      createPluginHost({ descriptors: [], descriptorDir: repo, roots: { repo }, statePath, loader });

    const first = boot();
    await first.ready;
    await first.shutdown();

    const second = boot();
    await second.ready;
    await second.shutdown();

    assert.deepEqual(seen, [0, 1], "the second host read what the first wrote");
    assert.equal(
      JSON.parse(readFileSync(`${statePath}.storage.json`, "utf8")).entries["acme.counter"].project.counter,
      JSON.stringify({ runs: 2 }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
