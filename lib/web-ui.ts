/**
 * web-ui — runtime management and single-instance decision logic for the
 * minimal pi-web server (web/).
 *
 * Rules enforced here:
 * 1. Single UI: pi-web is THE web interface. Only one instance may serve.
 * 2. Start refusal: if an instance is already healthy, start is DENIED with
 *    attribution (startedBy, startedAt, url) or as unmanaged.
 * 3. Takeover: if state exists but the server is not healthy, state is removed
 *    and a fresh server takes over.
 * 4. Detached lifecycle: servers spawn detached so they survive the parent Pi session.
 * 5. Production serving: `/web start` serves the built client, running the
 *    esbuild bundle first when no build output exists, when a rebuild is asked for,
 *    or when the sources changed since the last build. Dev mode is never used.
 * 5a. Reload: `/web reload` stops a managed server, waits for it to go down, and starts it
 *    again (rebuilding when needed). A running session reloads on its own when our sources change.
 * 6. Complete testability: IO (health check, state persistence, process spawning,
 *    clocks, pid probing) is injectable; tests never bind real ports or modify production files.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireReloadLock,
  buildRecordPath,
  evaluateChange,
  readBuildRecord,
  reloadLockPath,
  repoRootFromServerDir,
  sourceFingerprints,
  writeBuildRecord,
  type BuildRecord,
  type SourceChange,
  type SourceFingerprints,
} from "./web-ui-reload.ts";

export const DEFAULT_WEB_UI_PORT = 30142;
export const DEFAULT_WEB_UI_HOST = "127.0.0.1";
export const DEFAULT_WEB_UI_URL = `http://${DEFAULT_WEB_UI_HOST}:${DEFAULT_WEB_UI_PORT}`;
export const DEFAULT_HEALTH_ENDPOINT = `${DEFAULT_WEB_UI_URL}/api/health`;
export const DEFAULT_PKILL_COMMAND = `pkill -f "pi-web-minimal"`;
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_BUILD_TIMEOUT_MS = 600_000;
export const DEFAULT_BUILD_MARKER = "client/dist/app.js";
export const DEFAULT_POLL_INTERVAL_MS = 250;

export interface WebUiState {
  pid: number;
  port: number;
  url: string;
  startedBy: string;
  startedAt: string;
}

export type WebUiStateStatus = WebUiState | null | "corrupt";

export type StartDecision =
  | { action: "deny_running"; state: WebUiState }
  | { action: "deny_unmanaged" }
  | { action: "take_over_stale"; state: WebUiState | "corrupt" }
  | { action: "start" };

export type StopDecision =
  | { action: "kill"; pid: number }
  | { action: "unmanaged_running" }
  | { action: "not_running"; cleanStaleState: boolean };

export interface StatusReport {
  serving: boolean;
  matchesReality: boolean;
  url: string;
  owner?: string;
  startedAt?: string;
  pid?: number;
  unmanaged?: boolean;
  corrupt?: boolean;
  message: string;
}

export interface WebUiCommandResult {
  status: "started" | "denied" | "stopped" | "info" | "error";
  message: string;
  details?: Record<string, unknown>;
}

export interface WebUiDeps {
  statePath: string;
  serverDir: string;
  healthUrl: string;
  pkillCommand: string;
  isPidAlive: (pid: number) => boolean;
  fetchHealth: (url: string) => Promise<boolean>;
  checkServerDir: (dir: string) => boolean;
  spawnServer: (cwd: string) => { pid?: number; unref?: () => void };
  hasBuild: (cwd: string) => boolean;
  buildServer: (cwd: string) => Promise<{ ok: boolean; error?: string }>;
  rebuild: boolean;
  /** Fingerprints of the build inputs and our runtime inputs right now. */
  fingerprints: () => Promise<SourceFingerprints>;
  /** The record of the last successful build and start, or null when there is none. */
  readRecord: () => Promise<BuildRecord | null>;
  /** Persist the fingerprints captured before a build or start. */
  writeRecord: (fingerprints: SourceFingerprints) => Promise<void>;
  /** Take the cross-session reload lock; null when another reload holds it. */
  acquireReloadLock: () => (() => void) | null;
  killProcess: (pid: number) => void;
  /** Force-stop a server that ignored SIGTERM (Next waits for open connections before it exits). */
  forceKillProcess: (pid: number) => void;
  /** How long a stopping server may take after SIGTERM before it is force-killed. */
  stopGraceMs: number;
  removeState: (path: string) => Promise<void>;
  readState: (path: string) => Promise<WebUiStateStatus>;
  writeState: (path: string, state: WebUiState) => Promise<void>;
  now: () => number;
  isoTimestamp: () => string;
  sessionId: string;
  pollIntervalMs: number;
  startupTimeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  /** Receives each phase and periodic progress line (`Building… 2m 05s`). Defaults to silence. */
  onProgress: (message: string) => void;
}

/** Pure decision for start requests based on current health and persisted state. */
export function decideStart(state: WebUiStateStatus, healthy: boolean): StartDecision {
  if (healthy) {
    if (state && state !== "corrupt") {
      return { action: "deny_running", state };
    }
    return { action: "deny_unmanaged" };
  }
  if (state !== null) {
    return { action: "take_over_stale", state };
  }
  return { action: "start" };
}

/** Pure decision for stop requests based on state, health, and process liveness. */
export function decideStop(
  state: WebUiStateStatus,
  healthy: boolean,
  isPidAlive: (pid: number) => boolean,
): StopDecision {
  if (state && state !== "corrupt") {
    if (isPidAlive(state.pid)) {
      return { action: "kill", pid: state.pid };
    }
    if (healthy) {
      return { action: "unmanaged_running" };
    }
    return { action: "not_running", cleanStaleState: true };
  }
  if (healthy) {
    return { action: "unmanaged_running" };
  }
  return { action: "not_running", cleanStaleState: state === "corrupt" };
}

/** Pure report generator for status requests. */
export function decideStatus(
  state: WebUiStateStatus,
  healthy: boolean,
  isPidAlive: (pid: number) => boolean,
): StatusReport {
  if (healthy) {
    if (state && state !== "corrupt") {
      const alive = isPidAlive(state.pid);
      if (alive) {
        return {
          serving: true,
          matchesReality: true,
          url: state.url,
          owner: state.startedBy,
          startedAt: state.startedAt,
          pid: state.pid,
          message: `pi-web is serving at ${state.url}\nPID: ${state.pid}\nStarted by: ${state.startedBy}\nStarted at: ${state.startedAt}\nState matches reality: yes`,
        };
      }
      return {
        serving: true,
        matchesReality: false,
        url: state.url,
        owner: state.startedBy,
        startedAt: state.startedAt,
        pid: state.pid,
        message: `pi-web is serving at ${state.url}\nPID in state file (${state.pid}) is not running.\nStarted by: ${state.startedBy}\nStarted at: ${state.startedAt}\nState matches reality: no (serving, but state PID is dead)`,
      };
    }
    const isCorrupt = state === "corrupt";
    return {
      serving: true,
      matchesReality: false,
      url: DEFAULT_WEB_UI_URL,
      unmanaged: true,
      corrupt: isCorrupt,
      message: `pi-web is serving at ${DEFAULT_WEB_UI_URL}\nOwner: unmanaged (${isCorrupt ? "state file is corrupt" : "no state file found"})\nState matches reality: no (serving without managed state file)`,
    };
  }

  if (state && state !== "corrupt") {
    return {
      serving: false,
      matchesReality: false,
      url: state.url,
      owner: state.startedBy,
      startedAt: state.startedAt,
      pid: state.pid,
      message: `pi-web is not serving.\nStale state file exists (PID ${state.pid}, started by ${state.startedBy} at ${state.startedAt}).\nState matches reality: no (state file exists but server is not responding)`,
    };
  }

  if (state === "corrupt") {
    return {
      serving: false,
      matchesReality: false,
      url: DEFAULT_WEB_UI_URL,
      corrupt: true,
      message: `pi-web is not serving.\nCorrupt state file exists.\nState matches reality: no (corrupt state file exists but server is not responding)`,
    };
  }

  return {
    serving: false,
    matchesReality: true,
    url: DEFAULT_WEB_UI_URL,
    message: `pi-web is not serving.\nState matches reality: yes`,
  };
}

/** Default runtime path for the web-ui state file. */
export function defaultWebUiStatePath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "web-ui-state.json");
}

/** Default directory holding the minimal pi-web server package. */
export function defaultServerDir(): string {
  return join(fileURLToPath(new URL("..", import.meta.url)), "web");
}

/** Check if process is alive without signaling side effects. */
export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Default health check via loopback HTTP GET request. */
export async function defaultFetchHealth(url = DEFAULT_HEALTH_ENDPOINT): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Kill process gracefully with SIGTERM. */
/** Grace period for a SIGTERM'd server before /web reload force-kills it. */
const DEFAULT_STOP_GRACE_MS = 10_000;

function defaultForceKillProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already exited, or permission denied.
  }
}

export function defaultKillProcess(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process already exited or permission denied
  }
}

/** Arguments for serving the built client: the minimal server, run directly. */
export function serverSpawnArgs(): string[] {
  return ["--experimental-strip-types", "server/main.ts"];
}

/** True when the built client output exists to serve. */
export function defaultHasBuild(cwd: string): boolean {
  return existsSync(join(cwd, DEFAULT_BUILD_MARKER));
}

/** Run the esbuild bundle; resolve with the failure tail on error. */
export function defaultBuildServer(
  cwd: string,
  timeoutMs = DEFAULT_BUILD_TIMEOUT_MS,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["build.mjs"], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, error: `build timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      const tail = stderr
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .slice(-6)
        .join(" / ");
      resolve({ ok: false, error: `exit ${code}${tail ? `: ${tail}` : ""}` });
    });
  });
}

/** Spawn the detached minimal server: one direct node process, so SIGTERM
 * reaches the server itself (no npm/tsx wrapper holding its stdio open). */
export function defaultSpawnServer(cwd: string): { pid?: number; unref?: () => void } {
  const child = spawn(process.execPath, serverSpawnArgs(), {
    cwd,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PI_WEB_PORT: String(DEFAULT_WEB_UI_PORT) },
  });
  child.unref();
  return { pid: child.pid, unref: () => child.unref() };
}

/** Read and parse web-ui state from disk. */
export async function defaultReadState(statePath: string): Promise<WebUiStateStatus> {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.pid === "number" &&
      typeof parsed.port === "number" &&
      typeof parsed.url === "string" &&
      typeof parsed.startedBy === "string" &&
      typeof parsed.startedAt === "string"
    ) {
      return parsed as WebUiState;
    }
    return "corrupt";
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    return "corrupt";
  }
}

/** Write web-ui state to disk atomically. */
export async function defaultWriteState(statePath: string, state: WebUiState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

/** Remove state file if present. */
export async function defaultRemoveState(statePath: string): Promise<void> {
  try {
    await unlink(statePath);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

/** Human elapsed time for progress lines: `42s`, then `2m 05s`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

/** Emits a progress line only when the displayed second changes, so a fast poll does not flood the UI. */
function throttledProgress(deps: WebUiDeps, label: (elapsed: string) => string): (elapsedMs: number) => void {
  let last = -1;
  return (elapsedMs) => {
    const second = Math.floor(elapsedMs / 1000);
    if (second === last) return;
    last = second;
    deps.onProgress(label(formatElapsed(elapsedMs)));
  };
}

function resolveDeps(overrides: Partial<WebUiDeps> = {}): WebUiDeps {
  const statePath = overrides.statePath ?? defaultWebUiStatePath();
  const serverDir = overrides.serverDir ?? defaultServerDir();
  return {
    statePath,
    serverDir,
    healthUrl: overrides.healthUrl ?? DEFAULT_HEALTH_ENDPOINT,
    pkillCommand: overrides.pkillCommand ?? DEFAULT_PKILL_COMMAND,
    isPidAlive: overrides.isPidAlive ?? defaultIsPidAlive,
    fetchHealth: overrides.fetchHealth ?? defaultFetchHealth,
    checkServerDir: overrides.checkServerDir ?? existsSync,
    spawnServer: overrides.spawnServer ?? defaultSpawnServer,
    hasBuild: overrides.hasBuild ?? defaultHasBuild,
    buildServer: overrides.buildServer ?? defaultBuildServer,
    rebuild: overrides.rebuild ?? false,
    fingerprints: overrides.fingerprints ?? (async () => sourceFingerprints(serverDir, repoRootFromServerDir(serverDir))),
    readRecord: overrides.readRecord ?? (() => readBuildRecord(buildRecordPath(statePath))),
    writeRecord: overrides.writeRecord ?? ((fingerprints) =>
      writeBuildRecord(buildRecordPath(statePath), { ...fingerprints, builtAt: new Date().toISOString() })),
    acquireReloadLock: overrides.acquireReloadLock ?? (() => acquireReloadLock(reloadLockPath(statePath), defaultIsPidAlive)),
    killProcess: overrides.killProcess ?? defaultKillProcess,
    forceKillProcess: overrides.forceKillProcess ?? defaultForceKillProcess,
    stopGraceMs: overrides.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
    removeState: overrides.removeState ?? defaultRemoveState,
    readState: overrides.readState ?? defaultReadState,
    writeState: overrides.writeState ?? defaultWriteState,
    now: overrides.now ?? (() => Date.now()),
    isoTimestamp: overrides.isoTimestamp ?? (() => new Date().toISOString()),
    sessionId: overrides.sessionId ?? "session",
    pollIntervalMs: overrides.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    startupTimeoutMs: overrides.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    sleep: overrides.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    onProgress: overrides.onProgress ?? (() => undefined),
  };
}

/**
 * Execute `/web start`:
 * - Refuses if already serving (with owner or unmanaged notice).
 * - Takes over if stale state exists and health check fails.
 * - Spawns detached server from the web package directory and polls health until ready.
 */
export async function startWebUi(options: Partial<WebUiDeps> = {}): Promise<WebUiCommandResult> {
  const deps = resolveDeps(options);
  const healthy = await deps.fetchHealth(deps.healthUrl);
  const state = await deps.readState(deps.statePath);
  const decision = decideStart(state, healthy);

  if (decision.action === "deny_running") {
    return {
      status: "denied",
      message: `pi-web is already serving at ${decision.state.url} (started by session ${decision.state.startedBy} at ${decision.state.startedAt}). No new instance was started.`,
      details: { ...decision.state },
    };
  }

  if (decision.action === "deny_unmanaged") {
    const rootUrl = deps.healthUrl.replace(/\/api\/plugins.*$/, "");
    return {
      status: "denied",
      message: `pi-web is already serving at ${rootUrl} as an unmanaged instance (no valid state file found; cannot attribute an owner). No new instance was started.`,
      details: { url: rootUrl, unmanaged: true },
    };
  }

  if (decision.action === "take_over_stale") {
    await deps.removeState(deps.statePath);
  }

  if (!deps.checkServerDir(deps.serverDir)) {
    return {
      status: "error",
      message: `minimal pi-web server package not found: directory missing at ${deps.serverDir}.`,
    };
  }

  // Fingerprint before building or starting: a source edit made during the build
  // must count as a change next time, not as already built.
  const before = await deps.fingerprints();
  const change: SourceChange = evaluateChange(before, await deps.readRecord());

  // Serve the built client. Build when there is no output, when a rebuild is asked
  // for, or when the sources changed since the last build. The minimal server
  // serves static files from the bundle, and dev mode is not what this command runs.
  const rebuildReason = deps.rebuild
    ? "rebuild requested"
    : !deps.hasBuild(deps.serverDir)
      ? "no build output"
      : change.build
        ? "sources changed since the last build"
        : undefined;
  if (rebuildReason) {
    deps.onProgress(`Building pi-web production build (${rebuildReason})…`);
    const buildStarted = deps.now();
    // A build can run for minutes, so report its elapsed time every ten seconds.
    const heartbeat = setInterval(() => {
      deps.onProgress(`Building pi-web… ${formatElapsed(deps.now() - buildStarted)} elapsed`);
    }, 10_000);
    const built = await deps.buildServer(deps.serverDir).finally(() => clearInterval(heartbeat));
    if (built.ok) deps.onProgress(`Build finished in ${formatElapsed(deps.now() - buildStarted)}.`);
    if (!built.ok) {
      return {
        status: "error",
        message: `pi-web production build failed: ${built.error ?? "unknown error"}. No server was started.`,
      };
    }
  }

  let spawned: { pid?: number; unref?: () => void };
  deps.onProgress("Starting pi-web server…");
  try {
    spawned = deps.spawnServer(deps.serverDir);
  } catch (error: any) {
    return {
      status: "error",
      message: `Failed to spawn pi-web server: ${error?.message ?? String(error)}`,
    };
  }

  const pid = spawned.pid;
  if (!pid) {
    return {
      status: "error",
      message: "Failed to spawn pi-web server (no process ID returned).",
    };
  }

  const deadline = deps.now() + deps.startupTimeoutMs;
  const waitStarted = deps.now();
  const reportWait = throttledProgress(deps, (elapsed) => `Waiting for pi-web to answer… ${elapsed}`);
  let ready = false;

  while (deps.now() < deadline) {
    await deps.sleep(deps.pollIntervalMs);
    ready = await deps.fetchHealth(deps.healthUrl);
    if (ready) break;
    reportWait(deps.now() - waitStarted);
  }

  if (!ready) {
    deps.killProcess(pid);
    await deps.removeState(deps.statePath);
    return {
      status: "error",
      message: `pi-web server failed to become healthy within ${Math.round(deps.startupTimeoutMs / 1000)}s. Cleaned up spawned process (PID ${pid}).`,
    };
  }

  const rootUrl = deps.healthUrl.replace(/\/api\/plugins.*$/, "");
  const newState: WebUiState = {
    pid,
    port: DEFAULT_WEB_UI_PORT,
    url: rootUrl,
    startedBy: deps.sessionId,
    startedAt: deps.isoTimestamp(),
  };

  try {
    await deps.writeState(deps.statePath, newState);
  } catch (error: any) {
    return {
      status: "error",
      message: `pi-web started but failed to write state file: ${error?.message ?? String(error)}`,
      details: { ...newState },
    };
  }

  // A failed record only costs a rebuild on the next start, so it does not fail the start.
  await deps.writeRecord(before).catch(() => undefined);

  return {
    status: "started",
    message: `pi-web started and serving at ${rootUrl}${rebuildReason ? ` (built: ${rebuildReason})` : ""}`,
    details: { ...newState, ...(rebuildReason ? { rebuilt: rebuildReason } : {}) },
  };
}

/**
 * Execute `/web stop`:
 * - If state file has a live pid: kill process, remove state file, confirm.
 * - If serving but unmanaged: instruct user to kill manually with pkill command.
 * - If not serving: report not running.
 */
export async function stopWebUi(options: Partial<WebUiDeps> = {}): Promise<WebUiCommandResult> {
  const deps = resolveDeps(options);
  const state = await deps.readState(deps.statePath);
  const healthy = await deps.fetchHealth(deps.healthUrl);
  const decision = decideStop(state, healthy, deps.isPidAlive);

  if (decision.action === "kill") {
    deps.killProcess(decision.pid);
    await deps.removeState(deps.statePath);
    return {
      status: "stopped",
      message: `pi-web (PID ${decision.pid}) stopped.`,
      details: { pid: decision.pid },
    };
  }

  if (decision.action === "unmanaged_running") {
    if (state !== null) {
      await deps.removeState(deps.statePath);
    }
    return {
      status: "info",
      message: `pi-web is serving as an unmanaged instance. Kill it manually with:\n  ${deps.pkillCommand}`,
      details: { unmanaged: true, pkillCommand: deps.pkillCommand },
    };
  }

  if (decision.cleanStaleState) {
    await deps.removeState(deps.statePath);
  }

  return {
    status: "info",
    message: "pi-web is not running.",
  };
}

/**
 * Execute `/web status`:
 * - Reports whether server is healthy.
 * - Reports owner, start timestamp, and URL if known.
 * - Reports whether state file accurately matches reality.
 */
export async function statusWebUi(options: Partial<WebUiDeps> = {}): Promise<WebUiCommandResult> {
  const deps = resolveDeps(options);
  const healthy = await deps.fetchHealth(deps.healthUrl);
  const state = await deps.readState(deps.statePath);
  const report = decideStatus(state, healthy, deps.isPidAlive);

  return {
    status: "info",
    message: report.message,
    details: { ...report },
  };
}

/**
 * Wait until the old server is gone: no longer answering and its process has exited, so a
 * new server never races it for the port. A server with open connections can outlive
 * SIGTERM (Next waits for every connection), so after the grace period it is force-killed.
 */
async function waitUntilDown(deps: WebUiDeps, pid: number): Promise<boolean> {
  const started = deps.now();
  const deadline = started + deps.startupTimeoutMs;
  let forced = false;
  const reportWait = throttledProgress(deps, (elapsed) => `Waiting for the old pi-web to stop… ${elapsed}`);
  while (deps.now() < deadline) {
    const answering = await deps.fetchHealth(deps.healthUrl);
    if (!answering && !deps.isPidAlive(pid)) return true;
    if (!forced && deps.now() - started >= deps.stopGraceMs) {
      deps.onProgress(`pi-web (PID ${pid}) did not stop after SIGTERM; force-killing it.`);
      deps.forceKillProcess(pid);
      forced = true;
    }
    reportWait(deps.now() - started);
    await deps.sleep(deps.pollIntervalMs);
  }
  return false;
}

/**
 * Execute `/web reload`: stop the managed server, wait until it is down, then start it
 * again, rebuilding when the sources changed. An unmanaged server is not ours to restart.
 */
export async function reloadWebUi(options: Partial<WebUiDeps> = {}): Promise<WebUiCommandResult> {
  const deps = resolveDeps(options);
  const state = await deps.readState(deps.statePath);
  const healthy = await deps.fetchHealth(deps.healthUrl);
  const decision = decideStop(state, healthy, deps.isPidAlive);

  if (decision.action === "unmanaged_running") {
    return {
      status: "info",
      message: `pi-web is serving as an unmanaged instance, so /web reload cannot restart it. Kill it with:\n  ${deps.pkillCommand}\nthen run /web start.`,
      details: { unmanaged: true, pkillCommand: deps.pkillCommand },
    };
  }
  if (decision.action === "kill") {
    deps.onProgress(`Stopping pi-web (PID ${decision.pid})…`);
    deps.killProcess(decision.pid);
    await deps.removeState(deps.statePath);
    if (!(await waitUntilDown(deps, decision.pid))) {
      return {
        status: "error",
        message: `pi-web (PID ${decision.pid}) did not stop within ${Math.round(deps.startupTimeoutMs / 1000)}s. No second instance was started on the same port.`,
      };
    }
  } else if (decision.cleanStaleState) {
    await deps.removeState(deps.statePath);
  }

  deps.onProgress("pi-web is stopped; starting it again…");
  const started = await startWebUi(deps);
  return { ...started, message: `pi-web reloaded. ${started.message}` };
}

export type AutoReloadResult =
  | { status: "idle" | "unchanged" | "busy" }
  | WebUiCommandResult;

/**
 * The automatic reload a running session triggers when our sources change. It acts only
 * on a managed server that is up, and only when the sources differ from what it runs.
 * The reload lock is shared, so two sessions watching the same tree reload once.
 */
export async function reloadWebUiIfChanged(options: Partial<WebUiDeps> = {}): Promise<AutoReloadResult> {
  const deps = resolveDeps(options);
  const state = await deps.readState(deps.statePath);
  const healthy = await deps.fetchHealth(deps.healthUrl);
  if (!healthy || !state || state === "corrupt") return { status: "idle" };

  const change = evaluateChange(await deps.fingerprints(), await deps.readRecord());
  if (!change.build && !change.runtime) return { status: "unchanged" };

  const release = deps.acquireReloadLock();
  if (!release) return { status: "busy" };
  deps.onProgress(change.build ? "pi-web sources changed: rebuilding and reloading…" : "pi-web plugin code changed: reloading…");
  try {
    return await reloadWebUi(deps);
  } finally {
    release();
  }
}
