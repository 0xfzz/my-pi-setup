#!/usr/bin/env node
/**
 * lint-staged wrapper: run oxlint on the staged files that are ours.
 *
 * Paths outside the repo (the ".." filter below) are skipped. oxlint exits
 * non-zero when every path it is given is excluded ("No files found to
 * lint"), which is why the filtering happens before the run: a commit that
 * stages only outside paths passes, and any repo file is still fully gated.
 */
import { spawnSync } from "node:child_process";
import { relative } from "node:path";

// lint-staged hands the command absolute paths; the filter compares relative
// to the repo root either way.
const ours = process.argv
  .slice(2)
  .map((file) => relative(process.cwd(), file))
  .filter((file) => !file.startsWith(".."));

if (ours.length === 0) process.exit(0);

const result = spawnSync("npx", ["oxlint", "--deny-warnings", ...ours], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
