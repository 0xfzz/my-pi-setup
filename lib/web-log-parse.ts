/**
 * Parses pi-web.log into flat records. Pure: text in, records out, no I/O.
 *
 * The file holds two shapes because the default file format changed from
 * newline-delimited JSON to pino-pretty text and old logs are appended to, not
 * rotated. Both land in one `LogRecord` so a reader never has to care which era
 * a line came from. Pretty records span several lines (a header, then indented
 * fields), so the parser groups continuation lines under their header.
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export const LEVEL_RANK: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };

export interface LogErr {
  type?: string;
  message: string;
  code?: string;
  /** Stack lines beginning `at `, in original order. */
  frames: string[];
}

export interface LogRecord {
  ms: number;
  /** Local `YYYY-MM-DD HH:MM:SS.mmm`; sortable as a string. */
  stamp: string;
  level: LogLevel;
  pid: number;
  msg: string;
  /** Flat scalar fields: reqId, sessionId, method, url, statusCode, responseTime, warning, stderr, ... */
  fields: Record<string, string>;
  err?: LogErr;
  /** Original text of the record, kept so a reader can quote it verbatim. */
  lines: string[];
}

const PRETTY_HEADER = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\] ([A-Z]+) \((\d+)\): (.*)$/;
const PRETTY_SCALAR = /^ {4}([A-Za-z_$][\w$]*): (.*)$/;
const NESTED_FIELD = /^\s+"(method|url|statusCode)": (.+?),?\s*$/;
const NESTED_ERR_FIELD = /^\s+"(type|message|code)": (.+?),?\s*$/;
/** V8 `at fn (file:1:2)` frames, and browser `fn@url:1:2` frames from /api/client/log reports. */
const STACK_FRAME = /^\s+(at\s|\S*@\S+:\d+:\d+\s*$)/;
const JSON_LEVELS: Record<number, LogLevel> = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" };
const JSON_NESTED_OBJECTS = new Set(["err", "req", "res"]);
const JSON_ENVELOPE = new Set(["level", "time", "pid", "hostname", "msg"]);

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

export function formatStamp(ms: number): string {
  const d = new Date(ms);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Pretty stamps are written in local time, so they are read back in local time. */
export function stampToMs(stamp: string): number {
  return new Date(stamp.replace(" ", "T")).getTime();
}

export function isLogLevel(value: string): value is LogLevel {
  return Object.hasOwn(LEVEL_RANK, value);
}

function levelFromName(name: string): LogLevel {
  const lower = name.toLowerCase();
  return isLogLevel(lower) ? lower : "info";
}

function unquote(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : String(parsed);
  } catch {
    return value;
  }
}

function scalarFields(lines: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const match = PRETTY_SCALAR.exec(line);
    if (match === null) continue;
    const [, key, value] = match;
    if (value === "{" || value === "[" || value === "") continue;
    fields[key] = unquote(value);
  }
  return fields;
}

function nestedRequestFields(lines: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const match = NESTED_FIELD.exec(line);
    if (match !== null && fields[match[1]] === undefined) fields[match[1]] = unquote(match[2]);
  }
  return fields;
}

function prettyErr(lines: string[]): LogErr | undefined {
  const start = lines.findIndex((line) => /^ {4}err: \{/.test(line));
  if (start === -1) return undefined;
  const fields: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    const match = NESTED_ERR_FIELD.exec(line);
    if (match !== null && fields[match[1]] === undefined) fields[match[1]] = unquote(match[2]);
  }
  return {
    type: fields.type,
    message: fields.message ?? "",
    code: fields.code,
    frames: lines.slice(start + 1).filter((line) => STACK_FRAME.test(line)).map((line) => line.trim()),
  };
}

function prettyRecord(header: RegExpExecArray, continuation: string[]): LogRecord {
  const stamp = header[1];
  return {
    ms: stampToMs(stamp),
    stamp,
    level: levelFromName(header[2]),
    pid: Number(header[3]),
    msg: header[4],
    fields: { ...scalarFields(continuation), ...nestedRequestFields(continuation) },
    err: prettyErr(continuation),
    lines: [header[0], ...continuation],
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function jsonErr(value: unknown): LogErr | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const err = asObject(value);
  const stack = typeof err.stack === "string" ? err.stack : "";
  return {
    type: typeof err.type === "string" ? err.type : undefined,
    message: typeof err.message === "string" ? err.message : "",
    code: typeof err.code === "string" ? err.code : undefined,
    frames: stack.split("\n").filter((line) => STACK_FRAME.test(line)).map((line) => line.trim()),
  };
}

function jsonFields(obj: Record<string, unknown>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (JSON_ENVELOPE.has(key) || JSON_NESTED_OBJECTS.has(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") fields[key] = String(value);
  }
  const req = asObject(obj.req);
  if (typeof req.method === "string") fields.method = req.method;
  if (typeof req.url === "string") fields.url = req.url;
  const res = asObject(obj.res);
  if (typeof res.statusCode === "number") fields.statusCode = String(res.statusCode);
  return fields;
}

function jsonRecord(line: string): LogRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const obj = asObject(parsed);
  if (typeof obj.time !== "number" || typeof obj.msg !== "string") return undefined;
  return {
    ms: obj.time,
    stamp: formatStamp(obj.time),
    level: typeof obj.level === "number" ? (JSON_LEVELS[obj.level] ?? "info") : levelFromName(String(obj.level)),
    pid: typeof obj.pid === "number" ? obj.pid : 0,
    msg: obj.msg,
    fields: jsonFields(obj),
    err: jsonErr(obj.err),
    lines: [line],
  };
}

function unparsedRecord(line: string, previous: LogRecord | undefined): LogRecord {
  return {
    ms: previous?.ms ?? 0,
    stamp: previous?.stamp ?? "",
    level: "warn",
    pid: previous?.pid ?? 0,
    msg: `unparsed log line: ${line.trim().slice(0, 200)}`,
    fields: {},
    lines: [line],
  };
}

/** Yields one record per log entry, in file order. Blank lines are skipped. */
export function* parseLogLines(lines: Iterable<string>): Generator<LogRecord> {
  let header: RegExpExecArray | undefined;
  let continuation: string[] = [];
  let previous: LogRecord | undefined;
  const closeOpen = function* (): Generator<LogRecord> {
    if (header === undefined) return;
    previous = prettyRecord(header, continuation);
    header = undefined;
    continuation = [];
    yield previous;
  };
  for (const line of lines) {
    if (line.trim() === "") continue;
    const next = PRETTY_HEADER.exec(line);
    if (next !== null) {
      yield* closeOpen();
      header = next;
    } else if (header !== undefined && /^\s/.test(line)) {
      continuation.push(line);
    } else {
      yield* closeOpen();
      previous = jsonRecord(line) ?? unparsedRecord(line, previous);
      yield previous;
    }
  }
  yield* closeOpen();
}
