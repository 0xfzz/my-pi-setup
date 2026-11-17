#!/usr/bin/env node
/**
 * Regenerates docs/bridge-protocol-parity.md from the parity baseline.
 * With `--check` it exits non-zero when the committed doc is stale.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "docs", "bridge-protocol-parity.md");
const parity = await import(pathToFileURL(join(root, "web", "core", "protocol", "parity.ts")).href);
const next = parity.parityMarkdown();

if (process.argv.includes("--check")) {
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (current !== next) {
    console.error("docs/bridge-protocol-parity.md is stale; run: node --experimental-strip-types scripts/gen-bridge-parity.mjs");
    process.exit(1);
  }
  console.log("docs/bridge-protocol-parity.md is up to date");
} else {
  writeFileSync(target, next);
  console.log(`wrote ${target}`);
}
