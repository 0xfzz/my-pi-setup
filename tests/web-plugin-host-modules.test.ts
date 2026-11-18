import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  FILE_VIEWER_ASSETS,
  HOST_MODULE_TABLE,
  HOST_MODULES,
  HOST_SPECIFIERS,
  WEB_PLUGINS,
  hostImportMap,
  hostPreloadUrls,
} from "../web/config/registry.config.ts";

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const configDir = new URL("../web/config/", import.meta.url);

test("registrations live in focused files under web/config", () => {
  assert.equal(existsSync(new URL("../web/registry.config.ts", import.meta.url)), false);

  assert.deepEqual(readdirSync(configDir).sort(), [
    "build.config.ts",
    "fixtures.config.ts",
    "host-modules.config.ts",
    "plugins.config.ts",
    "registry.config.ts",
    "viewer.config.ts",
  ]);

  const barrel = source("../web/config/registry.config.ts");
  for (const file of [
    "plugins.config.ts",
    "host-modules.config.ts",
    "viewer.config.ts",
    "build.config.ts",
    "fixtures.config.ts",
  ]) {
    assert.match(barrel, new RegExp(`export \\* from "\\./${file.replaceAll(".", "\\.")}";`));
  }
  assert.equal((barrel.match(/^export \* from /gm) ?? []).length, 5);

  assert.match(source("../web/config/plugins.config.ts"), /export const WEB_PLUGINS/);
  assert.match(source("../web/config/plugins.config.ts"), /export const WEB_PLUGIN_OPT_OUT/);
  assert.match(source("../web/config/host-modules.config.ts"), /const hostModuleTable/);
  assert.match(source("../web/config/host-modules.config.ts"), /export function hostImportMap/);
  assert.match(source("../web/config/viewer.config.ts"), /export const FILE_VIEWER_ASSETS/);
  assert.match(source("../web/config/build.config.ts"), /export const INITIAL_BUNDLE_BUDGETS/);
  assert.match(source("../web/config/fixtures.config.ts"), /export const WEB_TEST_FIXTURES/);
});

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

test("the shell preloads the host bundles needed before app.js runs", () => {
  const urls = hostPreloadUrls();
  for (const file of ["runtime.js", "ui.js", "typebox-host.js"]) {
    assert.ok(urls.includes(`/host/${file}`), `missing preload for ${file}`);
  }
  for (const url of ["/host/sdk.js", "/host/react.js", "/host/typebox.js"]) {
    assert.ok(urls.includes(url), `missing preload for ${url}`);
  }
  assert.equal(urls.some((url) => url.includes("viewer") || url.includes("icons")), false);
  assert.equal(new Set(urls).size, urls.length, "preloads must not fetch the same URL twice");

  const template = source("../web/core/client/index.html");
  assert.match(template, /<!-- PI_WEB_MODULE_PRELOAD -->/);
  assert.match(source("../web/build.mjs"), /hostPreloadUrls\(\)/);

  const built = source("../web/core/client/dist/index.html");
  for (const url of urls) {
    assert.ok(built.includes(`rel="modulepreload" href="${url}"`), `built shell missing ${url}`);
  }
});

test("browser-half discovery scans once without a redundant final pass", () => {
  const wrapper = source("../web/plugins/browser-halves.ts");
  assert.doesNotMatch(wrapper, /\.finally\(/);
  assert.doesNotMatch(wrapper, /runtime\.scan\(\)/);

  const discovery = source("../web/core/client/plugin-system/discovered-browser-halves.ts");
  assert.match(discovery, /registerBatch\(addDefinitions, \[\], \[\]/);
});

test("host modules and budgets are consumed by the build, not declared there", () => {
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

  const modules = source("../web/config/host-modules.config.ts");
  assert.match(modules, /bundle: "icons"/);
  assert.match(modules, /bundle: "file-viewer"/);

  const viewer = source("../web/config/viewer.config.ts");
  assert.doesNotMatch(viewer, /from "\.\.\/core\/client\/host\/file-viewer/);
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
    ' * Compatibility barrel. All registrations live in web/config/*.config.ts;',
    ' * this module only preserves the existing import path for consumers.',
    ' */',
    'export { WEB_PLUGINS, WEB_PLUGIN_OPT_OUT } from "../config/registry.config.ts";',
  ].join("\n"));

  const ids = WEB_PLUGINS.map((plugin) => plugin.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(WEB_PLUGINS.length > 0);
});
