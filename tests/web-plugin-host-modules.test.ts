import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  FILE_VIEWER_ASSETS,
  HOST_MODULE_TABLE,
  HOST_MODULES,
  HOST_SPECIFIERS,
  WEB_PLUGINS,
  hostImportMap,
} from "../web/registry.config.ts";

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

test("the browser import map is generated from the one web registry", () => {
  const template = source("../web/core/client/index.html");
  assert.match(template, /<!-- PI_WEB_IMPORT_MAP -->/);
  assert.equal(template.includes('type="importmap"'), false, "the HTML template must not hardcode browser specifiers");

  const build = source("../web/build.mjs");
  assert.match(build, /from "\.\/load-registry\.mjs"/);
  assert.match(build, /hostImportMap\(\)/);
  assert.doesNotMatch(build, /"react":\s*"\/host\//);

  const map = hostImportMap();
  assert.deepEqual(Object.keys(map).sort(), [...HOST_SPECIFIERS].sort());
  for (const [specifier, file] of Object.entries(HOST_MODULES)) {
    const expectedBase = HOST_MODULE_TABLE[specifier].base ?? "/host/";
    assert.equal(map[specifier], `${expectedBase}${file}`);
  }
  assert.equal(map["@pi-web/bridge"], "/host/sdk.js");
  assert.equal(map["@pi-web/host-ui"], "/host/ui.js");
  assert.equal(map.typebox, "/host/typebox.js");
  assert.equal(map["typebox/value"], "/host/typebox-value.js");
});

test("host modules and budgets are declared once and consumed by the build", () => {
  const registry = source("../web/registry.config.ts");
  assert.match(registry, /const hostModuleTable/);
  assert.match(registry, /export const INITIAL_BUNDLE_BUDGETS/);
  assert.doesNotMatch(registry, /from "\.\/plugin-host-specifiers/);

  for (const path of [
    "../web/build.mjs",
    "../web/build-plugin-halves.mjs",
    "../web/build-host-modules.mjs",
    "../web/bundle-budget.mjs",
  ]) {
    const text = source(path);
    assert.match(text, /registry|load-registry/, `${path} must read the single registry`);
    assert.doesNotMatch(text, /plugin-host-specifiers/);
  }

  const hostBuild = source("../web/build-host-modules.mjs");
  assert.match(hostBuild, /splitting:\s*true/);
  assert.doesNotMatch(hostBuild, /splitting:\s*false/);
  assert.match(hostBuild, /chunkNames:/);
  assert.match(hostBuild, /assertBundleWithinBudget/);
  assert.match(hostBuild, /for \(const name of Object\.keys\(HOST_BUNDLES\)\)/);

  const markdown = source("../web/core/client/plugin-system/markdown.tsx");
  assert.match(markdown, /import\("mermaid"\)/);
});

test("the shared runtime carries no icon catalogue, document viewer or plugin list", () => {
  const runtime = source("../web/core/client/host/runtime.ts");
  assert.doesNotMatch(runtime, /@phosphor-icons\/react/);
  assert.doesNotMatch(runtime, /@file-viewer\//);
  assert.match(runtime, /^  use,$/m);

  const config = source("../web/registry.config.ts");
  assert.match(config, /bundle: "icons"/);
  assert.match(config, /bundle: "file-viewer"/);
  assert.doesNotMatch(config, /from "\.\/core\/client\/host\/file-viewer/);
});

test("plugin UI owns the document viewer, its vendor and its asset path", () => {
  const viewer = source("../web/plugins/files/DocumentViewer.tsx");
  assert.doesNotMatch(viewer, /^import\s+FileViewer/m);
  assert.match(viewer, /import\("@file-viewer\/react"\)/);
  assert.match(viewer, /data-testid="files-document"/);
  assert.match(viewer, /FILE_VIEWER_ASSET_BASE_URL/);
  assert.doesNotMatch(viewer, /"\/file-viewer\/"/);

  const vendor = source("../web/plugins/files/vendor/file-viewer.ts");
  assert.match(vendor, /@file-viewer\/react/);
  assert.equal(
    existsSync(new URL("../web/core/client/host/file-viewer.ts", import.meta.url)),
    false,
    "core must not own a plugin viewer entry",
  );

  assert.equal(HOST_MODULES["@pi-web/document-viewer"], undefined);
  assert.equal(HOST_MODULES["@phosphor-icons/react"], "phosphor.js");
  assert.equal(hostImportMap()["@file-viewer/react"], "/plugins/files/file-viewer-react.js");
  assert.equal(FILE_VIEWER_ASSETS.baseUrl, "/plugins/files/file-viewer/");
  assert.equal(FILE_VIEWER_ASSETS.outdir, "plugins/files/file-viewer");
});

test("first-party descriptors are registered only in the config", () => {
  const barrel = source("../web/plugins/index.ts");
  assert.equal(barrel.trim(), [
    '/**',
    ' * Compatibility barrel. All registrations live in web/registry.config.ts;',
    ' * this module only preserves the existing import path for consumers.',
    ' */',
    'export { WEB_PLUGINS, WEB_PLUGIN_OPT_OUT } from "../registry.config.ts";',
  ].join("\n"));

  const ids = WEB_PLUGINS.map((plugin) => plugin.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(WEB_PLUGINS.length > 0);
});
