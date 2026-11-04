#!/usr/bin/env node
/**
 * lint-staged wrapper: run oxlint on the staged files that are ours.
 *
 * vendor/pi-web is upstream verbatim (see vendor/pi-web/VENDORED.md): its
 * warnings are upstream's and editing them away would break resync, so those
 * paths are skipped here. oxlint itself exits non-zero when every path it is
 * given is excluded ("No files found to lint"), which is why the filtering
 * happens before the run: a commit that stages only vendored files passes,
 * and any non-vendor staged file is still fully gated.
 */
import { spawnSync } from "node:child_process";
import { relative } from "node:path";

const VENDOR_PREFIX = "vendor/pi-web/";
// lint-staged hands the command absolute paths; the filter compares relative
// to the repo root so vendored files are recognised either way.
const ours = process.argv
  .slice(2)
  .map((file) => relative(process.cwd(), file))
  .filter((file) => !file.startsWith(VENDOR_PREFIX) && !file.startsWith(".."));

if (ours.length === 0) process.exit(0);

const result = spawnSync("npx", ["oxlint", "--deny-warnings", ...ours], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
