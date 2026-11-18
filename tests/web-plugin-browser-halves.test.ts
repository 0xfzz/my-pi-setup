import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginHost } from "../web/core/plugin-contracts/kernel/host.ts";

function pluginManifest(): Record<string, unknown> {
  return {
    id: "acme.panel",
    name: "Acme Panel",
    version: "1.2.3",
    engines: { piWeb: "^1.0.0", sdk: "^1.0.0" },
    trust: "trusted",
    main: { browser: "./dist/browser.js" },
    capabilities: ["ui.publish", "protocol.invoke:acme.panel.submit"],
    activation: ["onStartup"],
    bridge: { core: { messages: ["session.list", "session.events"] } },
  };
}

test("the migrated fixture is absent from client and server composition roots", () => {
  const roots = [
    "web/app.tsx",
    "web/server.ts",
    "web/plugins/browser-halves.ts",
    "web/plugins/pages.tsx",
  ];
  for (const root of roots) {
    const text = readFileSync(root, "utf8");
    assert.equal(text.includes("fixture.e2e"), false, `${root} must not import the migrated plugin id`);
    assert.equal(text.includes("fixture-e2e/browser"), false, `${root} must not import the migrated module`);
  }
});

test("the host exposes declared browser halves and core message slices from discovered manifests", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-plugin-browser-halves-"));
  try {
    const user = join(root, "user-plugins");
    const pluginDir = join(user, "acme.panel");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "pi-web-plugin.json"), JSON.stringify(pluginManifest()));

    const host = createPluginHost({
      descriptors: [],
      descriptorDir: join(root, "descriptors"),
      roots: { user },
      statePath: join(root, "state.json"),
    });
    await host.ready;
    try {
      assert.deepEqual(host.bridgeSlices.get("acme.panel"), ["session.list", "session.events"]);
      assert.equal(host.browserHalves.length, 1);
      const half = host.browserHalves[0];
      assert.equal(half.id, "acme.panel");
      assert.equal(half.sourcePath, "./dist/browser.js");
      assert.equal(half.source, "user");
      assert.deepEqual(half.capabilities, ["ui.publish", "protocol.invoke:acme.panel.submit"]);
      assert.equal(half.dir, pluginDir);
    } finally {
      await host.shutdown();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
