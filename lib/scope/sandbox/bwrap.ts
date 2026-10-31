import { existsSync } from "node:fs";
import type { SandboxPolicy } from "./policy.ts";

export interface PlanBwrapOptions {
  extraFlags?: readonly string[];
}

/**
 * Build the bubblewrap (bwrap) argv for the given policy and command.
 *
 * Invariants maintained:
 * - No --unshare-pid: processes stay in host pidns (ps/kill work, servers survive call)
 * - No --unshare-net: network is untouched
 * - No --new-session: terminal and job control are preserved
 * - --ro-bind / / mounts root read-only
 * - --dev-bind /dev /dev comes after --ro-bind to keep /dev/null, /dev/pts, /dev/tty writable
 * - --cap-drop ALL prevents remounting inside the container
 * - --die-with-parent ensures child does not outlive pi
 */
export function planBwrap(
  policy: SandboxPolicy,
  command: string,
  env: Record<string, string> = {},
  options: PlanBwrapOptions = {},
): { argv: string[] } | { block: string } {
  if (policy.mode === "off") {
    return { argv: ["/bin/sh", "-c", command] };
  }

  const argv: string[] = [
    "bwrap",
    "--ro-bind", "/", "/",
    "--dev-bind", "/dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--cap-drop", "ALL",
    "--die-with-parent",
  ];

  if (policy.cwd && existsSync(policy.cwd)) {
    argv.push("--chdir", policy.cwd);
  }

  // Bind writable directories
  const bound = new Set<string>(["/dev", "/proc", "/tmp"]);

  if (policy.scratchDir) {
    argv.push("--bind", policy.scratchDir, policy.scratchDir);
    bound.add(policy.scratchDir);
  }

  for (const path of policy.writable) {
    if (bound.has(path) || path.startsWith("/dev/") || path === "/dev") continue;
    if (existsSync(path)) {
      argv.push("--bind", path, path);
      bound.add(path);
    }
  }

  // Denied subpaths inside writable areas are remounted read-only
  for (const denied of policy.deny) {
    if (existsSync(denied)) {
      argv.push("--ro-bind", denied, denied);
    }
  }

  // Set environment variables
  for (const [key, value] of Object.entries(env)) {
    argv.push("--setenv", key, value);
  }

  if (options.extraFlags) {
    argv.push(...options.extraFlags);
  }

  argv.push("--", "/bin/sh", "-c", command);

  return { argv };
}
