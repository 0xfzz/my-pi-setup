// Optional stable owner for web-created sessions.
//
// The default in-process runner keeps an AgentSession inside the HTTP server,
// so replacing that process kills the turn. With PI_WEB_SESSION_HOST=1 the web
// spawns a detached pi RPC process that owns the session and bridges it into
// this server. Replacing the server then only drops the bridge; the owner
// reconnects when the new process is healthy.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultIsPidAlive } from "../../../lib/web-ui.ts";
import {
  externalSessionHostEnabled,
  parseSessionHostPid,
  sessionHostArgs,
  sessionHostEnv,
  sessionHostPidPath,
  type SessionHostRequest,
} from "../../../lib/session-host.ts";

export { externalSessionHostEnabled };

const DEFAULT_START_TIMEOUT_MS = 30_000;
const POLL_MS = 100;

interface HostedProcess {
  child: ChildProcess;
  cleanup: () => void;
}

const hosts = new Map<string, HostedProcess>();

function serverUrl(): string {
  return process.env.PI_WEB_URL ?? `http://127.0.0.1:${process.env.PI_WEB_PORT ?? "30142"}`;
}

function extensionPath(): string {
  return fileURLToPath(new URL("../../../extensions/web.ts", import.meta.url));
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function ownerPidPath(sessionId: string): string {
  return sessionHostPidPath(agentDir(), sessionId);
}

function readOwnerPid(path: string): number | null {
  try {
    return parseSessionHostPid(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function removeOwnerPid(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

/** Spawn a detached pi process that owns `sessionId` and bridges it to this server. */
export async function startSessionHost(options: {
  sessionId: string;
  cwd: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  isAttached: () => boolean;
}): Promise<void> {
  let stderr = "";
  const wait = createAttachmentWaiter(options, () => stderr);
  if (hosts.has(options.sessionId)) {
    await wait(null);
    return;
  }

  // A restarted server has an empty in-memory map but the owner may still be
  // alive and reattaching. Wait for it instead of creating a second AgentSession
  // on the same file.
  const pidPath = ownerPidPath(options.sessionId);
  const existingPid = readOwnerPid(pidPath);
  if (existingPid !== null && existingPid !== process.pid && defaultIsPidAlive(existingPid)) {
    await wait(null);
    return;
  }
  if (existingPid !== null) removeOwnerPid(pidPath);

  const request: SessionHostRequest = {
    sessionId: options.sessionId,
    cwd: options.cwd,
    serverUrl: serverUrl(),
    extensionPath: extensionPath(),
  };
  const tmp = mkdtempSync(join(tmpdir(), "pi-web-session-host-"));
  const fifo = join(tmp, "stdin");
  execFileSync("mkfifo", [fifo], { stdio: "ignore" });
  // r+ keeps a writer alive on the FIFO after this process closes its copy, so
  // an RPC pi does not see EOF when the web server that spawned it restarts.
  const stdin = openSync(fifo, "r+");

  const child = spawn("pi", sessionHostArgs(request), {
    cwd: options.cwd,
    detached: true,
    stdio: [stdin, "ignore", "pipe"],
    env: sessionHostEnv(request),
  });
  closeFifoFd(stdin);
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-2_000);
  });
  child.unref();
  if (child.pid === undefined) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`failed to spawn a session host for ${options.sessionId}`);
  }
  mkdirSync(dirname(pidPath), { recursive: true });
  writeFileSync(pidPath, `${child.pid}\n`);

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    hosts.delete(options.sessionId);
    if (readOwnerPid(pidPath) === child.pid) removeOwnerPid(pidPath);
    rmSync(tmp, { recursive: true, force: true });
  };
  child.once("exit", cleanup);
  hosts.set(options.sessionId, { child, cleanup });

  try {
    await wait(child);
  } catch (error) {
    stopSessionHost(options.sessionId);
    throw error;
  }
}

/** Wait for the bridge to register a hosted session, with its stderr on failure. */
function createAttachmentWaiter(
  options: {
    sessionId: string;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
    isAttached: () => boolean;
  },
  stderr: () => string,
): (child: ChildProcess | null) => Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  return async (child) => {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (options.isAttached()) return;
      if (child?.exitCode !== null && child?.exitCode !== undefined) break;
      await sleep(POLL_MS);
    }
    const detail = stderr().trim();
    throw new Error(`session host for ${options.sessionId} did not attach within ${timeoutMs}ms${detail ? `: ${detail}` : ""}`);
  };
}

export function isSessionHosted(sessionId: string): boolean {
  if (hosts.has(sessionId)) return true;
  const pid = readOwnerPid(ownerPidPath(sessionId));
  return pid !== null && pid !== process.pid && defaultIsPidAlive(pid);
}

/** Stop one hosted owner. Web server shutdown deliberately does NOT call this. */
export function stopSessionHost(sessionId: string): void {
  const host = hosts.get(sessionId);
  const pidPath = ownerPidPath(sessionId);
  const pid = host?.child.pid ?? readOwnerPid(pidPath);
  hosts.delete(sessionId);
  if (pid !== undefined && pid !== null && pid !== process.pid && defaultIsPidAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  host?.cleanup();
  removeOwnerPid(pidPath);
}

function closeFifoFd(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // The child owns its inherited copy.
  }
}
