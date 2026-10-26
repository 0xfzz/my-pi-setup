/**
 * lifecycle.ts — discovery, race-safe startup, and shutdown for the shared server.
 *
 * Every Pi process that enters Orchestrator mode calls `ensureDashboard()`. The
 * contract is: however many processes call it, concurrently or not, exactly one
 * server per runtime directory ends up serving them.
 *
 * ── Why a lock file and not "is the port free?" ────────────────────────────
 * Port occupancy is not identity. An unrelated service on the preferred port
 * must not be adopted, and two starters that both see "port busy" must not both
 * fall back to ephemeral ports (that would be two servers). So startup is gated
 * by an `O_EXCL` lock file:
 *
 *   1. Health-check existing metadata (instance id + token + port). If the
 *      server answers as *this* instance, reuse it.
 *   2. Otherwise take the exclusive lock. The loser polls for the winner's
 *      health instead of spawning.
 *   3. Under the lock, spawn a detached server, wait for its metadata, and
 *      verify it with the producer token.
 *
 * A lock left by a crashed starter names a dead pid, which is detected and
 * removed. A live lock holder is always allowed to finish: pid liveness is a
 * stronger signal than file age, so a slow (but healthy) startup cannot be
 * "recovered" into a duplicate server.
 *
 * ── Why metadata is not trusted on its own ─────────────────────────────────
 * `server.json` can be stale (server died) or hand-crafted. It is only an
 * address hint; the decision to reuse requires a successful authenticated health
 * response whose `instanceId` matches the metadata. Anything else is treated as
 * stale and replaced.
 *
 * Importing this module performs no I/O. `ensureDashboard()` does everything.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { link, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DASHBOARD_PROTOCOL } from "./protocol.ts";
import {
  DEFAULT_PREFERRED_PORT,
  SINGLETON_EXIT_CODE,
  ensurePrivateRuntimeDir,
  readProducerToken,
  readRuntimeMetadata,
  removeRuntimeMetadata,
} from "./server.ts";

export const LOCK_FILE = "instance.lock";
const LOG_FILE = "server.log";
const DEFAULT_ACQUIRE_TIMEOUT_MS = 8_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 6_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 50;
/** Fresh-lock window during which an unparseable lock is still considered held. */
const DEFAULT_LOCK_GRACE_MS = 2_500;

export interface EnsureDashboardOptions {
  /** Private runtime directory. Defaults to `$PI_DASHBOARD_DIR` or `~/.pi/dashboard`. */
  runtimeDir?: string;
  /** Preferred fixed port. `0` forces an ephemeral port. Defaults to 9177 then ephemeral. */
  preferredPort?: number;
  /** Passed to the spawned server; omit to use the server's own default. */
  idleMs?: number;
  producerTtlMs?: number;
  webRoot?: string;
  /** How long to wait for a concurrent starter to publish health. */
  acquireTimeoutMs?: number;
  /** How long to wait for our own spawned server to become healthy. */
  startupTimeoutMs?: number;
  /**
   * Freshness window for a just-created lock file. Another starter may have
   * opened it microseconds ago and not yet written its pid; treating an empty
   * fresh file as stale would let us steal a live lock and spawn a duplicate.
   */
  lockGraceMs?: number;
  /** Test seams. Production callers should not set these. */
  serverEntry?: string;
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export interface DashboardAddress {
  /** Clean root URL, safe to display. */
  url: string;
  /** Bootstrap URL that mints the HttpOnly browser cookie; this is what the user opens. */
  browserUrl: string;
  port: number;
  pid: number;
  runtimeDir: string;
  instanceId: string;
  /** Producer credential. Must never be sent to a browser or serialized into a snapshot. */
  producerToken: string;
  protocol: typeof DASHBOARD_PROTOCOL;
  /** True when this call spawned the server, false when it was reused. */
  owned: boolean;
}

export interface StopDashboardOptions {
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

/** Production runtime directory: private to the OS user. */
export function defaultRuntimeDir(): string {
  const override = process.env.PI_DASHBOARD_DIR;
  if (typeof override === "string" && override.trim() !== "") return resolve(override.trim());
  return join(homedir(), ".pi", "dashboard");
}

/** Absolute path of the detached entry point that this module spawns. */
export function dashboardServerEntry(): string {
  return fileURLToPath(new URL("./server-main.ts", import.meta.url));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readAddressHint(runtimeDir: string): Promise<DashboardAddress | null> {
  const metadata = await readRuntimeMetadata(runtimeDir);
  if (metadata === null) return null;
  const producerToken = await readProducerToken(runtimeDir);
  if (producerToken === null) return null;
  return {
    url: metadata.url,
    browserUrl: metadata.browserUrl,
    port: metadata.port,
    pid: metadata.pid,
    runtimeDir,
    instanceId: metadata.instanceId,
    producerToken,
    protocol: DASHBOARD_PROTOCOL,
    owned: false,
  };
}

/** Metadata for the current runtime directory without starting anything or trusting it. */
export async function readDashboardAddress(runtimeDir: string = defaultRuntimeDir()): Promise<DashboardAddress | null> {
  return readAddressHint(resolve(runtimeDir));
}

/**
 * Authenticated identity check: the server must answer with our instance id and
 * protocol. A plain TCP accept or an unrelated HTTP 200 is not enough.
 */
export async function checkDashboardHealth(
  address: Pick<DashboardAddress, "url" | "producerToken" | "instanceId" | "port" | "pid">,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${address.url}api/health`, {
      headers: { authorization: `Bearer ${address.producerToken}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 1_500),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as Record<string, unknown>;
    return (
      body.ok === true &&
      body.protocol === DASHBOARD_PROTOCOL &&
      body.instanceId === address.instanceId &&
      body.port === address.port &&
      // A pid check closes the "metadata pid was reused by another process" gap:
      // the answering server must be the process we think we are talking to.
      body.pid === address.pid
    );
  } catch {
    return false;
  }
}

// ── Startup lock ────────────────────────────────────────────────────────────

interface LockHandle {
  release(): Promise<void>;
}

async function readLockPid(path: string): Promise<number | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) ? parsed.pid : null;
  } catch {
    return null;
  }
}

async function releaseLock(path: string): Promise<void> {
  // Only remove our own lock: another process may have recovered a stale one.
  const pid = await readLockPid(path);
  if (pid === process.pid) await unlink(path).catch(() => {});
}

async function lockIsStale(path: string, graceMs: number): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  if (info === null) return true;
  // A just-created lock may be observed between `open(wx)` and the owner's
  // write. Treat that window as held, never as stale: otherwise a competitor
  // would unlink a live starter's lock and spawn a duplicate.
  if (Date.now() - info.mtimeMs < graceMs) return false;
  const pid = await readLockPid(path);
  if (pid !== null && isProcessAlive(pid)) return false;
  return true;
}

/**
 * Recover a stale lock without ever destroying a lock a live owner just replaced
 * (TOCTOU between our staleness read and our unlink). The lock is renamed to a
 * private quarantine first; if its pid turns out to be alive, it is restored with
 * `link` (which never overwrites) instead of unlinking it.
 */
async function recoverStaleLock(path: string): Promise<void> {
  const quarantine = `${path}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await rename(path, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const pid = await readLockPid(quarantine);
  if (pid !== null && isProcessAlive(pid)) {
    // We raced a live owner: put it back only if nobody else has taken the name.
    try {
      await link(quarantine, path);
    } catch {
      // Another owner exists now; the quarantined copy is safe to drop.
    }
  }
  await unlink(quarantine).catch(() => {});
}

async function acquireLock(runtimeDir: string, graceMs: number): Promise<LockHandle | null> {
  const path = join(runtimeDir, LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle: FileHandle | null = null;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      await handle.close();
      return { release: () => releaseLock(path) };
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => {});
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = await readLockPid(path);
      // A readable pid that is still alive owns startup. Only a dead/missing pid
      // (or an old unparseable lock) is safe to recover, so a slow but live
      // starter cannot be duplicated.
      if (pid !== null && isProcessAlive(pid)) return null;
      if (!(await lockIsStale(path, graceMs))) return null;
      await recoverStaleLock(path);
    }
  }
  return null;
}

// ── Spawning ────────────────────────────────────────────────────────────────

function spawnServer(options: {
  runtimeDir: string;
  preferredPort: number;
  idleMs?: number;
  producerTtlMs?: number;
  webRoot?: string;
  serverEntry?: string;
  spawnImpl: typeof spawn;
  env: NodeJS.ProcessEnv;
}): ChildProcess {
  const entry = options.serverEntry ?? dashboardServerEntry();
  const args = [
    "--experimental-strip-types",
    "--no-warnings",
    entry,
    "--runtime-dir",
    options.runtimeDir,
    "--preferred-port",
    String(options.preferredPort),
    "--log-file",
    join(options.runtimeDir, LOG_FILE),
  ];
  if (options.idleMs !== undefined) args.push("--idle-ms", String(options.idleMs));
  if (options.producerTtlMs !== undefined) args.push("--producer-ttl-ms", String(options.producerTtlMs));
  if (options.webRoot !== undefined) args.push("--web-root", options.webRoot);
  const child = options.spawnImpl(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
    env: options.env,
  });
  child.unref();
  return child;
}

async function logTail(runtimeDir: string): Promise<string> {
  try {
    const raw = await readFile(join(runtimeDir, LOG_FILE), "utf8");
    return raw.slice(-2_000).trim();
  } catch {
    return "";
  }
}

/**
 * Wait until an authenticated dashboard server answers for the runtime directory.
 * A child that loses the OS singleton exits with `SINGLETON_EXIT_CODE`; that is
 * not a failure, it means the winner is (or is about to be) serving, so we keep
 * polling and adopt the winner's address. A child that crashed for another
 * reason fails fast with the log tail.
 */
async function waitForSpawnedServer(
  child: ChildProcess,
  options: { runtimeDir: string; timeoutMs: number; fetchImpl: typeof fetch },
): Promise<DashboardAddress> {
  const deadline = Date.now() + options.timeoutMs;
  let exitedAt: number | null = null;
  while (Date.now() < deadline) {
    const hint = await readAddressHint(options.runtimeDir);
    if (hint !== null && (await checkDashboardHealth(hint, { fetchImpl: options.fetchImpl, timeoutMs: 750 }))) {
      // `owned` is about who serves, not who spawned: our child may have lost the
      // singleton to a concurrent starter and that winner is the shared server.
      return { ...hint, owned: hint.pid === child.pid };
    }
    const exited = child.exitCode !== null || child.signalCode !== null;
    if (exited) {
      exitedAt ??= Date.now();
      const code = child.exitCode;
      // Losing the singleton is expected under concurrency: keep waiting for the
      // winner's metadata/health. Any other exit is a real startup failure.
      if (code !== SINGLETON_EXIT_CODE && Date.now() - exitedAt > 750) {
        const tail = await logTail(options.runtimeDir);
        throw new Error(
          `dashboard server exited during startup (code ${String(code ?? child.signalCode)})` +
            (tail === "" ? "" : `: ${tail}`),
        );
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  const tail = await logTail(options.runtimeDir);
  const code = child.exitCode ?? child.signalCode;
  throw new Error(
    `dashboard server did not become healthy within ${options.timeoutMs}ms` +
      (code === null ? "" : ` (spawned process exited ${String(code)})`) +
      (tail === "" ? "" : `: ${tail}`),
  );
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Reuse the healthy shared server for `runtimeDir`, or start exactly one under a
 * cross-process lock and return its address. Concurrent callers (in this process
 * or others) converge on the same instance.
 */
export async function ensureDashboard(options: EnsureDashboardOptions = {}): Promise<DashboardAddress> {
  const runtimeDir = await ensurePrivateRuntimeDir(options.runtimeDir ?? defaultRuntimeDir());
  const fetchImpl = options.fetchImpl ?? fetch;
  const acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const lockGraceMs = options.lockGraceMs ?? DEFAULT_LOCK_GRACE_MS;
  const preferredPort = options.preferredPort ?? DEFAULT_PREFERRED_PORT;
  const deadline = Date.now() + acquireTimeoutMs;

  while (true) {
    const existing = await readAddressHint(runtimeDir);
    if (existing !== null && (await checkDashboardHealth(existing, { fetchImpl }))) {
      return { ...existing, owned: false };
    }

    const lock = await acquireLock(runtimeDir, lockGraceMs);
    if (lock !== null) {
      try {
        // Another process may have finished between our health check and the
        // lock acquisition; re-check before spawning anything.
        const ready = await readAddressHint(runtimeDir);
        if (ready !== null && (await checkDashboardHealth(ready, { fetchImpl }))) {
          return { ...ready, owned: false };
        }
        const child = spawnServer({
          runtimeDir,
          preferredPort,
          idleMs: options.idleMs,
          producerTtlMs: options.producerTtlMs,
          webRoot: options.webRoot === undefined ? undefined : resolve(options.webRoot),
          serverEntry: options.serverEntry,
          spawnImpl: options.spawnImpl ?? spawn,
          env: options.env ?? process.env,
        });
        return await waitForSpawnedServer(child, { runtimeDir, timeoutMs: startupTimeoutMs, fetchImpl });
      } finally {
        await lock.release();
      }
    }

    if (Date.now() >= deadline) {
      const tail = await logTail(runtimeDir);
      throw new Error(
        `timed out after ${acquireTimeoutMs}ms waiting for the dashboard server in ${runtimeDir}` +
          (tail === "" ? "" : `: ${tail}`),
      );
    }
    await sleep(POLL_INTERVAL_MS + Math.random() * POLL_INTERVAL_MS);
  }
}

/**
 * Stop a dashboard server by address. Used by tests and by an explicit user
 * action; normal Pi sessions do not stop the shared server, they just unregister
 * their producer and let the idle sweep decide.
 *
 * The metadata pid is never signaled on trust: a reused pid could belong to an
 * unrelated process. A SIGTERM is only sent after the address answers an
 * authenticated health check with the exact instance id, port, and pid. The
 * SIGKILL fallback re-verifies too, so a pid recycled during the grace period is
 * not killed.
 */
export async function stopDashboard(
  address: Pick<DashboardAddress, "pid" | "runtimeDir" | "instanceId" | "url" | "port" | "producerToken">,
  options: StopDashboardOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const verified = await checkDashboardHealth(address, { timeoutMs: 1_000 });
  if (!verified) {
    // Stale metadata, or the port now belongs to something else: clean the
    // metadata (only if it still names this instance) and never signal the pid.
    if (!isProcessAlive(address.pid)) await removeRuntimeMetadata(address.runtimeDir, address.instanceId);
    return false;
  }
  let signaled = false;
  try {
    process.kill(address.pid, "SIGTERM");
    signaled = true;
  } catch {
    return false;
  }
  if (!signaled) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(address.pid)) {
      await removeRuntimeMetadata(address.runtimeDir, address.instanceId);
      return true;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  // Last resort only if the process still proves it is our server.
  if (await checkDashboardHealth(address, { timeoutMs: 1_000 })) {
    try {
      process.kill(address.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await removeRuntimeMetadata(address.runtimeDir, address.instanceId);
  return true;
}

/** Stop whatever server the runtime directory currently points at, if any. */
export async function stopDashboardByRuntimeDir(
  runtimeDir: string = defaultRuntimeDir(),
  options: StopDashboardOptions = {},
): Promise<boolean> {
  const dir = resolve(runtimeDir);
  const hint = await readAddressHint(dir);
  if (hint === null) return false;
  return stopDashboard(hint, options);
}
