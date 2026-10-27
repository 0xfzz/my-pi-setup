/**
 * page-cache.ts — a web cache that lives only in scratch.
 *
 * The cache exists so a reviewer can re-read a page it already fetched without a
 * second network call. It is deliberately boring: one JSON file per URL under the
 * scratch web cache, a 10-minute TTL, a byte cap, and no path outside the scratch
 * root. Deleting the scratch directory is always safe, and nothing here can touch
 * the repository.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureScratch, scratchPathProblem, SCRATCH_CACHE_TTL_MS } from "./scratch.ts";

export interface PageCacheEntry {
  url: string;
  text: string;
  fetchedAt: number;
}

export const PAGE_CACHE_MAX_BYTES = 512 * 1024;

function keyOf(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

/** `<scratch>/cache/web/<hash>.json`; relative so the guard can check it. */
export function pageCacheRelativePath(url: string): string {
  return join("cache", "web", `${keyOf(url)}.json`);
}

export function readPageCache(
  root: string,
  url: string,
  options: { now?: number; ttlMs?: number } = {},
): PageCacheEntry | undefined {
  const relative = pageCacheRelativePath(url);
  if (scratchPathProblem(relative, root)) return undefined;
  const path = join(root, relative);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PageCacheEntry;
    // A tampered or colliding entry must not answer for another URL.
    if (parsed?.url !== url || typeof parsed.text !== "string") return undefined;
    // `fetchedAt` is the cache's own clock; mtime is only a fallback for an entry
    // written by an older build. Using mtime alone made TTL depend on the filesystem.
    const fetchedAt = Number.isFinite(parsed.fetchedAt) ? parsed.fetchedAt : statSync(path).mtimeMs;
    const age = (options.now ?? Date.now()) - fetchedAt;
    if (age > (options.ttlMs ?? SCRATCH_CACHE_TTL_MS)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function writePageCache(
  root: string,
  url: string,
  text: string,
  options: { now?: number; maxBytes?: number } = {},
): boolean {
  const relative = pageCacheRelativePath(url);
  if (scratchPathProblem(relative, root)) return false;
  const maxBytes = options.maxBytes ?? PAGE_CACHE_MAX_BYTES;
  if (Buffer.byteLength(text, "utf8") > maxBytes) return false;
  try {
    ensureScratch(root);
    const entry: PageCacheEntry = { url, text, fetchedAt: options.now ?? Date.now() };
    writeFileSync(join(root, relative), JSON.stringify(entry), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
