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
export function findLandlockBinary(): string | undefined {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const root = dirname(dirname(dirname(currentDir)));

  const candidates = [
    join(root, "lib", "nowrite-guard"),
    join(root, "crates", "nowrite-guard", "target", "release", "nowrite-guard"),
    "nowrite-guard",
  ];

  for (const candidate of candidates) {
    if (candidate === "nowrite-guard") {
      // Checked via PATH during probe
      continue;
    }
    if (existsSync(candidate)) {
      return candidate;
    }
  }

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
  _env: Record<string, string> = {},
): { argv: string[] } | { block: string } {
  if (policy.mode === "off") {
    return { argv: ["/bin/sh", "-c", command] };
  }

  const binary = findLandlockBinary() ?? "nowrite-guard";
  const argv: string[] = [binary];

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

  argv.push("--", "/bin/sh", "-c", command);

  return { argv };
}
