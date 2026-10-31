import { canonicalize } from "../paths.ts";
import type { ScopeState } from "../types.ts";
import type { SandboxConfig, SandboxMode } from "./config.ts";

export const STANDARD_WRITABLE_DEVICES: readonly string[] = [
  "/dev/null",
  "/dev/zero",
  "/dev/full",
  "/dev/tty",
  "/dev/pts",
];

export interface SandboxPolicy {
  cwd: string;
  mode: SandboxMode;
  /** Paths allowed for write access (in order). */
  writable: readonly string[];
  /** Paths explicitly denied write access (e.g. sandbox.deny). */
  deny: readonly string[];
  /** Scratch directory path if active. */
  scratchDir?: string;
}

export interface SandboxPolicyOptions {
  scratchDir?: string;
}

/**
 * Derive the effective sandbox write policy from ScopeState and SandboxConfig.
 *
 * In "workspace" mode:
 *   writable = workspace (cwd)
 *            + roots where access == "rw"
 *            + devices (/dev/null, /dev/zero, /dev/full, /dev/tty, /dev/pts)
 *            + scratch directory (if active)
 *            + sandbox.allow
 *            - sandbox.deny
 *
 * In "readonly" mode:
 *   writable = devices + scratch + sandbox.allow - sandbox.deny
 *
 * In "off" mode:
 *   no sandboxing wrapper is applied.
 */
export function deriveSandboxPolicy(
  state: ScopeState,
  config: SandboxConfig,
  cwd: string,
  options: SandboxPolicyOptions = {},
): SandboxPolicy {
  const mode = config.mode;
  if (mode === "off") {
    return {
      cwd,
      mode: "off",
      writable: [],
      deny: [],
      scratchDir: options.scratchDir,
    };
  }

  const writable = new Set<string>();
  const deny = new Set<string>();

  for (const denied of config.deny) {
    deny.add(canonicalize(denied));
  }

  if (mode === "workspace") {
    const ws = canonicalize(cwd);
    if (!deny.has(ws)) writable.add(ws);

    for (const root of state.roots) {
      if (root.access === "rw") {
        const canonical = canonicalize(root.path);
        if (!deny.has(canonical)) writable.add(canonical);
      }
    }
  }

  for (const dev of STANDARD_WRITABLE_DEVICES) {
    if (!deny.has(dev)) writable.add(dev);
  }

  if (options.scratchDir) {
    const scratch = canonicalize(options.scratchDir);
    if (!deny.has(scratch)) writable.add(scratch);
  }

  for (const allowed of config.allow) {
    const canonical = canonicalize(allowed);
    if (!deny.has(canonical)) writable.add(canonical);
  }

  return {
    cwd,
    mode,
    writable: Array.from(writable),
    deny: Array.from(deny),
    scratchDir: options.scratchDir,
  };
}
