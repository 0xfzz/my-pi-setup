import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HOST_MODULES, HOST_SPECIFIERS, hostImportMap } from "../web/plugin-host-specifiers.mjs";

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

test("the browser import map is generated from the host module registry", () => {
  const template = source("../web/core/client/index.html");
  assert.match(template, /<!-- PI_WEB_IMPORT_MAP -->/);
  assert.equal(template.includes('type="importmap"'), false, "the HTML template must not hardcode browser specifiers");

  const build = source("../web/build.mjs");
  assert.match(build, /hostImportMap\(\)/);
  assert.doesNotMatch(build, /"react":\s*"\/host\//);

  const map = hostImportMap();
  assert.deepEqual(Object.keys(map).sort(), [...HOST_SPECIFIERS].sort());
  for (const [specifier, file] of Object.entries(HOST_MODULES)) {
    assert.equal(map[specifier], `/host/${file}`);
  }
  assert.equal(map["@pi-web/bridge"], "/host/sdk.js");
  assert.equal(map["@pi-web/host-ui"], "/host/ui.js");
});

test("host UI keeps lazy imports out of the entry bundle", () => {
  const build = source("../web/build-host-modules.mjs");
  assert.match(build, /splitting:\s*true/);
  assert.doesNotMatch(build, /splitting:\s*false/);
  assert.match(build, /chunkNames:/);
  assert.match(build, /assertBundleWithinBudget/);

  const markdown = source("../web/core/client/plugin-system/markdown.tsx");
  assert.match(markdown, /import\("mermaid"\)/);
});

test("the shared runtime carries no icon catalogue or document viewer", () => {
  const runtime = source("../web/core/client/host/runtime.ts");
  assert.doesNotMatch(runtime, /@phosphor-icons\/react/);
  assert.doesNotMatch(runtime, /@file-viewer\//);

  const build = source("../web/build-host-modules.mjs");
  assert.match(build, /buildEntry\("icons", "icons\.ts"\)/);
  assert.match(build, /buildEntry\(\s*"file-viewer"/s);

  for (const path of [
    "../web/build.mjs",
    "../web/build-plugin-halves.mjs",
    "../web/build-host-modules.mjs",
  ]) {
    assert.match(source(path), /FIRST_PARTY_EXTERNALS/);
  }
});

test("plugin UI owns the document viewer and loads the vendor lazily", () => {
  const viewer = source("../web/plugins/files/DocumentViewer.tsx");
  assert.doesNotMatch(viewer, /^import\s+FileViewer/m);
  assert.match(viewer, /import\("@file-viewer\/react"\)/);
  assert.match(viewer, /data-testid="files-document"/);

  assert.equal(HOST_MODULES["@pi-web/document-viewer"], undefined);
  assert.equal(HOST_MODULES["@phosphor-icons/react"], "phosphor.js");
});
