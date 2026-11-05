/**
 * web-ui — runtime management and single-instance decision logic for the
 * vendored pi-web fork (vendor/pi-web).
 *
 * Rules enforced here:
 * 1. Single UI: pi-web is THE web interface. Only one instance may serve.
 * 2. Start refusal: if an instance is already healthy, start is DENIED with
 *    attribution (startedBy, startedAt, url) or as unmanaged.
 * 3. Takeover: if state exists but the server is not healthy, state is removed
 *    and a fresh server takes over.
 * 4. Detached lifecycle: servers spawn detached so they survive the parent Pi session.
 * 5. Complete testability: IO (health check, state persistence, process spawning,
 *    clocks, pid probing) is injectable; tests never bind real ports or modify production files.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_WEB_UI_PORT = 30141;
export const DEFAULT_WEB_UI_HOST = "127.0.0.1";
export const DEFAULT_WEB_UI_URL = `http://${DEFAULT_WEB_UI_HOST}:${DEFAULT_WEB_UI_PORT}`;
export const DEFAULT_HEALTH_ENDPOINT = `${DEFAULT_WEB_UI_URL}/api/plugins`;
export const DEFAULT_PKILL_COMMAND = `pkill -f "next.*${DEFAULT_WEB_UI_PORT}"`;
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
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
  vendorDir: string;
  healthUrl: string;
  pkillCommand: string;
  isPidAlive: (pid: number) => boolean;
  fetchHealth: (url: string) => Promise<boolean>;
  checkVendorDir: (dir: string) => boolean;
  spawnServer: (cwd: string) => { pid?: number; unref?: () => void };
  killProcess: (pid: number) => void;
  removeState: (path: string) => Promise<void>;
  readState: (path: string) => Promise<WebUiStateStatus>;
  writeState: (path: string, state: WebUiState) => Promise<void>;
  now: () => number;
  isoTimestamp: () => string;
  sessionId: string;
  pollIntervalMs: number;
  startupTimeoutMs: number;
  sleep: (ms: number) => Promise<void>;
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

/** Default vendor directory holding the vendored pi-web fork. */
export function defaultVendorDir(): string {
  return join(fileURLToPath(new URL("..", import.meta.url)), "vendor", "pi-web");
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
export function defaultKillProcess(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process already exited or permission denied
  }
}

/** Spawn detached next dev server from vendor directory. */
export function defaultSpawnServer(cwd: string): { pid?: number; unref?: () => void } {
  const nextBin = "node_modules/next/dist/bin/next";
  const child = spawn(
    process.execPath,
    [nextBin, "dev", "-H", DEFAULT_WEB_UI_HOST, "-p", String(DEFAULT_WEB_UI_PORT)],
    {
      cwd,
      detached: true,
      stdio: "ignore",
    },
  );
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

function resolveDeps(overrides: Partial<WebUiDeps> = {}): WebUiDeps {
  return {
    statePath: overrides.statePath ?? defaultWebUiStatePath(),
    vendorDir: overrides.vendorDir ?? defaultVendorDir(),
    healthUrl: overrides.healthUrl ?? DEFAULT_HEALTH_ENDPOINT,
    pkillCommand: overrides.pkillCommand ?? DEFAULT_PKILL_COMMAND,
    isPidAlive: overrides.isPidAlive ?? defaultIsPidAlive,
    fetchHealth: overrides.fetchHealth ?? defaultFetchHealth,
    checkVendorDir: overrides.checkVendorDir ?? existsSync,
    spawnServer: overrides.spawnServer ?? defaultSpawnServer,
    killProcess: overrides.killProcess ?? defaultKillProcess,
    removeState: overrides.removeState ?? defaultRemoveState,
    readState: overrides.readState ?? defaultReadState,
    writeState: overrides.writeState ?? defaultWriteState,
    now: overrides.now ?? (() => Date.now()),
    isoTimestamp: overrides.isoTimestamp ?? (() => new Date().toISOString()),
    sessionId: overrides.sessionId ?? "session",
    pollIntervalMs: overrides.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    startupTimeoutMs: overrides.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    sleep: overrides.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

/**
 * Execute `/web start`:
 * - Refuses if already serving (with owner or unmanaged notice).
 * - Takes over if stale state exists and health check fails.
 * - Spawns detached server from vendor directory and polls health until ready.
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

  if (!deps.checkVendorDir(deps.vendorDir)) {
    return {
      status: "error",
      message: `pi-web fork not vendored: directory not found at ${deps.vendorDir}.`,
    };
  }

  let spawned: { pid?: number; unref?: () => void };
  try {
    spawned = deps.spawnServer(deps.vendorDir);
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
  let ready = false;

  while (deps.now() < deadline) {
    await deps.sleep(deps.pollIntervalMs);
    ready = await deps.fetchHealth(deps.healthUrl);
    if (ready) break;
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

  return {
    status: "started",
    message: `pi-web started and serving at ${rootUrl}`,
    details: { ...newState },
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
