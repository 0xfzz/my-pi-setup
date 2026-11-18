import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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

test("host vendor entries contain no plugin UI", () => {
  const viewer = readFileSync(join(core, "client", "host", "file-viewer.ts"), "utf8");
  assert.doesNotMatch(viewer, /data-testid|DocumentViewer|VIEWER_STYLE|files-/);

  const icons = readFileSync(join(core, "client", "host", "icons.ts"), "utf8");
  assert.match(icons, /@phosphor-icons\/react/);
  assert.doesNotMatch(icons, /files-|router-|todo-/);
});
