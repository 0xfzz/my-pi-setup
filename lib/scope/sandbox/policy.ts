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

/**
 * What the armed sandbox can and cannot write.
 *
 * The gate consumes exactly this list, so "the gate says allow" and "the kernel
 * says allow" cannot disagree. Their disagreement is what made a refusal answer
 * "retry the command" when the retry was guaranteed to fail again.
 */
export interface SandboxBoundary {
  /** Canonical paths allowed for write access (in order). */
  writable: readonly string[];
  /** Paths explicitly denied write access (e.g. sandbox.deny). */
  deny: readonly string[];
}

export interface SandboxPolicy extends SandboxBoundary {
  cwd: string;
  mode: SandboxMode;
  /** Scratch directory path if active. */
  scratchDir?: string;
}

export interface SandboxPolicyOptions {
  scratchDir?: string;
  /**
   * One-shot paths a refusal answer just approved, applied to the next bash wrap
   * only. `deny` still wins, and nothing is persisted: a one-shot grant must not
   * become a standing one.
   */
  extraWritable?: readonly string[];
}

/** Is `target` inside `entry` (or equal to it)? Lexical, canonical inputs. */
export function coveredBy(target: string, entry: string): boolean {
  if (!entry) return false;
  const dir = entry.endsWith("/") ? entry : `${entry}/`;
  return target === entry || target.startsWith(dir);
}

/** Does any deny entry cover the path? */
export function denyCovers(deny: readonly string[], target: string): boolean {
  return deny.some(entry => coveredBy(target, entry));
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
 *            + one-shot refusal grants
 *            - sandbox.deny
 *
 * In "readonly" mode:
 *   writable = devices + scratch + sandbox.allow + one-shot grants - sandbox.deny
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

  const deny = config.deny.map(entry => canonicalize(entry));
  const writable = new Set<string>();
  const add = (path: string): void => {
    const canonical = canonicalize(path);
    if (!denyCovers(deny, canonical)) writable.add(canonical);
  };

  if (mode === "workspace") {
    add(cwd);
    for (const root of state.roots) {
      if (root.access === "rw") add(root.path);
    }
  }

  for (const dev of STANDARD_WRITABLE_DEVICES) add(dev);
  if (options.scratchDir) add(options.scratchDir);
  for (const allowed of config.allow) add(allowed);
  for (const extra of options.extraWritable ?? []) add(extra);

  return {
    cwd,
    mode,
    writable: Array.from(writable),
    deny,
    scratchDir: options.scratchDir,
  };
}
