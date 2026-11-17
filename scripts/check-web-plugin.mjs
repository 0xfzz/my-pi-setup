#!/usr/bin/env node
/**
 * PL3/AC10: fail a plugin project that imports web/core internals, naming the
 * import. Usage: node --experimental-strip-types scripts/check-web-plugin.mjs <dir>
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const { checkPluginProject } = await import(pathToFileURL(join(rootDir, "lib", "plugin-project.ts")).href);
const project = resolve(process.argv[2] ?? ".");

function filesOf(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesOf(full, base));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      out.push({ path: relative(base, full).split("\\").join("/"), content: readFileSync(full, "utf8") });
    }
  }
  return out;
}

const violations = checkPluginProject(project, filesOf(project));
if (violations.length > 0) {
  for (const item of violations) console.error(`${item.file}:${item.line}: forbidden import "${item.specifier}"`);
  process.exit(1);
}
console.log("plugin import boundary OK");
