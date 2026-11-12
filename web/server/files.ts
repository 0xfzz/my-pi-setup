// Session-scoped Files server: lists, reads and streams files inside a
// session's project directory. Every request resolves the root from the
// session id and re-validates the path server-side; the client never supplies
// an absolute root. Symlink traversal is rejected, reads are size-capped, and
// downloads honor Range for native media while forcing attachment for
// executable-ish content (HTML/SVG).

import { constants, createReadStream } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";
import {
  classifyFile,
  mimeTypeFor,
  MAX_DIR_ENTRIES,
  MAX_SEARCH_RESULTS,
  TEXT_PREVIEW_MAX_BYTES,
  type FileKind,
} from "../shared/file-kind.ts";
import { DOWNLOAD_MAX_BYTES, resolveWithinRoot, sanitizeRelPath } from "./files-policy.ts";

export type FileErrorCode =
  | "bad_request"
  | "unknown_session"
  | "outside_root"
  | "symlink"
  | "not_found"
  | "not_directory"
  | "not_file"
  | "permission"
  | "too_large";

export interface FileFailure {
  ok: false;
  code: FileErrorCode;
  message: string;
}

export type FileResolution = { ok: true; abs: string } | FileFailure;

export interface DirEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  fileKind?: FileKind;
  size?: number;
  mtimeMs?: number;
}

export interface ListDirectoryResult {
  ok: true;
  kind: "directory";
  path: string;
  entries: DirEntry[];
  truncated: boolean;
  total: number;
}

export interface ReadTextResult {
  ok: true;
  kind: "text";
  path: string;
  fileKind: FileKind;
  text: string;
  size: number;
  mtimeMs: number;
  truncated: boolean;
  binary: boolean;
}

export interface SearchResult {
  ok: true;
  kind: "search";
  query: string;
  matches: Array<{ path: string; name: string }>;
  truncated: boolean;
}

function failure(code: FileErrorCode, message: string): FileFailure {
  return { ok: false, code, message };
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/**
 * Resolve a validated relative path to a canonical absolute path inside the
 * project root. Rejects symlinks on the final component and any parent
 * directory that realpath-resolves outside the root.
 */
async function resolveEntry(rootAbs: string, rel: string): Promise<FileResolution> {
  const sanctioned = sanitizeRelPath(rel);
  if (!sanctioned.ok) return failure("bad_request", sanctioned.error);

  let rootReal: string;
  try {
    rootReal = await realpath(rootAbs);
  } catch {
    return failure("unknown_session", "project directory is unavailable");
  }

  // The root itself needs no parent-containment check.
  if (sanctioned.rel === "") return { ok: true, abs: rootReal };

  const joined = resolveWithinRoot(rootAbs, sanctioned.rel);
  if (joined === null) return failure("outside_root", "path escapes the project directory");

  let parentReal: string;
  try {
    parentReal = await realpath(dirname(joined));
  } catch {
    return failure("not_found", "path does not exist");
  }
  if (!isInside(rootReal, parentReal)) {
    return failure("outside_root", "path escapes the project directory");
  }

  const abs = join(parentReal, basename(joined));
  try {
    if ((await lstat(abs)).isSymbolicLink()) {
      return failure("symlink", "symbolic links are not supported");
    }
  } catch {
    return failure("not_found", "path does not exist");
  }
  return { ok: true, abs };
}

async function directoryEntries(
  rootAbs: string,
  rel: string,
  includeHidden: boolean,
): Promise<ListDirectoryResult | FileFailure> {
  const resolved = await resolveEntry(rootAbs, rel);
  if (!resolved.ok) return resolved;

  let dirents: Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;
  try {
    dirents = await readdir(resolved.abs, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTDIR") return failure("not_directory", "not a directory");
    if (code === "EACCES") return failure("permission", "permission denied");
    return failure("not_found", "directory could not be read");
  }

  const visible = dirents.filter((entry) => includeHidden || !entry.name.startsWith("."));
  visible.sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });

  const entries: DirEntry[] = [];
  for (const entry of visible.slice(0, MAX_DIR_ENTRIES)) {
    const entryPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      entries.push({ name: entry.name, path: entryPath, kind: "symlink" });
      continue;
    }
    if (entry.isDirectory()) {
      entries.push({ name: entry.name, path: entryPath, kind: "directory" });
      continue;
    }
    if (!entry.isFile()) {
      entries.push({ name: entry.name, path: entryPath, kind: "other" });
      continue;
    }
    try {
      const stats = await lstat(join(resolved.abs, entry.name));
      entries.push({
        name: entry.name,
        path: entryPath,
        kind: "file",
        fileKind: classifyFile(entry.name),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    } catch {
      // A file that vanished between readdir and stat is omitted, not shown stale.
    }
  }

  return {
    ok: true,
    kind: "directory",
    path: rel,
    entries,
    truncated: visible.length > MAX_DIR_ENTRIES,
    total: visible.length,
  };
}

/** Open a regular file with O_NOFOLLOW and read up to `maxBytes`. */
async function fileBytes(
  resolvedAbs: string,
  maxBytes: number,
): Promise<{ buffer: Buffer; size: number } | FileFailure> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(resolvedAbs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return failure("symlink", "symbolic links are not supported");
    if (code === "EACCES") return failure("permission", "permission denied");
    return failure("not_found", "file could not be opened");
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return failure("not_file", "not a regular file");
    const size = stats.size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return { buffer, size };
  } finally {
    await handle.close();
  }
}

async function readTextContent(rootAbs: string, rel: string): Promise<ReadTextResult | FileFailure> {
  const resolved = await resolveEntry(rootAbs, rel);
  if (!resolved.ok) return resolved;
  const bytes = await fileBytes(resolved.abs, TEXT_PREVIEW_MAX_BYTES);
  if (!("buffer" in bytes)) return bytes;

  const { buffer, size } = bytes;
  // A NUL byte anywhere marks binary content: previews must never hand it to a
  // text editor, and a misclassified binary gets the download fallback.
  const binary = buffer.includes(0);
  const stats = await lstat(resolved.abs).catch(() => null);
  return {
    ok: true,
    kind: "text",
    path: rel,
    fileKind: classifyFile(rel),
    text: buffer.toString("utf-8"),
    size,
    mtimeMs: stats?.mtimeMs ?? 0,
    truncated: size > TEXT_PREVIEW_MAX_BYTES,
    binary,
  };
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", "vendor", ".venv", "__pycache__",
]);

/** A bounded, hidden-aware filename walk. Never follows symlinks. */
async function walkFiles(
  rootAbs: string,
  query: string,
): Promise<{ matches: Array<{ path: string; name: string }>; truncated: boolean }> {
  const needle = query.toLowerCase().trim();
  const matches: Array<{ path: string; name: string }> = [];
  const stack: Array<{ dir: string; rel: string }> = [{ dir: rootAbs, rel: "" }];
  const MAX_VISIT = 5000;
  let visited = 0;

  while (stack.length > 0 && matches.length < MAX_SEARCH_RESULTS && visited < MAX_VISIT) {
    const current = stack.pop();
    if (current === undefined) break;
    let dirents: Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;
    try {
      dirents = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const subdirs: Array<{ dir: string; rel: string }> = [];
    for (const entry of dirents) {
      if (visited >= MAX_VISIT) break;
      visited += 1;
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const childRel = current.rel === "" ? entry.name : `${current.rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) subdirs.push({ dir: join(current.dir, entry.name), rel: childRel });
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().includes(needle)) {
        matches.push({ path: childRel, name: entry.name });
        if (matches.length >= MAX_SEARCH_RESULTS) break;
      }
    }
    for (let i = subdirs.length - 1; i >= 0; i -= 1) {
      if (subdirs[i] !== undefined) stack.push(subdirs[i] as { dir: string; rel: string });
    }
  }

  return { matches, truncated: visited >= MAX_VISIT || matches.length >= MAX_SEARCH_RESULTS };
}

function attachmentName(rel: string): string {
  // Strip path components and quote/control characters from the download name — deliberate.
  // oxlint-disable-next-line no-control-regex
  return basename(rel).replace(/["\u0000-\u001f\u007f]/g, "").slice(0, 180) || "download";
}

function forcesAttachment(mime: string | null): boolean {
  return mime === null || mime.startsWith("text/html") || mime === "image/svg+xml";
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "" && endText === "") return null;
  if (startText === "") {
    const suffix = Number(endText);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startText);
  if (!Number.isFinite(start) || start < 0 || start >= size) return null;
  if (endText === "") return { start, end: size - 1 };
  const end = Number(endText);
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

export function statusForCode(code: FileErrorCode): number {
  switch (code) {
    case "bad_request":
      return 400;
    case "unknown_session":
    case "not_found":
    case "not_directory":
    case "not_file":
      return 404;
    case "permission":
    case "symlink":
    case "outside_root":
      return 403;
    case "too_large":
      return 413;
    default:
      return 400;
  }
}

// ── Public operations (route handlers use these) ───────────────────────────

export function listDirectory(rootAbs: string, rel: string, includeHidden: boolean): Promise<ListDirectoryResult | FileFailure> {
  return directoryEntries(rootAbs, rel, includeHidden);
}

export function readText(rootAbs: string, rel: string): Promise<ReadTextResult | FileFailure> {
  return readTextContent(rootAbs, rel);
}

export function searchPaths(rootAbs: string, query: string): Promise<SearchResult | FileFailure> {
  const trimmed = query.trim();
  if (trimmed === "") return Promise.resolve(failure("bad_request", "a search query is required"));
  return walkFiles(rootAbs, query).then((found) => ({
    ok: true as const,
    kind: "search",
    query: trimmed,
    matches: found.matches,
    truncated: found.truncated,
  }));
}

/**
 * Stream a file with Range support. `attach` is the explicit download action;
 * executable-ish content (HTML/SVG) and unknown content always download as an
 * attachment so a same-origin GET can never execute project content.
 */
export async function streamFile(
  req: IncomingMessage,
  res: ServerResponse,
  rootAbs: string,
  rel: string,
  attach: boolean,
): Promise<void> {
  const resolved = await resolveEntry(rootAbs, rel);
  if (!resolved.ok) {
    res.writeHead(statusForCode(resolved.code), { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: resolved.message, code: resolved.code }));
    return;
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(resolved.abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const err = code === "ELOOP"
      ? failure("symlink", "symbolic links are not supported")
      : code === "EACCES"
        ? failure("permission", "permission denied")
        : failure("not_found", "file not found");
    res.writeHead(statusForCode(err.code), { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: err.message, code: err.code }));
    return;
  }

  let size: number;
  try {
    size = (await handle.stat()).size;
  } catch {
    await handle.close();
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "file could not be read", code: "not_file" }));
    return;
  }

  if (size > DOWNLOAD_MAX_BYTES) {
    await handle.close();
    res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "file is too large to preview or download", code: "too_large" }));
    return;
  }

  const mime = mimeTypeFor(rel);
  const disposition: "inline" | "attachment" = attach || forcesAttachment(mime) ? "attachment" : "inline";
  const baseHeaders: Record<string, string> = {
    "Content-Type": mime ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Content-Disposition": `${disposition}; filename="${attachmentName(rel)}"`,
    "Cache-Control": "private, no-store",
  };

  const range = parseRange(req.headers.range, size);
  if (range === null) {
    res.writeHead(200, { ...baseHeaders, "Content-Length": String(size) });
  } else {
    res.writeHead(206, {
      ...baseHeaders,
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
      "Content-Length": String(range.end - range.start + 1),
    });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  createReadStream(resolved.abs, { fd: handle.fd, start, end })
    .on("error", () => res.destroy())
    .pipe(res);
}