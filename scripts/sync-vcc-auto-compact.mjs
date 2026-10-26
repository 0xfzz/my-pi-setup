#!/usr/bin/env node
/**
 * Mirror the canonical VCC auto-compaction source into the Pi agent directory.
 *
 * Layout (repo -> agent):
 *   vcc/auto-compact.ts      -> <agent>/extensions/auto-compact.ts
 *   lib/vcc/*.ts             -> <agent>/extensions/lib/vcc/*.ts
 *
 * The deployed copy is the single live instance. Adding this extension to the
 * package's `pi.extensions` would register a second controller, so the script
 * refuses to run in that state.
 *
 * Usage:
 *   node scripts/sync-vcc-auto-compact.mjs            # write
 *   node scripts/sync-vcc-auto-compact.mjs --check    # verify only, exit 1 on drift
 *   node scripts/sync-vcc-auto-compact.mjs --dry-run  # show plan
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const extensionsDir = join(agentDir, "extensions");
const libDest = join(extensionsDir, "lib", "vcc");

const args = new Set(process.argv.slice(2));
const check = args.has("--check");
const dryRun = args.has("--dry-run");

/** Collect `source -> destination` pairs. */
async function plan() {
  const pairs = [];
  pairs.push([join(root, "vcc", "auto-compact.ts"), join(extensionsDir, "auto-compact.ts")]);
  const libSrc = join(root, "lib", "vcc");
  for (const file of await readdir(libSrc)) {
    if (!file.endsWith(".ts")) continue;
    pairs.push([join(libSrc, file), join(libDest, file)]);
  }
  return pairs;
}

/** Fail loudly if the package also loads a second compaction controller. */
async function assertSingleInstance() {
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    const entries = pkg?.pi?.extensions ?? [];
    const duplicate = entries.find(
      (entry) => typeof entry === "string" && /auto-compact/.test(entry),
    );
    if (duplicate) {
      throw new Error(
        `package.json lists "${duplicate}" in pi.extensions. That would register a second ` +
          `compaction controller next to the deployed copy. Remove it before syncing.`,
      );
    }
  }
}

const pairs = await plan();
await assertSingleInstance();

let drift = 0;
let written = 0;

for (const [source, target] of pairs) {
  const label = relative(root, source);
  const destination = relative(agentDir, target);
  let existing;
  try {
    existing = await readFile(target, "utf8");
  } catch {
    existing = undefined;
  }
  const desired = await readFile(source, "utf8");
  const same = existing === desired;
  if (same) {
    if (!check && !dryRun) process.stdout.write(`unchanged  ${label} -> ${destination}\n`);
    continue;
  }
  if (check) {
    drift++;
    process.stdout.write(`drift      ${label} -> ${destination}\n`);
    continue;
  }
  if (dryRun) {
    process.stdout.write(`would copy ${label} -> ${destination}\n`);
    continue;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, desired, "utf8");
  written++;
  process.stdout.write(`copied     ${label} -> ${destination}\n`);
}

if (check) {
  if (drift > 0) {
    console.error(
      `\n${drift} file(s) drifted from the canonical source. ` +
        `Run: node scripts/sync-vcc-auto-compact.mjs`,
    );
    process.exit(1);
  }
  process.stdout.write("deployed copy matches the canonical source\n");
} else if (!dryRun) {
  process.stdout.write(`\ndone: ${written} file(s) written, ${pairs.length} checked\n`);
}
