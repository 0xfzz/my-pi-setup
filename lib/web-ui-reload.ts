/**
 * Source change detection for the pi-web server (`/web reload`, automatic reload).
 *
 * Two kinds of input matter, and they cost different amounts:
 *  - build inputs: everything the production bundle is made of — the client
 *    entry, the client tree, the shared modules it imports, the plugins' client
 *    halves, the contract modules whose values the bundle contains, and the
 *    build config. A change needs a rebuild and a restart.
 *  - runtime inputs: the server code the bundle does NOT contain (the HTTP host,
 *    auth and the pi_api facade) plus the plugin contracts it loads at boot. A
 *    change needs only a restart.
 *
 * The split is what keeps a reload cheap, so it must stay honest: anything the
 * bundle can reach belongs in the build list, or a restart serves a stale client
 * next to fresh server code — the two sides then disagree about the plugin
 * contract. `core/plugin-contracts` is both: the client bundles `validateView`
 * and `resolveOverrides` from it, and the server loads the whole tree.
 *
 * Fingerprints are built from size and mtime of each file, not contents, so a walk
 * stays cheap enough to run on every save. The last-built fingerprints are kept in
 * `web-ui-build.json` next to the state file.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

/** Minimal server directories and files the build reads. */
export const BUILD_INPUT_DIRS = ["core/client", "core/plugin-contracts", "core/shared", "plugins"] as const;
export const BUILD_INPUT_FILES = [
  // The client entry: it wires the shell to the plugin panel/page registries.
  "app.tsx",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "build.mjs",
] as const;
/**
 * Our directories the running server loads at runtime (relative to the repo root)
 * and the bundle does not contain: a change here needs a restart, not a rebuild.
 */
export const RUNTIME_INPUT_DIRS = ["web/core/server", "web/core/auth", "web/core/pi-api"] as const;

const SKIPPED_DIRS = new Set(["node_modules", "dist", "test-results", "e2e"]);
const TEST_FILE = /\.test\.(ts|tsx|mjs|js)$/;

export interface SourceFingerprints {
  build: string;
  runtime: string;
}

export interface BuildRecord extends SourceFingerprints {
  builtAt: string;
}

export interface SourceChange {
  /** The build inputs differ from the last build: rebuild and restart. */
  build: boolean;
  /** The runtime inputs differ from the last start: restart. */
  runtime: boolean;
}

/** Fingerprint of files under `dirs` (relative to `root`) plus `files`. Missing paths are skipped. */
export function fingerprintInputs(root: string, dirs: readonly string[], files: readonly string[]): string {
  const hash = createHash("sha256");
  const entries: string[] = [];
  const visit = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIPPED_DIRS.has(name) || TEST_FILE.test(name)) continue;
      const full = join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) visit(full);
      else if (stat.isFile()) entries.push(`${relative(root, full).split(sep).join("/")}\0${stat.size}\0${stat.mtimeMs}`);
    }
  };
  for (const dir of dirs) visit(join(root, dir));
  for (const file of files) {
    const full = join(root, file);
    try {
      const stat = statSync(full);
      if (stat.isFile()) entries.push(`${file}\0${stat.size}\0${stat.mtimeMs}`);
    } catch {
      // A missing optional config file is part of the fingerprint as absence.
    }
  }
  for (const line of entries.sort()) hash.update(`${line}\n`);
  return hash.digest("hex");
}

/** Fingerprints for the vendored fork (`serverDir`) and our runtime files (under `repoRoot`). */
export function sourceFingerprints(serverDir: string, repoRoot: string): SourceFingerprints {
  return {
    build: fingerprintInputs(serverDir, BUILD_INPUT_DIRS, BUILD_INPUT_FILES),
    runtime: fingerprintInputs(repoRoot, RUNTIME_INPUT_DIRS, []),
  };
}

/** Compare current fingerprints with the record of the last build and start. A missing record counts as changed. */
export function evaluateChange(current: SourceFingerprints, record: Pick<BuildRecord, "build" | "runtime"> | null): SourceChange {
  if (!record) return { build: true, runtime: true };
  return { build: record.build !== current.build, runtime: record.runtime !== current.runtime };
}

/** What the running server knows about sessions a restart would destroy. */
export interface ServerReloadState {
  /** Sessions owned in-process by the web server (a restart kills them). */
  liveSessions: number;
  /** How many of those sessions have a turn in flight. */
  runningSessions: number;
  /** Sessions owned elsewhere and bridged into the web (a restart drops the bridge). */
  bridgedSessions: number;
}

export const EMPTY_RELOAD_STATE: ServerReloadState = {
  liveSessions: 0,
  runningSessions: 0,
  bridgedSessions: 0,
};

/** Read an untrusted reload-state response without trusting extra fields or bad counts. */
export function parseReloadState(value: unknown): ServerReloadState | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const count = (key: keyof ServerReloadState): number | null => {
    const n = record[key];
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
  };
  const liveSessions = count("liveSessions");
  const runningSessions = count("runningSessions");
  const bridgedSessions = count("bridgedSessions");
  if (liveSessions === null || runningSessions === null || bridgedSessions === null) return null;
  return { liveSessions, runningSessions, bridgedSessions };
}

/** Inputs to the reload decision: the local session plus what the server reports. */
export interface ReloadSafety {
  /** True while a turn runs in the terminal session that owns this watcher. */
  turnRunning: boolean;
  /** Server-reported session counts, or null when the server cannot answer. */
  server: ServerReloadState | null;
}

/**
 * What an automatic reload does with a source change.
 *
 * - `rebuild-client`: a client-only change is rebuilt in place. The running server
 *   reads the build from disk and announces the new build id, so open pages reload
 *   themselves; the server and every session bridged to it keep running.
 * - `restart`: a server-side change (or a server that is down) needs a new process.
 *   Restarting kills in-process sessions and drops bridges, so it runs only when
 *   the server reports none.
 * - `defer`: a restart is needed but a session, bridge or turn is live; it waits.
 */
export type AutoReloadAction = "rebuild-client" | "restart" | "defer";

export function autoReloadAction(change: SourceChange, healthy: boolean, safety: ReloadSafety): AutoReloadAction {
  if (!healthy) return "restart";
  if (!change.runtime) return "rebuild-client";
  if (safety.turnRunning) return "defer";
  const server = safety.server;
  if (server !== null && (server.liveSessions > 0 || server.bridgedSessions > 0)) return "defer";
  return "restart";
}

/** Say what is keeping a restart pending, so the TUI notice names the real blocker. */
export function deferralMessage(safety: ReloadSafety): string {
  const server = safety.server;
  const live = (server?.liveSessions ?? 0) + (server?.bridgedSessions ?? 0);
  if (live > 0) {
    const noun = live === 1 ? "session" : "sessions";
    return `pi-web server code changed; the restart waits until ${live} live web ${noun} close.`;
  }
  return "pi-web server code changed; the restart waits until the running turn settles.";
}

/** Where the build record lives: next to the state file, so a test's temp state keeps its record too. */
export function buildRecordPath(statePath: string): string {
  return join(dirname(statePath), "web-ui-build.json");
}

export async function readBuildRecord(path: string): Promise<BuildRecord | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  const r = parsed as Partial<BuildRecord> | null;
  return r && typeof r.build === "string" && typeof r.runtime === "string" && typeof r.builtAt === "string"
    ? { build: r.build, runtime: r.runtime, builtAt: r.builtAt }
    : null;
}

/** Atomic write, so a crash mid-write never leaves a half-written record that looks current. */
export async function writeBuildRecord(path: string, record: BuildRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export function reloadLockPath(statePath: string): string {
  return join(dirname(statePath), "web-ui-reload.lock");
}

const LOCK_STALE_MS = 15 * 60_000;

/**
 * Take the reload lock, shared by every pi session on this machine. The lock is a
 * directory (atomic to create) holding the owner's pid. A lock whose owner is dead,
 * or that is older than a build could take, is taken over. Returns a release function,
 * or null when another reload holds the lock.
 */
export function acquireReloadLock(path: string, isPidAlive: (pid: number) => boolean, now: () => number = Date.now): (() => void) | null {
  const tryCreate = (): (() => void) | null => {
    try {
      mkdirSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }
    writeFileSync(join(path, "owner"), `${process.pid} ${now()}`);
    return () => rmSync(path, { recursive: true, force: true });
  };
  const first = tryCreate();
  if (first) return first;
  let owner = "";
  try {
    owner = readFileSync(join(path, "owner"), "utf8");
  } catch {
    // A lock directory without an owner file is being created right now, or was left half-made.
  }
  const [pidText, startedText] = owner.split(" ");
  const pid = Number(pidText);
  const started = Number(startedText);
  const dead = !Number.isInteger(pid) || pid <= 0 || !isPidAlive(pid);
  const expired = !Number.isFinite(started) || now() - started > LOCK_STALE_MS;
  if (!dead && !expired) return null;
  rmSync(path, { recursive: true, force: true });
  return tryCreate();
}

/** Repo root for the default fingerprint paths: `web` sits one level below it. */
export function repoRootFromServerDir(serverDir: string): string {
  return resolve(serverDir, "..");
}

export interface SourceWatcher {
  close(): void;
}

/**
 * Watch source roots and call `onChange` once per quiet period. Recursive watches are
 * native on this platform; a missing root is skipped rather than failing the session.
 */
export function watchSources(options: { roots: readonly string[]; debounceMs: number; onChange: () => void }): SourceWatcher {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchers = options.roots.filter((root) => existsSync(root)).map((root) =>
    watch(root, { recursive: true }, (_event, filename) => {
      const name = filename?.toString() ?? "";
      if (name && (SKIPPED_DIRS.has(name.split(sep)[0] ?? "") || TEST_FILE.test(name))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        options.onChange();
      }, options.debounceMs);
    }),
  );
  return {
    close() {
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    },
  };
}

/**
 * Directories to watch: only the inputs above, never the whole tree, because a recursive
 * watch over `node_modules` or `.next` costs thousands of inotify handles for nothing.
 * Top-level config files are not watched; they are still in the fingerprint, so the next
 * `/web start` or `/web reload` picks them up.
 */
export function sourceWatchRoots(serverDir: string, repoRoot: string): string[] {
  return [
    ...BUILD_INPUT_DIRS.map((dir) => join(serverDir, dir)),
    ...RUNTIME_INPUT_DIRS.map((dir) => join(repoRoot, dir)),
  ];
}
