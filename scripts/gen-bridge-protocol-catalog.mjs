#!/usr/bin/env node
/**
 * Regenerates docs/bridge-protocol-catalog.md from the protocol message table.
 * With `--check` it exits non-zero when the committed doc is stale.
 *
 * Usage: node --experimental-strip-types scripts/gen-bridge-protocol-catalog.mjs [--check]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "docs", "bridge-protocol-catalog.md");
const catalog = await import(pathToFileURL(join(root, "web", "core", "protocol", "catalog.ts")).href);
const next = catalog.catalogMarkdown();

if (process.argv.includes("--check")) {
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (current !== next) {
    console.error("docs/bridge-protocol-catalog.md is stale; run: node --experimental-strip-types scripts/gen-bridge-protocol-catalog.mjs");
    process.exit(1);
  }
  console.log("docs/bridge-protocol-catalog.md is up to date");
} else {
  writeFileSync(target, next);
  console.log(`wrote ${target}`);
}
