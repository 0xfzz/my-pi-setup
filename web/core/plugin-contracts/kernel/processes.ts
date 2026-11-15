/**
 * Process ownership for hot-pluggable plugins (PRD §6.4).
 *
 * A plugin can be deactivated, disabled, reloaded or quarantined at any moment,
 * and the host can exit while it is running. A child process it started is not
 * garbage-collected with the plugin: it outlives the object that created it and
 * becomes an orphan. So the kernel owns it instead. Every child is registered
 * against the plugin that spawned it, killed when that plugin stops, and
 * recorded in a pidfile so a host that dies without a chance to clean up
 * (SIGKILL, a crash, a supervisor's hard kill) is reaped by the next boot.
 *
 * Two rules keep the reaper from killing a stranger:
 *
 * - Ownership is recorded with the child's start token (Linux `/proc/<pid>/stat`
 *   field 22). A pid recycled by an unrelated process has a different token, so
 *   it is never signaled on trust.
 * - A record whose owning host is still alive is left alone. Two hosts sharing
 *   one state directory must not reap each other's children.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const PIDFILE_VERSION = 1;
/** SIGTERM → SIGKILL grace for one child; a plugin's children are killed together. */
export const DEFAULT_KILL_GRACE_MS = 2_000;
/** How long the reaper waits for a reaped orphan to exit before SIGKILL. */
export const DEFAULT_REAP_GRACE_MS = 1_000;

/** One child process the kernel owns. */
export interface ChildRecord {
  pid: number;
  /** The plugin that spawned it; the release unit. */
  owner: string;
  /** The command line, for diagnostics only — never used to decide a kill. */
  command: string;
  /** `/proc/<pid>/stat` field 22; distinguishes a recycled pid from ours. */
  startToken: string | null;
  startedAt: number;
}

export interface PidfileContents {
  version: number;
  /** The host process that wrote this file. */
  hostPid: number;
  hostStartToken: string | null;
  children: ChildRecord[];
}

/** What a plugin may hand to `spawn`; a child's stdio defaults to ignore. */
export type ChildSpawnOptions = Omit<SpawnOptions, "detached" | "stdio"> & {
  stdio?: SpawnOptions["stdio"];
};

export interface ProcessRegistryOptions {
  /** Where ownership is persisted; without it children are only tracked in memory. */
  pidFile?: string;
  spawnImpl?: typeof spawn;
  /** How long a child gets to exit after SIGTERM before SIGKILL. */
  graceMs?: number;
  now?: () => number;
  onWarning?: (message: string) => void;
  /** This host's pid; injected so tests never signal the test runner. */
  hostPid?: number;
}

export interface PluginProcessRegistry {
  /**
   * Spawn a child owned by `owner`. Not detached: it stays in this host's
   * process group, so a terminal's Ctrl-C reaches it too.
   */
  spawn(owner: string, command: string, args: readonly string[], options?: ChildSpawnOptions): ChildProcess;
  /** Every child currently owned, optionally narrowed to one plugin. */
  children(owner?: string): ChildRecord[];
  /** SIGTERM every child of `owner`, then SIGKILL whatever survives the grace. */
  release(owner: string): Promise<ChildRecord[]>;
  /** Release everything; the host calls this after the plugins have deactivated. */
  releaseAll(): Promise<ChildRecord[]>;
  /** Last-resort synchronous kill, for `process.on("exit")` where nothing can be awaited. */
  killAllNow(): void;
  /** Release everything and remove the pidfile. */
  dispose(): Promise<void>;
}

/** The start token of a live pid, or null when it cannot be read (non-Linux, or gone). */
export function startTokenOf(pid: number, read: (path: string) => string = readProcStat): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let stat: string;
  try {
    stat = read(`/proc/${pid}/stat`);
  } catch {
    return null;
  }
  // Field 22, 1-based, after the `(comm)` group that may itself contain spaces.
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat.slice(close + 2).split(" ");
  // The slice starts at field 3 (state); starttime is field 22.
  return fields[19] ?? null;
}

function readProcStat(path: string): string {
  return readFileSync(path, "utf8");
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists and belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Is this recorded child still the process we started? */
export function isOwnedChild(record: ChildRecord, tokenOf: (pid: number) => string | null = startTokenOf): boolean {
  if (!isPidAlive(record.pid)) return false;
  // A record without a token cannot be proven ours; leave it alone.
  if (record.startToken === null) return false;
  return tokenOf(record.pid) === record.startToken;
}

function parsePidfile(input: unknown): PidfileContents | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  if (raw.version !== PIDFILE_VERSION) return undefined;
  if (typeof raw.hostPid !== "number") return undefined;
  if (!Array.isArray(raw.children)) return undefined;
  const children: ChildRecord[] = [];
  for (const entry of raw.children) {
    if (typeof entry !== "object" || entry === null) continue;
    const child = entry as Record<string, unknown>;
    if (typeof child.pid !== "number" || typeof child.owner !== "string") continue;
    children.push({
      pid: child.pid,
      owner: child.owner,
      command: typeof child.command === "string" ? child.command : "",
      startToken: typeof child.startToken === "string" ? child.startToken : null,
      startedAt: typeof child.startedAt === "number" ? child.startedAt : 0,
    });
  }
  return {
    version: PIDFILE_VERSION,
    hostPid: raw.hostPid,
    hostStartToken: typeof raw.hostStartToken === "string" ? raw.hostStartToken : null,
    children,
  };
}

/** Read a pidfile. Anything unreadable is a warning, never a crash. */
export function readPidfile(path: string): { contents?: PidfileContents; warning?: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    return { warning: `could not read ${path}: ${String(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { warning: `${path} is not valid JSON; orphan reaping is skipped` };
  }
  const contents = parsePidfile(parsed);
  if (contents === undefined) return { warning: `${path} has an unsupported shape; orphan reaping is skipped` };
  return { contents };
}

function writePidfile(path: string, contents: PidfileContents): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(contents, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

/**
 * Which recorded children of a dead host must be killed.
 *
 * Pure: it decides, `reapOrphans` acts. A record survives this filter only when
 * the pid is alive and its start token matches, which is what makes reaping
 * safe across a pid reuse.
 */
export function reapableChildren(
  previous: PidfileContents,
  hostPid: number,
  tokenOf: (pid: number) => string | null = startTokenOf,
): ChildRecord[] {
  if (previous.hostPid === hostPid) return [];
  // The writing host is still running, so its children are not orphans.
  const hostStillRunning =
    isPidAlive(previous.hostPid) &&
    (previous.hostStartToken === null || tokenOf(previous.hostPid) === previous.hostStartToken);
  if (hostStillRunning) return [];
  return previous.children.filter((child) => child.pid !== hostPid && isOwnedChild(child, tokenOf));
}

function signalQuietly(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone, or not ours to signal.
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for `pids` to disappear, up to `budgetMs`. */
async function waitForExit(pids: readonly number[], budgetMs: number, alive: (pid: number) => boolean = isPidAlive): Promise<number[]> {
  const deadline = Date.now() + budgetMs;
  let remaining = pids.filter(alive);
  while (remaining.length > 0 && Date.now() < deadline) {
    await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
    remaining = remaining.filter(alive);
  }
  return remaining;
}

export interface ReapOutcome {
  reaped: number[];
  /** Alive, but not provably ours; deliberately left running. */
  skipped: number[];
  warning?: string;
}

/**
 * Kill the children a previous host left behind.
 *
 * Called once at boot, before any plugin runs: whatever the dead process
 * spawned is still holding ports, files or locks that the new one needs.
 */
export async function reapOrphans(
  pidFile: string,
  options: { hostPid?: number; graceMs?: number; tokenOf?: (pid: number) => string | null; alive?: (pid: number) => boolean } = {},
): Promise<ReapOutcome> {
  const loaded = readPidfile(pidFile);
  if (loaded.warning !== undefined) return { reaped: [], skipped: [], warning: loaded.warning };
  if (loaded.contents === undefined) return { reaped: [], skipped: [] };
  const hostPid = options.hostPid ?? process.pid;
  const tokenOf = options.tokenOf ?? startTokenOf;
  const alive = options.alive ?? isPidAlive;
  const candidates = reapableChildren(loaded.contents, hostPid, tokenOf);
  const targets = candidates.filter((child) => alive(child.pid));
  const targetPids = new Set(targets.map((child) => child.pid));
  // Alive but not provably ours: reported, never signaled.
  const skipped = loaded.contents.children
    .filter((child) => alive(child.pid) && !targetPids.has(child.pid))
    .map((child) => child.pid);
  if (targets.length === 0) return { reaped: [], skipped };

  for (const child of targets) signalQuietly(child.pid, "SIGTERM");
  const stubborn = await waitForExit(targets.map((child) => child.pid), options.graceMs ?? DEFAULT_REAP_GRACE_MS, alive);
  for (const pid of stubborn) signalQuietly(pid, "SIGKILL");
  return { reaped: targets.map((child) => child.pid), skipped };
}

export function createProcessRegistry(options: ProcessRegistryOptions = {}): PluginProcessRegistry {
  const now = options.now ?? Date.now;
  const spawnImpl = options.spawnImpl ?? spawn;
  const graceMs = options.graceMs ?? DEFAULT_KILL_GRACE_MS;
  const hostPid = options.hostPid ?? process.pid;
  const warn = options.onWarning ?? (() => undefined);
  const hostStartToken = startTokenOf(hostPid);
  const owned = new Map<number, { record: ChildRecord; child: ChildProcess }>();

  const persist = (): void => {
    if (options.pidFile === undefined) return;
    try {
      writePidfile(options.pidFile, { version: PIDFILE_VERSION, hostPid, hostStartToken, children: records() });
    } catch (error) {
      warn(`could not write ${options.pidFile}: ${String(error)}`);
    }
  };

  function records(owner?: string): ChildRecord[] {
    return [...owned.values()]
      .map((entry) => entry.record)
      .filter((record) => owner === undefined || record.owner === owner);
  }

  function forget(pid: number): void {
    if (owned.delete(pid)) persist();
  }

  async function releaseChildren(targets: readonly ChildRecord[]): Promise<ChildRecord[]> {
    const live = targets.filter((record) => owned.has(record.pid));
    if (live.length === 0) return [];
    for (const record of live) signalQuietly(record.pid, "SIGTERM");
    const stubborn = await waitForExit(live.map((record) => record.pid), graceMs);
    for (const pid of stubborn) signalQuietly(pid, "SIGKILL");
    await waitForExit(stubborn, Math.min(graceMs, DEFAULT_REAP_GRACE_MS));
    for (const record of live) owned.delete(record.pid);
    persist();
    return live;
  }

  return {
    spawn: (owner, command, args, spawnOptions = {}) => {
      const child = spawnImpl(command, [...args], {
        ...spawnOptions,
        // Never detached: a detached child would survive the host on purpose,
        // which is exactly the orphan this registry exists to prevent.
        detached: false,
        stdio: spawnOptions.stdio ?? "ignore",
      });
      if (child.pid !== undefined) {
        owned.set(child.pid, {
          record: {
            pid: child.pid,
            owner,
            command: [command, ...args].join(" "),
            startToken: startTokenOf(child.pid),
            startedAt: now(),
          },
          child,
        });
        child.once("exit", () => forget(child.pid!));
        persist();
      }
      return child;
    },
    children: records,
    release: (owner) => releaseChildren(records(owner)),
    releaseAll: () => releaseChildren(records()),
    killAllNow: () => {
      for (const record of records()) signalQuietly(record.pid, "SIGKILL");
      owned.clear();
    },
    dispose: async () => {
      await releaseChildren(records());
      if (options.pidFile !== undefined) {
        try {
          rmSync(options.pidFile, { force: true });
        } catch {
          // A pidfile we cannot remove is reaped as stale by the next boot.
        }
      }
    },
  };
}
