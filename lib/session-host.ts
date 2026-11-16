// Command construction for the optional headless session host. The I/O lives
// in web/core/server/session-host.ts; keeping the argument and environment
// decisions here makes them testable without spawning pi or binding a port.

import { join } from "node:path";

export interface SessionHostRequest {
  sessionId: string;
  cwd: string;
  serverUrl: string;
  /** Absolute path to the web extension the owner uses to attach its bridge. */
  extensionPath: string;
  /** Resume this session file instead of creating a new session. */
  sessionFile?: string;
}

/** Directory under the agent dir holding one pid file per hosted session. */
export const SESSION_HOST_PID_DIR = "web-session-hosts";

/**
 * Stable-session hosting is on for real servers; PI_WEB_SESSION_HOST=0 opts
 * out. FIFO-backed RPC stdin is POSIX-only, so Windows keeps in-process
 * sessions until a portable owner transport exists.
 */
export function externalSessionHostEnabled(env: NodeJS.ProcessEnv, platform: string): boolean {
  return env.PI_WEB_SESSION_HOST === "1" && platform !== "win32";
}

/** True only inside the detached owner, never in a TUI that inherited the flag. */
export function isSessionHostProcess(env: NodeJS.ProcessEnv): boolean {
  return env.PI_WEB_SESSION_HOST_OWNER === "1" && env.PI_WEB_SERVER_PROCESS !== "1";
}

/** Read a pid written by a hosted-session owner; malformed records are stale. */
export function parseSessionHostPid(text: string): number | null {
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** One pid file per hosted session, under the pi agent dir shared by processes. */
export function sessionHostPidPath(agentDir: string, sessionId: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
  return join(agentDir, SESSION_HOST_PID_DIR, `${sessionId}.pid`);
}

/** The pi CLI invocation for a detached session owner. */
export function sessionHostArgs(request: SessionHostRequest): string[] {
  const args = ["--mode", "rpc", "--session-id", request.sessionId];
  if (request.sessionFile !== undefined) args.push("--session", request.sessionFile);
  // Explicit loading works even when the owner has a minimal agent directory.
  // extensions/web.ts claims a marker so a second discovered copy will not
  // open a duplicate bridge.
  args.push("--extension", request.extensionPath);
  return args;
}

/**
 * The owner is a normal pi process, not the web server: `PI_WEB_SERVER_PROCESS`
 * must be removed or its web extension would refuse to bridge the session back.
 * Auto-reload is off as well — reloading the server is exactly what this
 * process is meant to survive.
 */
export function sessionHostEnv(request: SessionHostRequest, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === "PI_WEB_SERVER_PROCESS" || key === "NODE_TEST_CONTEXT" || key === "PI_WEB_SESSION_HOST_EXTENSION_MARKER") continue;
    if (value !== undefined) child[key] = value;
  }
  child.PI_WEB_URL = request.serverUrl;
  child.PI_WEB_AUTO_RELOAD = "0";
  child.PI_WEB_SESSION_HOST = "1";
  child.PI_WEB_SESSION_HOST_OWNER = "1";
  return child;
}
