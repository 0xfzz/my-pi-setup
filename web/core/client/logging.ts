// Browser diagnostics use Pino's browser build. Warnings and errors are still
// printed in devtools, then forwarded in bounded batches to the server's
// structured logger. The fetch reference is captured before auth wraps it so a
// failed log POST can never recurse through the auth/retry path.
import pino from "pino/browser.js";
import type { LogEvent, Logger } from "pino";
import { browserLogEntry, MAX_BROWSER_LOG_BATCH, rejectionError, type BrowserLogEntry } from "../shared/web-log-browser.ts";

const LOG_ENDPOINT = "/api/client/log";
const FLUSH_MS = 250;

export interface BrowserLogSenderOptions {
  fetch?: typeof fetch;
  endpoint?: string;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface BrowserLogSender {
  send(event: LogEvent): void;
  flush(): Promise<void>;
}

/** Batch browser logs so a warning storm cannot create one request per line. */
export function createBrowserLogSender(options: BrowserLogSenderOptions = {}): BrowserLogSender {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const endpoint = options.endpoint ?? LOG_ENDPOINT;
  const schedule = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let queue: BrowserLogEntry[] = [];
  let timer: unknown;
  let pending: Promise<void> = Promise.resolve();

  const flush = async (): Promise<void> => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    if (queue.length === 0) return;
    const entries = queue;
    queue = [];
    pending = pending.then(async () => {
      try {
        await fetcher(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ entries }),
          credentials: "same-origin",
          keepalive: true,
        });
      } catch {
        // Logging transport failures must never create another log line.
      }
    });
    return pending;
  };

  return {
    send(event) {
      const entry = browserLogEntry(event.level.label, event.messages, event.ts);
      if (entry === undefined) return;
      queue.push(entry);
      if (queue.length >= MAX_BROWSER_LOG_BATCH) {
        void flush();
      } else if (timer === undefined) {
        timer = schedule(() => { void flush(); }, FLUSH_MS);
      }
    },
    flush,
  };
}

export interface BrowserLoggingOptions extends BrowserLogSenderOptions {
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
  console?: Pick<Console, "warn" | "error">;
}

export interface BrowserLogging {
  readonly logger: Logger;
  flush(): Promise<void>;
  stop(): void;
}

let installedLogger: Logger | undefined;

/** Report a handled failure through the same structured stream as uncaught errors. */
export function reportClientError(context: string, error: unknown, fields: Record<string, unknown> = {}): void {
  const err = error instanceof Error ? error : new Error(String(error));
  if (installedLogger !== undefined) installedLogger.error({ err, ...fields }, context);
  else console.error(`[pi-web] ${context}`, err, fields);
}

/** A non-fatal failure: still forwarded, but not presented as a crash. */
export function reportClientWarning(context: string, error: unknown, fields: Record<string, unknown> = {}): void {
  const err = error instanceof Error ? error : new Error(String(error));
  if (installedLogger !== undefined) installedLogger.warn({ err, ...fields }, context);
  else console.warn(`[pi-web] ${context}`, err, fields);
}

/** Install browser log forwarding before the auth wrapper replaces `fetch`. */
export function installBrowserLogging(options: BrowserLoggingOptions = {}): BrowserLogging {
  const target = options.target ?? window;
  const consoleMethods = options.console ?? console;
  const sender = createBrowserLogSender(options);
  const logger = pino({
    level: "debug",
    browser: {
      // Keep Error instances in transmit events so their stacks reach the file.
      serialize: false,
      transmit: { level: "warn", send: (_level, event) => sender.send(event) },
    },
  });
  installedLogger = logger;

  consoleMethods.warn = (...args: unknown[]) => { Reflect.apply(logger.warn, logger, args); };
  consoleMethods.error = (...args: unknown[]) => { Reflect.apply(logger.error, logger, args); };

  const onError = (event: ErrorEvent): void => {
    const error = event.error instanceof Error ? event.error : new Error(event.message);
    logger.fatal({ err: error, filename: event.filename, lineno: event.lineno, colno: event.colno }, "browser uncaught error");
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    logger.error({ err: rejectionError(event.reason) }, "browser unhandled rejection");
  };
  const onHide = (): void => { void sender.flush(); };

  target.addEventListener("error", onError as EventListener);
  target.addEventListener("unhandledrejection", onRejection as EventListener);
  target.addEventListener("pagehide", onHide as EventListener);

  return {
    logger,
    flush: sender.flush,
    stop() {
      target.removeEventListener("error", onError as EventListener);
      target.removeEventListener("unhandledrejection", onRejection as EventListener);
      target.removeEventListener("pagehide", onHide as EventListener);
      if (installedLogger === logger) installedLogger = undefined;
      void sender.flush();
    },
  };
}
