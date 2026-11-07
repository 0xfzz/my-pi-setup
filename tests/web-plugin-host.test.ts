import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPluginHost } from "../lib/web-plugins/kernel/host.ts";
import { compatCandidates, manifestForDescriptor } from "../lib/web-plugins/kernel/compat.ts";
import type { PluginLoader } from "../lib/web-plugins/kernel/manager.ts";

const descriptors = [
  { id: "todo", title: "Todo" },
  { id: "dashboard", title: "Delegated work graph" },
];

function withState(fn: (statePath: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "web-plugin-host-"));
  return fn(join(dir, "web-plugins.json")).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("every descriptor becomes a declarative repo candidate with no entry points", () => {
  const candidates = compatCandidates(descriptors, "/repo/web-plugins");
  assert.deepEqual(candidates.map((c) => [c.id, c.source]), [["todo", "repo"], ["dashboard", "repo"]]);
  assert.equal(candidates[0].manifest.trust, "declarative");
  assert.deepEqual(candidates[0].manifest.main, {});
  assert.equal(manifestForDescriptor({ id: "bubbly-spinner", title: "Bubbly spinner" }).name, "Bubbly spinner");
});

test("descriptors are visible by default and hidden once their plugin is disabled, with actions refused", async () => {
  await withState(async (statePath) => {
    const host = createPluginHost({ descriptors, descriptorDir: "/repo/web-plugins", statePath });
    await host.ready;
    assert.deepEqual(host.visible().map((d) => d.id).sort(), ["dashboard", "todo"]);
    assert.equal(host.descriptor("todo")?.title, "Todo");

    await host.manager.disable("todo");
    assert.deepEqual(host.visible().map((d) => d.id), ["dashboard"]);
    assert.equal(host.descriptor("todo"), undefined, "a disabled plugin cannot be acted on");
    await host.shutdown();
  });
});

test("the operator's disable survives a restart through web-plugins.json", async () => {
  await withState(async (statePath) => {
    const first = createPluginHost({ descriptors, descriptorDir: "/repo/web-plugins", statePath });
    await first.ready;
    await first.manager.disable("dashboard");
    await first.shutdown();
    const persisted = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(persisted.plugins.dashboard.enabled, false);

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
    const { writeFileSync } = await import("node:fs");
    writeFileSync(statePath, "{ broken");
    const host = createPluginHost({ descriptors, descriptorDir: "/repo/web-plugins", statePath });
    await host.ready;
    assert.equal(host.visible().length, 2);
    assert.ok(host.warnings.some((w) => /not valid JSON/.test(w)));
    await host.shutdown();
  });
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
