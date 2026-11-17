/** Browser-safe policy for forwarding console logs. No Node APIs or environment access. */
import type { WebLogLevel } from "./web-log-levels.ts";

export interface BrowserLogLine {
  level: WebLogLevel;
  message: string;
  stack?: string;
}

export interface BrowserLogEntry extends BrowserLogLine {
  ts: number;
  source: "browser";
}

export const MAX_BROWSER_MESSAGE = 4_000;
export const MAX_BROWSER_STACK = 12_000;
export const MAX_BROWSER_LOG_BATCH = 20;

const BROWSER_LEVELS: Record<string, WebLogLevel> = {
  fatal: "fatal", error: "error", warn: "warn", warning: "warn", info: "info", debug: "debug", trace: "trace",
};

function browserLevel(value: string): WebLogLevel | undefined {
  return Object.hasOwn(BROWSER_LEVELS, value) ? BROWSER_LEVELS[value] : undefined;
}

/** Best-effort redaction for free-form console text, which has no field names. */
export function redactLogText(value: string): string {
  return value
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/\b(password|passwd|secret|token|api[_-]?key)(\s*[:=]\s*)(["']?)([^"'\s,;}]+)\3/gi, "$1$2[REDACTED]")
    .replace(/([?&](?:token|password|secret|api[_-]?key)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/\b(cookie\s*[:=]\s*)[^;\s]+/gi, "$1[REDACTED]");
}

interface ErrorFields {
  name: string;
  message: string;
  stack?: string;
}

function errorFieldsOf(value: unknown): ErrorFields | undefined {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const nested = record.err ?? record.error;
  if (nested !== undefined && nested !== value) {
    const nestedFields = errorFieldsOf(nested);
    if (nestedFields !== undefined) return nestedFields;
  }
  const message = record.msg ?? record.message;
  if (typeof message !== "string") return undefined;
  const name = typeof record.type === "string" ? record.type
    : typeof record.name === "string" ? record.name
      : "Error";
  return { name, message, ...(typeof record.stack === "string" ? { stack: record.stack } : {}) };
}

function textOf(value: unknown): string {
  if (typeof value === "string") return redactLogText(value);
  const fields = errorFieldsOf(value);
  if (fields !== undefined) return redactLogText(`${fields.name}: ${fields.message}`);
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return redactLogText(text);
}

/** Convert a pino browser transmit event into one bounded, structured server log line. */
export function browserLogLine(level: string, messages: readonly unknown[]): BrowserLogLine | undefined {
  const mapped = browserLevel(level);
  if (mapped === undefined) return undefined;
  const parts = messages.map(textOf).filter((part) => part !== "");
  const message = parts.join(" ").slice(0, MAX_BROWSER_MESSAGE);
  if (message === "") return undefined;
  const error = messages.map(errorFieldsOf).find((fields) => fields !== undefined);
  const stack = error?.stack === undefined ? undefined : redactLogText(error.stack).slice(0, MAX_BROWSER_STACK);
  return stack === undefined || stack === "" ? { level: mapped, message } : { level: mapped, message, stack };
}

export function browserLogEntry(level: string, messages: readonly unknown[], ts: number): BrowserLogEntry | undefined {
  const line = browserLogLine(level, messages);
  return line === undefined ? undefined : { ...line, ts, source: "browser" };
}

/** Re-validate untrusted browser payloads before they reach the server logger. */
export function parseBrowserLogEntries(value: unknown): BrowserLogEntry[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_BROWSER_LOG_BATCH) return undefined;

  const parsed: BrowserLogEntry[] = [];
  for (const value of entries) {
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (record.source !== "browser") return undefined;
    if (typeof record.ts !== "number" || !Number.isFinite(record.ts) || record.ts < 0) return undefined;
    if (typeof record.message !== "string" || record.message === "") return undefined;
    if (record.message.length > MAX_BROWSER_MESSAGE) return undefined;
    if (record.stack !== undefined && (typeof record.stack !== "string" || record.stack.length > MAX_BROWSER_STACK)) return undefined;
    const level = browserLevel(String(record.level));
    if (level === undefined) return undefined;
    parsed.push({
      level,
      message: redactLogText(record.message),
      ts: record.ts,
      source: "browser",
      ...(typeof record.stack === "string" ? { stack: redactLogText(record.stack) } : {}),
    });
  }
  return parsed;
}

/** Display an arbitrary rejection reason as an Error without losing its text. */
export function rejectionError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(textOf(reason));
  error.name = "UnhandledRejection";
  return error;
}
