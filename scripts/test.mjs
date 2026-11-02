#!/usr/bin/env node
/**
 * Test runner: one entry point, selectable tiers, bounded by a timeout.
 *
 * Why this exists: `node --test <glob>` over ~110 files set no per-test
 * deadline, so one hung server/SSE/real-Pi test could stall the whole gate
 * indefinitely. This keeps the same suite as the source of truth while letting
 * a local run take the fast majority, CI shard the rest, or a change run only
 * the tests it can affect.
 *
 * Usage: node scripts/test.mjs <unit|integration|delegation|core|all|changed> [node --test flags]
 */
import { spawn, execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, basename, extname, sep } from "node:path";

const ROOT = process.cwd();
const TESTS = join(ROOT, "tests");
const TIERS_FILE = join(TESTS, "tiers.json");
const DEFAULT_TIMEOUT_MS = 30_000;

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
};

const allTests = walk(TESTS).sort();
const rel = (file) => relative(ROOT, file).split(sep).join("/");

const tiers = existsSync(TIERS_FILE) ? JSON.parse(readFileSync(TIERS_FILE, "utf8")) : {};
const integration = new Set((tiers.integration ?? []).map((p) => p.split(sep).join("/")));

const tier = process.argv[2] ?? "all";
const extra = process.argv.slice(3);

const git = (args) => {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const changedFiles = () => [
  ...new Set([
    ...git(["diff", "--name-only", process.env.TEST_CHANGED_BASE ?? "HEAD"]),
    ...git(["diff", "--name-only", "--cached"]),
    ...git(["ls-files", "--others", "--exclude-standard"]),
  ]),
];

const sourceCache = new Map();
const sourceOf = (testRel) => {
  if (!sourceCache.has(testRel)) sourceCache.set(testRel, readFileSync(join(ROOT, testRel), "utf8"));
  return sourceCache.get(testRel);
};

const selectChanged = () => {
  const files = changedFiles();
  if (!files.length) return allTests;
  const picked = new Set();
  let shared = false;
  for (const file of files) {
    if (file.endsWith(".test.ts") && allTests.some((t) => rel(t) === file)) {
      picked.add(file);
      continue;
    }
    if (!/\.(ts|mjs|js)$/.test(file)) continue;
    const token = basename(file, extname(file));
    if (token.length < 3) continue;
    let matchedHere = 0;
    for (const test of allTests) {
      if (sourceOf(rel(test)).includes(token)) {
        picked.add(rel(test));
        matchedHere++;
      }
    }
    // A shared module with no obvious test must not select zero tests.
    if (!matchedHere && (file.startsWith("lib/") || file.startsWith("extensions/"))) shared = true;
  }
  if (!picked.size || shared) return allTests.filter((t) => !integration.has(rel(t)));
  return allTests.filter((t) => picked.has(rel(t)));
};

const selected =
  tier === "unit" ? allTests.filter((t) => !integration.has(rel(t)))
  : tier === "integration" ? allTests.filter((t) => integration.has(rel(t)))
  : tier === "delegation" ? allTests.filter((t) => rel(t).startsWith("tests/delegation/"))
  : tier === "core" ? allTests.filter((t) => !rel(t).startsWith("tests/delegation/"))
  : tier === "changed" ? selectChanged()
  : tier === "all" ? allTests
  : undefined;

if (!selected) {
  console.error(`Unknown tier "${tier}". Use unit, integration, delegation, core, all, or changed.`);
  process.exit(2);
}
if (!selected.length) {
  console.error(`Tier "${tier}" selected no test files.`);
  process.exit(2);
}

const timeout = process.env.TEST_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS);
const nodeArgs = [
  "--experimental-strip-types",
  "--import", "./tests/isolate-env.mjs",
  "--test",
  `--test-timeout=${timeout}`,
  // A finished test file must not hold the run open. Some suites leave a
  // watcher or timer behind (e.g. delegation/rework-spawn), which used to stall
  // the whole suite past its budget even though every assertion had passed.
  "--test-force-exit",
  ...extra,
  ...selected,
];

console.error(
  `[test:${tier}] ${selected.length} file(s), timeout ${timeout}ms` +
  (extra.length ? `, extra ${extra.join(" ")}` : ""),
);

const child = spawn(process.execPath, nodeArgs, { cwd: ROOT, stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
