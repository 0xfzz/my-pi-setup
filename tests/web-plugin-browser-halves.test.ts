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
  const firstPartyIds = ["files", "artifacts", "router", "web-bridge", "mcp-manager", "core.plugin-manager"];
  for (const root of roots) {
    const text = readFileSync(root, "utf8");
    for (const id of firstPartyIds) {
      assert.equal(text.includes(`"${id}"`), false, `${root} must not statically register ${id}`);
    }
    assert.doesNotMatch(text, /registerPluginPanel|registerPluginPage/, `${root} must not register plugin UI`);
  }
  for (const root of roots) {
    const text = readFileSync(root, "utf8");
    assert.equal(text.includes("fixture.e2e"), false, `${root} must not import the migrated plugin id`);
    assert.equal(text.includes("fixture-e2e/browser"), false, `${root} must not import the migrated module`);
  }
});

test("every first-party browser UI ships from its own manifest", () => {
  const plugins = [
    "files",
    "artifacts",
    "router",
    "web-bridge",
    "plugin-manager",
    "mcp-manager",
  ];
  for (const dir of plugins) {
    const manifest = JSON.parse(readFileSync(`web/plugins/${dir}/pi-web-plugin.json`, "utf8")) as Record<string, any>;
    assert.equal(manifest.main.browser, "./dist/browser.js", `${dir} must ship a bundled browser half`);
    assert.equal(manifest.trust, "trusted", `${dir} must declare trusted browser code`);
    assert.ok(manifest.contributes, `${dir} must contribute its descriptor from the manifest`);

    const entry = readFileSync(`web/plugins/${dir}/browser/index.ts`, "utf8");
    assert.match(entry, /from "@pi-web\/bridge"/, `${dir} must use the SDK context`);
    assert.match(entry, /from "@pi-web\/host-ui"/, `${dir} must use the shared host UI`);
    if (dir === "web-bridge") {
      // The bridge owns a DOM surface and publishes views through ctx.register;
      // it does not claim a panel or page slot in the host shell.
      assert.match(entry, /ctx\.register\(/, `${dir} must register its own views`);
      assert.match(entry, /root\.unmount\(/, `${dir} must clean up its React root`);
    } else {
      assert.match(entry, /registerPlugin(Panel|Page)/, `${dir} must register its own UI`);
      assert.match(entry, /unregisterPlugin(Panel|Page)/, `${dir} must clean up its UI`);
    }
    assert.doesNotMatch(entry, /from "\.\.\/\.\.\/\.\.\/core\//, `${dir} must not import core source`);
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
