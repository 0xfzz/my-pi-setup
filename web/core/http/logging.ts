// pi-web's structured logger: JSON lines on disk, a human-readable stream in
// the terminal. Pino is already Fastify's native logger, so request ids,
// request errors and process-level diagnostics share one format and one file.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import pino, { type DestinationStream, type Logger, type StreamEntry } from "pino";
import pretty from "pino-pretty";
import { isWebLogFileDisabled, shouldPrettyLog, webLogFileFormat, webLogFilePath } from "../../../lib/web-logging.ts";
import { parseWebLogLevel, type WebLogLevel } from "../shared/web-log-levels.ts";
import { rejectionError } from "../shared/web-log-browser.ts";
import { WEB_LOG_REDACT_PATHS } from "./log-redaction.ts";
import { requestLogFields } from "./observability.ts";

export interface WebLoggerBundle {
  readonly logger: Logger;
  readonly stream: DestinationStream;
  readonly level: WebLogLevel;
  readonly file?: string;
  readonly fileFormat?: "pretty" | "json";
  flush(): void;
}

export interface CreateWebLoggerOptions {
  env?: NodeJS.ProcessEnv;
  stderr?: NodeJS.WritableStream;
  isTTY?: boolean;
}

let activeLogger: Logger | undefined;

/** The process-wide logger, for modules wired before the composition root runs. */
export function getWebLogger(): Logger {
  activeLogger ??= createWebLogger().logger;
  return activeLogger;
}

/** The active logger without creating one, for boot code that can queue warnings. */
export function tryGetWebLogger(): Logger | undefined {
  return activeLogger;
}

export function setWebLogger(logger: Logger): void {
  activeLogger = logger;
}

/** Build the one logger used by startup, Fastify, browser log forwarding and crash handlers. */
export function createWebLogger(options: CreateWebLoggerOptions = {}): WebLoggerBundle {
  const env = options.env ?? process.env;
  const level = parseWebLogLevel(env.PI_WEB_LOG_LEVEL);
  const stderr = options.stderr ?? process.stderr;
  const isTTY = options.isTTY ?? Boolean((stderr as NodeJS.WriteStream).isTTY);
  const streams: StreamEntry<WebLogLevel>[] = [
    {
      level,
      stream: pretty({
        colorize: shouldPrettyLog(isTTY, env.PI_WEB_LOG_PRETTY),
        destination: stderr,
        ignore: "pid,hostname",
        translateTime: "SYS:HH:MM:ss.l",
      }),
    },
  ];
  const agentDir = env.PI_CODING_AGENT_DIR ?? joinAgentHome();
  const file = logFileFor(env, agentDir);
  const fileFormat = webLogFileFormat(env.PI_WEB_LOG_FILE_FORMAT);
  const fileStream = file === undefined ? undefined : openLogFile(file, fileFormat);
  if (fileStream !== undefined) streams.push({ level, stream: fileStream.stream });

  const stream = pino.multistream(streams);
  const flush = (): void => {
    stream.flushSync();
    fileStream?.flush();
  };
  const logger = pino({
    level,
    redact: { paths: WEB_LOG_REDACT_PATHS, censor: "[REDACTED]" },
    serializers: { err: pino.stdSerializers.err, req: requestLogFields },
  }, stream);

  return { logger, stream, level, flush, ...(fileStream !== undefined ? { file, fileFormat } : {}) };
}

function joinAgentHome(): string {
  return join(homedir(), ".pi", "agent");
}

function logFileFor(env: NodeJS.ProcessEnv, agentDir: string): string | undefined {
  const override = env.PI_WEB_LOG_FILE;
  if (isWebLogFileDisabled(override)) return undefined;
  if (override === undefined && env.NODE_TEST_CONTEXT !== undefined) return undefined;
  return webLogFilePath(agentDir, override);
}

interface OpenLogFile {
  readonly stream: DestinationStream;
  flush(): void;
}

function openLogFile(file: string, format: "pretty" | "json"): OpenLogFile | undefined {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const destination = pino.destination({ dest: file, append: true, mkdir: true, sync: true });
    if (format === "json") return { stream: destination, flush: () => destination.flushSync() };
    const stream = pretty({ colorize: false, destination, sync: true, translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l" });
    return { stream, flush: () => destination.flushSync() };
  } catch {
    return undefined;
  }
}

/** Bounded process target so tests can assert crash logs without killing the runner. */
export interface CrashProcess {
  on(event: "uncaughtException", listener: (error: Error, origin: string) => void): unknown;
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  on(event: "warning", listener: (warning: Error) => void): unknown;
  exit(code?: number): never;
}

export function installCrashLogging(logger: Pick<Logger, "fatal" | "warn">, target: CrashProcess = process): void {
  target.on("uncaughtException", (error, origin) => {
    logger.fatal({ err: error, origin }, "uncaught exception");
    target.exit(1);
  });
  target.on("unhandledRejection", (reason) => {
    logger.fatal({ err: rejectionError(reason), origin: "unhandledRejection" }, "unhandled rejection");
    target.exit(1);
  });
  target.on("warning", (warning) => {
    logger.warn({ err: warning, origin: "warning" }, "node warning");
  });
}
