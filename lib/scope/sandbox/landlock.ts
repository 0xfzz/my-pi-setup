import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxPolicy } from "./policy.ts";

/**
 * Locate the compiled `nowrite-guard` binary:
 * 1. Adjacent in `lib/nowrite-guard`
 * 2. In `crates/nowrite-guard/target/release/nowrite-guard`
 * 3. On PATH
 */
/** Since `findLandlockBinary` falls back to a PATH lookup whose argv[0] the caller
 *  passes through untouched, the return type is always a concrete string. */
export function findLandlockBinary(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const root = dirname(dirname(dirname(currentDir)));

  const candidates = [
    join(root, "lib", "nowrite-guard"),
    join(root, "crates", "nowrite-guard", "target", "release", "nowrite-guard"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Checked via PATH during probe.
  return "nowrite-guard";
}

/**
 * Build the Landlock argv for the given policy and command.
 *
 * Invariants maintained:
 * - Only write access rights are handled (reads remain open without any allowlist)
 * - Writable paths and devices passed via `--rw <path>`
 * - Working directory passed via `--chdir <cwd>`
 * - Target command executed directly via `-- <command> [args...]`
 */
export function planLandlock(
  policy: SandboxPolicy,
  command: string,
  env: Record<string, string> = {},
): { argv: string[] } | { block: string } {
  if (policy.mode === "off") {
    return { argv: ["/bin/sh", "-c", command] };
  }

  const argv: string[] = [findLandlockBinary()];

  if (policy.cwd && existsSync(policy.cwd)) {
    argv.push("--chdir", policy.cwd);
  }

  if (policy.scratchDir) {
    argv.push("--rw", policy.scratchDir);
  }

  for (const path of policy.writable) {
    if (existsSync(path)) {
      argv.push("--rw", path);
    }
  }

  argv.push("--");

  // The helper execs the payload directly, so the env scrub must ride the
  // payload: `/usr/bin/env K=V … /bin/sh -c <command>`.
  argv.push(...envPrefix(env), "/bin/sh", "-c", command);

  return { argv };
}

/**
 * The argv prefix that applies `env` to the child command, via `/usr/bin/env`.
 * Empty when there is nothing to apply.
 */
export function envPrefix(env: Record<string, string>): string[] {
  const entries = Object.entries(env);
  if (!entries.length) return [];
  return ["/usr/bin/env", ...entries.map(([key, value]) => `${key}=${value}`)];
}
