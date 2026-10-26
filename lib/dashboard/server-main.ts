/**
 * server-main.ts — process entry point for the detached shared dashboard server.
 *
 * `lifecycle.ts` spawns exactly this file (`node --experimental-strip-types`)
 * with `detached: true, stdio: "ignore"`, so the server keeps running after the
 * first Pi session that started it exits. Because stdio is ignored, diagnostics
 * go to a private log file in the runtime directory instead of a parent pipe.
 *
 * Two properties matter here:
 *
 *   - Importing this module must not start anything. Tests import
 *     `parseServerArgs`/`runServerMain` directly; only the main guard below runs
 *     the process (and it runs nothing on import).
 *   - Shutdown must remove the runtime metadata before exiting, so the next
 *     starter does not mistake a dead port for a live server. That removal lives
 *     in `handle.close()`, which is why every exit path goes through it.
 */
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startDashboardServer } from "./server.ts";
import { SINGLETON_EXIT_CODE, SingletonUnavailableError } from "./server.ts";
import type { DashboardServerHandle, DashboardServerOptions } from "./server.ts";

export interface ServerMainConfig {
  options: DashboardServerOptions;
  logFile?: string;
}

function numericArg(name: string, raw: string, min: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) {
    throw new Error(`invalid --${name}: ${raw}`);
  }
  return value;
}

/**
 * Parse `--flag value` / `--flag=value` arguments. Unknown flags are rejected
 * rather than ignored: a typo in the spawn command should fail loudly instead of
 * silently starting a server with the wrong idle/port policy.
 */
const KNOWN_FLAGS = new Set([
  "runtime-dir",
  "preferred-port",
  "idle-ms",
  "producer-ttl-ms",
  "web-root",
  "log-file",
]);

export function parseServerArgs(argv: readonly string[]): ServerMainConfig {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) throw new Error(`unexpected argument: ${item}`);
    const body = item.slice(2);
    const equals = body.indexOf("=");
    if (equals >= 0) {
      const key = body.slice(0, equals);
      if (!KNOWN_FLAGS.has(key)) throw new Error(`unknown flag: --${key}`);
      flags.set(key, body.slice(equals + 1));
      continue;
    }
    if (!KNOWN_FLAGS.has(body)) throw new Error(`unknown flag: --${body}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`missing value for --${body}`);
    flags.set(body, next);
    index += 1;
  }

  const runtimeDir = flags.get("runtime-dir");
  if (runtimeDir === undefined || runtimeDir.trim() === "") throw new Error("--runtime-dir is required");
  const options: DashboardServerOptions = {
    runtimeDir: resolve(runtimeDir),
    preferredPort: flags.has("preferred-port") ? numericArg("preferred-port", flags.get("preferred-port")!, 0) : undefined,
    idleMs: flags.has("idle-ms") ? numericArg("idle-ms", flags.get("idle-ms")!, 0) : undefined,
    producerTtlMs: flags.has("producer-ttl-ms")
      ? numericArg("producer-ttl-ms", flags.get("producer-ttl-ms")!, 1)
      : undefined,
    webRoot: flags.has("web-root") ? resolve(flags.get("web-root")!) : undefined,
  };
  return {
    options,
    logFile: flags.has("log-file") ? resolve(flags.get("log-file")!) : undefined,
  };
}

function openLog(logFile: string | undefined): (line: string) => void {
  if (logFile === undefined) return () => {};
  let stream: WriteStream | null = null;
  try {
    stream = createWriteStream(logFile, { flags: "a", mode: 0o600 });
    stream.on("error", () => {
      stream = null;
    });
  } catch {
    stream = null;
  }
  return (line: string) => {
    try {
      stream?.write(`${line}\n`);
    } catch {
      // Logging must never take the server down.
    }
  };
}

/** Start the server, wire signal handlers, and return the live handle. */
export async function runServerMain(argv: readonly string[] = process.argv.slice(2)): Promise<DashboardServerHandle> {
  const config = parseServerArgs(argv);
  const log = openLog(config.logFile);
  const handle = await startDashboardServer({ ...config.options, log });
  process.stdout.write(
    `${JSON.stringify({ event: "ready", pid: process.pid, port: handle.port, url: handle.url })}\n`,
  );

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      log(`second ${signal}; forcing exit`);
      process.exit(1);
    }
    shuttingDown = true;
    log(`received ${signal}; closing`);
    void handle.close(signal).then(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", error => {
    log(`uncaught exception: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    void handle.close("uncaughtException").then(() => process.exit(1));
  });
  process.on("unhandledRejection", reason => {
    log(`unhandled rejection: ${String(reason)}`);
  });

  // Idle shutdown (or a fatal server error) resolves `closed`; the process must
  // follow, otherwise the detached server would linger with no listener.
  void handle.closed.then(() => process.exit(0));
  return handle;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runServerMain().catch(error => {
    // A startup failure must leave a trace: the parent spawns with stdio ignored.
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`dashboard server failed: ${detail}\n`);
    const runtimeDirIndex = process.argv.indexOf("--runtime-dir");
    const runtimeDir = runtimeDirIndex >= 0 ? process.argv[runtimeDirIndex + 1] : undefined;
    if (runtimeDir !== undefined) {
      const logFile = join(resolve(runtimeDir), "server.log");
      try {
        createWriteStream(logFile, { flags: "a", mode: 0o600 }).write(`startup failed: ${detail}\n`);
      } catch {
        // Nothing else to do.
      }
    }
    // A duplicate loses the OS singleton on purpose: the parent's ensureDashboard
    // adopts the winner's authenticated health. A distinct exit code lets it tell
    // "someone else won" apart from "this server is broken".
    if (error instanceof SingletonUnavailableError) process.exit(SINGLETON_EXIT_CODE);
    process.exit(1);
  });
}
