import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const core = join(root, "web", "core");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return [path];
  });
}

const productionSources = walk(core)
  .filter((path) => /\.(ts|tsx|css)$/.test(path))
  .filter((path) => !path.includes(".test.") && !path.includes(`${join("core", "e2e")}`))
  .map((path) => ({ path: relative(root, path), text: readFileSync(path, "utf8") }));

const pluginSources = walk(join(root, "web", "plugins"))
  .filter((path) => /\.(ts|tsx)$/.test(path))
  .filter((path) => !path.includes(".test.") && !path.includes(`${join("plugins", "subagent-graph", "app")}`))
  .map((path) => ({ path: relative(root, path), text: readFileSync(path, "utf8") }));

test("core production sources never import plugin modules", () => {
  const offenders: string[] = [];
  for (const { path, text } of productionSources) {
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      if (/(?:^|\/)plugins\//.test(match[1])) offenders.push(`${path}: ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("core client owns no plugin-styled class names", () => {
  const offenders: string[] = [];
  for (const { path, text } of productionSources) {
    if (!path.includes("web/core/client")) continue;
    for (const match of text.matchAll(/\b(?:files|artifacts|router|todo|cache)-[a-z-]+/g)) {
      offenders.push(`${path}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("core production sources declare no plugin registrations or fixtures", () => {
  const forbidden = [
    "WEB_PLUGINS",
    "WEB_PLUGIN_OPT_OUT",
    "WEB_TEST_FIXTURES",
    "HOST_MODULES",
    "HOST_BUNDLES",
    "INITIAL_BUNDLE_BUDGETS",
    "FILE_VIEWER_ASSETS",
    "FILE_VIEWER_MODULE_BASE",
    "seedPluginFixtures",
    "registerFixtureSession",
    "PI_WEB_TEST_PLUGIN_VIEWS",
    "PI_WEB_TEST_FILES_ROOT",
    "__test_session__",
  ];
  const offenders: string[] = [];
  for (const { path, text } of productionSources) {
    for (const token of forbidden) {
      if (text.includes(token)) offenders.push(`${path}: ${token}`);
    }
  }
  assert.deepEqual(offenders, []);
  assert.equal(existsSync(join(core, "server", "plugin-fixtures.ts")), false);
});

test("plugin sources use the public host UI, not core internals", () => {
  const offenders: string[] = [];
  for (const { path, text } of pluginSources) {
    if (path.endsWith("browser-halves.ts")) continue; // composition root, not a plugin half
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      if (match[1].includes("core/client")) offenders.push(`${path}: ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("core host entries contain no plugin vendor or UI", () => {
  assert.equal(existsSync(join(core, "client", "host", "file-viewer.ts")), false);

  const viewer = readFileSync(join(root, "web", "plugins", "files", "vendor", "file-viewer.ts"), "utf8");
  assert.match(viewer, /@file-viewer\/react/);
  assert.doesNotMatch(viewer, /data-testid|DocumentViewer|VIEWER_STYLE|files-/);

  const icons = readFileSync(join(core, "client", "host", "icons.ts"), "utf8");
  assert.match(icons, /@phosphor-icons\/react/);
  assert.doesNotMatch(icons, /files-|router-|todo-/);

  const typebox = readFileSync(join(core, "client", "host", "typebox.ts"), "utf8");
  assert.match(typebox, /from "typebox"/);
  assert.match(typebox, /from "typebox\/value"/);
});
