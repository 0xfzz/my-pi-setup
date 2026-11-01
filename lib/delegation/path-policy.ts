/**
 * path-policy.ts — the lexical path guard a reading child runs on shell tokens.
 *
 * `shell_read` re-quotes every argument of a read-only command, then asks this
 * module whether the path each token names is one the child may look at. Two
 * questions, in this order:
 *
 *   1. Is it inside parent control-plane state? Session sidecars, the registry
 *      and scratch live under `.pi/`; a child that could read them would see
 *      sibling scopes it is never told about.
 *   2. If the caller declared roots, is it inside one of them?
 *
 * Canonicalisation is lexical: `resolve()` collapses `..`, which is what stops
 * `../../.pi/agent/sessions/...` from being read under the guise of a relative
 * path. A symlink inside the repo can still point out; that is the stated limit
 * of a lexical guard, not an oversight — the OS-level boundary is the sandbox,
 * not this function.
 */
import { isAbsolute, relative, resolve } from "node:path";

export interface PathPolicyOptions {
  cwd: string;
  /** Allowed roots. Omitted or empty means "anywhere that is not denied". */
  roots?: readonly string[];
  /** Denied boundaries, checked first. */
  deny?: readonly string[];
}

function isInside(boundary: string, path: string): boolean {
  const rel = relative(resolve(boundary), path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Is `candidate` inside one of `roots` and not inside `deny`?
 *
 * Returns the refusal text, or undefined when the path is allowed.
 */
export function pathPolicyProblem(candidate: unknown, options: PathPolicyOptions): string | undefined {
  if (typeof candidate !== "string" || !candidate.trim()) return undefined;
  const path = resolve(resolve(options.cwd), candidate.trim());

  for (const denied of options.deny ?? []) {
    if (!denied) continue;
    if (isInside(denied, path)) {
      return `${candidate} is inside parent control-plane state and is not readable by a child agent`;
    }
  }

  const roots = (options.roots ?? []).map(root => resolve(root));
  if (!roots.length) return undefined;
  for (const root of roots) {
    if (isInside(root, path)) return undefined;
  }
  return `${candidate} is outside the child agent's permitted roots (${roots.join(", ")})`;
}
