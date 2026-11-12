// Path and request policy for the Files server. The decisions here are pure —
// no filesystem access — so the symlink/traversal rules are unit-tested
// independently of any real file, while the I/O layer applies them.

import { isAbsolute, resolve } from "node:path";

export type RelPathResult =
  | { ok: true; rel: string }
  | { ok: false; error: string };

/**
 * Validate and normalise a root-relative request path. Rejects absolute paths,
 * drive letters, UNC shares, traversal, NULs and `%` (any percent survives into
 * a request meaning it may not have been decoded once — treat it as hostile).
 * Backslash is treated as a separator, so a Windows-style `..\..\x` cannot slip
 * through on a POSIX host.
 */
export function sanitizeRelPath(raw: string): RelPathResult {
  if (raw.includes("\0")) return { ok: false, error: "path contains a null byte" };
  if (raw.includes("%")) return { ok: false, error: "path contains a percent character" };
  if (raw === "") return { ok: true, rel: "" };
  if (isAbsolute(raw) || raw.startsWith("/") || raw.startsWith("\\") || /^[A-Za-z]:/.test(raw)) {
    return { ok: false, error: "absolute paths are not allowed" };
  }
  const segments = raw.split(/[\\/]+/);
  const kept: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return { ok: false, error: "path traversal is not allowed" };
    kept.push(segment);
  }
  return { ok: true, rel: kept.join("/") };
}

/** Resolve a validated relative path into a canonical absolute path under `root`. */
export function resolveWithinRoot(root: string, rel: string): string | null {
  const joined = resolve(root, rel === "" ? "." : rel);
  // Platform path semantics + containment, not a string-prefix check.
  if (joined !== root && !(root.endsWith("/") ? joined.startsWith(root) : joined.startsWith(`${root}/`))) {
    return null;
  }
  return joined;
}

/** A conservative cap on streamed downloads (200 MiB) for the local tool. */
export const DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;
/** A request with a bigger declared size is refused before any read. */
export const TEXT_TAIL_NOTICE = "File too large; showing the first portion.";