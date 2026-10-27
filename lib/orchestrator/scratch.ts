/**
 * scratch.ts — the one disposable directory research may write to.
 *
 * The research surface must never touch the work tree, but a page cache or a code
 * index still needs somewhere to live. That somewhere is exactly one root: the
 * project's `.pi/orch-research/<run>/` when `.pi/` is gitignored, otherwise a
 * temp directory. An explicit `PI_ORCH_SCRATCH` may replace it, but never with a
 * path inside the repository that git actually tracks.
 *
 * Everything here is either a pure resolution decision or an explicit cap/cleanup
 * action. Nothing is created until `ensureScratch` is called, so importing the
 * module never writes.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const SCRATCH_ENV = "PI_ORCH_SCRATCH";
export const SCRATCH_DIR = join(".pi", "orch-research");
export const SCRATCH_MAX_BYTES = 50 * 1024 * 1024;
export const SCRATCH_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** A whole run directory older than this is garbage collected. */
export const SCRATCH_STALE_MS = 24 * 60 * 60 * 1000;
/** Cache entries older than this are pruned even inside a live run. */
export const SCRATCH_CACHE_TTL_MS = 10 * 60 * 1000;

type Env = Readonly<Record<string, string | undefined>>;

export type ScratchSource = "env" | "project" | "tmp";

export type ScratchResolution =
  | { ok: true; root: string; base: string; source: ScratchSource; runId: string }
  | { ok: false; problems: string[] };

export interface ScratchLayout {
  root: string;
  cache: string;
  webCache: string;
  codeCache: string;
  searchCache: string;
  tmp: string;
  stage: string;
}

/** `relative()` is not enough on its own: a windows drive change is not "inside". */
function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function findRepoRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Best-effort: does the repository ignore `.pi/`? Without this, scratch would pollute git. */
export function piDirIgnored(repoRoot: string): boolean {
  try {
    const ignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
    return ignore
      .split(/\r?\n/)
      .some((line) => /^\s*\/?\.pi\/?\s*$/.test(line));
  } catch {
    return false;
  }
}

export function sanitizeRunId(raw: unknown): string {
  const value = String(raw ?? "").trim();
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 64);
  return cleaned || "scratch";
}

function runIdFor(env: Env): string {
  return sanitizeRunId(env.PI_SUBAGENT_REVIEW_RUN ?? env.PI_SUBAGENT_ID ?? env.PI_SUBAGENT_SCOPE ?? "scratch");
}

/**
 * Resolve where scratch lives for this run.
 *
 * Order: explicit `PI_ORCH_SCRATCH` → project `.pi/orch-research/<run>` when
 * `.pi/` is ignored → temp directory. A repo-relative override is refused unless
 * it is under `.pi/orch-research`, because anything else would be a write into
 * the work tree by another name.
 */
export function resolveScratchRoot(options: {
  cwd: string;
  runId?: string;
  env?: Env;
  tmpRoot?: string;
}): ScratchResolution {
  const env = options.env ?? process.env;
  const runId = options.runId ? sanitizeRunId(options.runId) : runIdFor(env);
  const repoRoot = findRepoRoot(options.cwd);
  const tmpBase = join(options.tmpRoot ?? tmpdir(), "orch-research");
  const declared = env[SCRATCH_ENV];

  if (declared !== undefined && String(declared).trim() !== "") {
    const raw = String(declared).trim();
    if (!isAbsolute(raw)) {
      return { ok: false, problems: [`${SCRATCH_ENV} must be an absolute path (got "${raw}")`] };
    }
    const root = resolve(raw);
    if (repoRoot && isInside(repoRoot, root)) {
      const allowed = join(repoRoot, SCRATCH_DIR);
      if (!isInside(allowed, root)) {
        return {
          ok: false,
          problems: [
            `${SCRATCH_ENV} points inside the repository (${root}); only ${allowed} is writable, `
              + "because anything else would be a work-tree write",
          ],
        };
      }
    }
    return { ok: true, root: join(root, runId), base: root, source: "env", runId };
  }

  if (repoRoot && piDirIgnored(repoRoot)) {
    const base = join(repoRoot, SCRATCH_DIR);
    return { ok: true, root: join(base, runId), base, source: "project", runId };
  }

  return { ok: true, root: join(tmpBase, runId), base: tmpBase, source: "tmp", runId };
}

/** Create the layout. Idempotent; every directory is private to the user. */
export function ensureScratch(root: string): ScratchLayout {
  const layout: ScratchLayout = {
    root,
    cache: join(root, "cache"),
    webCache: join(root, "cache", "web"),
    codeCache: join(root, "cache", "code"),
    searchCache: join(root, "cache", "search"),
    tmp: join(root, "tmp"),
    stage: join(root, "stage"),
  };
  for (const dir of [layout.root, layout.cache, layout.webCache, layout.codeCache, layout.searchCache, layout.tmp, layout.stage]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return layout;
}

/**
 * Is `candidate` (relative to the root, or absolute) safe to write?
 *
 * The lexical check stops `../`; resolving the nearest existing ancestor stops a
 * symlink from turning an inside path into an outside one.
 */
export function scratchPathProblem(candidate: string, root: string): string | undefined {
  const base = resolve(root);
  const target = resolve(base, candidate);
  if (!isInside(base, target)) return `${candidate} is outside the scratch root (${base})`;

  const realBase = existsSync(base) ? realpathSync(base) : base;
  let probe = target;
  const missing: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    missing.unshift(basename(probe));
    probe = parent;
  }
  let realProbe = probe;
  try {
    realProbe = realpathSync(probe);
  } catch {
    // An unresolvable ancestor is treated lexically; the caller still cannot
    // write outside `base` because the lexical check already ran.
  }
  const resolved = resolve(realProbe, ...missing);
  if (!isInside(realBase, resolved)) return `${candidate} escapes the scratch root through a symlink`;
  return undefined;
}

interface ScratchFile {
  path: string;
  size: number;
  mtimeMs: number;
}

function walkFiles(dir: string): ScratchFile[] {
  const out: ScratchFile[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const path = join(dir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) out.push(...walkFiles(path));
    else if (stat.isFile()) out.push({ path, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return out;
}

/**
 * Enforce the size caps: drop oversized files, then evict oldest-first until the
 * total fits. Returns what was removed so a caller can report it instead of
 * silently losing a cache entry.
 */
export function enforceScratchCaps(
  root: string,
  options: { maxBytes?: number; maxFileBytes?: number } = {},
): { removed: string[]; totalBytes: number } {
  if (!existsSync(root)) return { removed: [], totalBytes: 0 };
  const maxBytes = options.maxBytes ?? SCRATCH_MAX_BYTES;
  const maxFileBytes = options.maxFileBytes ?? SCRATCH_MAX_FILE_BYTES;
  const removed: string[] = [];
  const kept: ScratchFile[] = [];
  for (const file of walkFiles(root)) {
    if (file.size > maxFileBytes) {
      rmSync(file.path, { force: true });
      removed.push(file.path);
    } else {
      kept.push(file);
    }
  }
  let total = kept.reduce((sum, file) => sum + file.size, 0);
  if (total > maxBytes) {
    kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of kept) {
      if (total <= maxBytes) break;
      rmSync(file.path, { force: true });
      removed.push(file.path);
      total -= file.size;
    }
  }
  return { removed, totalBytes: total };
}

/** Drop cache entries older than the TTL; live-run scratch keeps its staged files. */
export function pruneScratchCache(
  root: string,
  options: { now?: number; ttlMs?: number } = {},
): string[] {
  const cache = join(root, "cache");
  if (!existsSync(cache)) return [];
  const now = options.now ?? Date.now();
  const ttl = options.ttlMs ?? SCRATCH_CACHE_TTL_MS;
  const removed: string[] = [];
  for (const file of walkFiles(cache)) {
    if (now - file.mtimeMs < ttl) continue;
    rmSync(file.path, { force: true });
    removed.push(file.path);
  }
  return removed;
}

/** Remove one run's scratch entirely. Safe to call twice. */
export function removeScratch(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** Remove run directories older than the stale TTL. */
export function gcStaleScratch(
  base: string,
  options: { now?: number; ttlMs?: number } = {},
): string[] {
  if (!existsSync(base)) return [];
  const now = options.now ?? Date.now();
  const ttl = options.ttlMs ?? SCRATCH_STALE_MS;
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return removed;
  }
  for (const name of entries) {
    const path = join(base, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (now - stat.mtimeMs < ttl) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}
