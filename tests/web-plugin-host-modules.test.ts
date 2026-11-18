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

  const markdown = source("../web/core/client/plugin-system/markdown.tsx");
  assert.match(markdown, /import\("mermaid"\)/);
});
