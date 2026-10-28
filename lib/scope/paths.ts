/**
 * Path normalization and containment for the access-scope gate.
 *
 * Two rules drive this file:
 *
 * 1. **The workspace is the default scope.** A path is internal when it is inside
 *    a granted root. Unlike opencode there is no automatic widening to the git
 *    worktree: a repo nested under a superproject is not implicitly in scope.
 * 2. **Judge the target, not the spelling.** `/repo/link -> /etc` is external, so
 *    containment is re-checked against `realpath` whenever the lexical answer is
 *    "outside". Only existing components are resolved; the rest is appended, so a
 *    write to a not-yet-created file still classifies correctly.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isUnsafeRoot, type ScopeAccess, type ScopeRoot, type ScopeSuggestion } from "./types.ts";

/** Expand `~`, `~/…`, `$HOME` and `%USERPROFILE%` at the start of a pattern/path. */
export function expandHome(input: string, home = process.env.HOME ?? process.env.USERPROFILE): string {
  const value = input.trim();
  if (!home) return value;
  if (value === "~" || value === "$HOME" || value === "%USERPROFILE%") return home;
  for (const prefix of ["~/", "~\\", "$HOME/", "$HOME\\", "%USERPROFILE%/", "%USERPROFILE%\\"]) {
    if (value.startsWith(prefix)) return join(home, value.slice(prefix.length));
  }
  return value;
}

/** Resource spelling used by rules and the dialog: forward slashes, no trailing `/`. */
export function toResourceSlash(input: string): string {
  const slashed = input.replace(/\\/g, "/");
  return slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
}

/** Is `target` inside `root` (or equal to it)? Lexical test, no IO. */
export function lexicalInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Resolve symlinks for the part of the path that exists.
 *
 * Returns the input resolved against `realpath` of its deepest existing ancestor,
 * so `mkdir`-style paths that do not exist yet keep their suffix intact.
 */
export function canonicalize(input: string, realpath: (path: string) => string = realpathSync): string {
  const absolute = resolve(input);
  let current = absolute;
  const suffix: string[] = [];
  for (;;) {
    try {
      return join(realpath(current), ...suffix.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      suffix.push(basename(current));
      current = parent;
    }
  }
}

export interface ClassifiedPath {
  absolute: string;
  /** Workspace-relative resource for internal paths, absolute for external. */
  resource: string;
  external: boolean;
  root?: ScopeRoot;
}

/**
 * Classify one path against the roots.
 *
 * The lexical pass decides the common case cheaply; the canonical pass only runs
 * when the lexical answer is "outside", because a symlink inside the workspace
 * pointing out is exactly the case a lexical-only check gets wrong.
 */
export function classifyPath(
  cwd: string,
  roots: readonly ScopeRoot[],
  input: string,
  options: { home?: string; realpath?: (path: string) => string } = {},
): ClassifiedPath {
  const expanded = expandHome(input, options.home);
  const absolute = resolve(cwd, expanded);
  // Always canonicalize: the expensive-looking case is the *internal* spelling of
  // an external target (`link/passwd`), and a lexical-only fast path judged that
  // as inside the workspace. One realpath per claim is cheaper than the hole.
  const canonical = canonicalize(absolute, options.realpath);
  const root = rootFor(roots, canonical);
  if (!root) return { absolute: canonical, resource: toResourceSlash(canonical), external: true };
  return describe(cwd, canonical, root);
}

function rootFor(roots: readonly ScopeRoot[], absolute: string): ScopeRoot | undefined {
  // Longest match wins, so a nested rw root inside a ro root upgrades only itself.
  let best: ScopeRoot | undefined;
  for (const root of roots) {
    if (!lexicalInside(root.path, absolute)) continue;
    if (!best || root.path.length > best.path.length) best = root;
  }
  return best;
}

function describe(cwd: string, absolute: string, root: ScopeRoot): ClassifiedPath {
  const rel = toResourceSlash(relative(root.path, absolute) || ".");
  // Resources stay relative to the session cwd while inside it, so rules written
  // as `src/**` keep meaning the same thing after a root is added.
  const resource = lexicalInside(cwd, absolute) ? toResourceSlash(relative(cwd, absolute) || ".") : rel;
  return { absolute, resource, external: false, root };
}

/**
 * The narrowest useful grant for a path, never wider than what was asked for.
 *
 * A dialog answer of "allow this folder" must not become `$HOME`, `/`, a drive
 * root, or an ancestor of the workspace — that is how opencode's `save` patterns
 * turned one approval into a standing home-directory grant. Those cases degrade
 * to an exact-file grant instead.
 */
export function suggestGrant(
  absolute: string,
  options: { cwd: string; home?: string; kind: "file" | "directory" | "unknown"; access: ScopeAccess },
): ScopeSuggestion {
  const directory = options.kind === "directory" ? absolute : dirname(absolute);
  // Refuse a directory that contains the workspace itself (`/home/u` for a
  // project at `/home/u/app`): that would re-expose every sibling project and
  // the user's own dotfiles from a single "allow this folder".
  const unsafe = isUnsafeRoot(directory, options.home) || lexicalInside(directory, options.cwd);
  if (unsafe) {
    return { path: absolute, access: options.access, glob: toResourceSlash(absolute), exact: true };
  }
  return {
    path: directory,
    access: options.access,
    glob: toResourceSlash(`${directory}${sep}*`),
    exact: false,
  };
}
