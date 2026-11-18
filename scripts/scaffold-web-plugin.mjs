#!/usr/bin/env node
/**
 * PL7: scaffold a complete, trusted plugin project into an existing empty
 * folder. The folder is never deleted or recreated (watcher safety).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const { scaffoldPluginProject } = await import(pathToFileURL(join(rootDir, "lib", "plugin-project.ts")).href);

const id = process.argv[2];
const target = resolve(process.argv[3] ?? id ?? ".");
if (id === undefined) {
  console.error("usage: node --experimental-strip-types scripts/scaffold-web-plugin.mjs <id> <dir>");
  process.exit(1);
}
const checkerPath = join(rootDir, "scripts", "check-web-plugin.mjs");
const result = scaffoldPluginProject(id, process.argv[4] ?? id, { checkerPath });
if (!result.ok) {
  console.error(result.error);
  process.exit(1);
}
for (const file of result.files) {
  const path = join(target, file.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, file.content, "utf8");
}
console.log(`scaffolded ${result.files.length} files into ${target}`);
