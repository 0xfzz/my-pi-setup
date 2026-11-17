/**
 * Command-line parsing and record selection for the web-log reader. Pure: the
 * caller supplies argv and the newest record's time, so tests need no file or clock.
 */
import { isLogLevel, LEVEL_RANK, type LogLevel, type LogRecord, stampToMs } from "./web-log-parse.ts";

export interface CliArgs {
  file?: string;
  since?: string;
  until?: string;
  around?: string;
  window: string;
  pid?: number;
  minLevel?: LogLevel;
  slowMs?: number;
  frames?: number;
  reqId?: string;
  grep?: string;
  limit: number;
  list: boolean;
  requests: boolean;
  help: boolean;
}

export type ArgsResult = { ok: true; args: CliArgs } | { ok: false; error: string };

export interface LogQuery {
  sinceMs?: number;
  untilMs?: number;
  pid?: number;
  minLevel?: LogLevel;
  reqId?: string;
  grep?: RegExp;
  limit: number;
  /** List matching records instead of printing the digest. */
  list: boolean;
  /** Include per-request records, which list mode hides as noise. */
  includeRequests: boolean;
}

export type QueryResult = { ok: true; query: LogQuery } | { ok: false; error: string };

export const DEFAULT_LIST_LIMIT = 25;
const DEFAULT_AROUND_WINDOW = "60s";
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const RELATIVE = /^(\d+)\s*([smhd])$/;
const CLOCK = /^(\d{1,2}):(\d\d)(?::(\d\d))?$/;
const FULL = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d(?::\d\d(?:\.\d+)?)?)$/;
const REQUEST_MESSAGES = new Set(["incoming request", "request completed"]);

export const USAGE = `Usage: node scripts/web-log-digest.mjs [options]

Digest (default): problems grouped by cause, failed/slow routes, process timeline.
  --since SPEC      only records after SPEC: 30m | 2h | 1d (relative to the NEWEST record) | 20:15 | "2026-11-17 20:15"
  --until SPEC      only records before SPEC (clock or full time)
  --pid N           only one server process
  --min-level L     problem threshold: trace|debug|info|warn|error|fatal (default warn)
  --slow-ms N       slow-request threshold in ms (default 2000)
  --frames N        stack frames per problem (default 4)

List records (any of these switches to list mode; request noise is hidden):
  --around SPEC     records within --window of SPEC (default window 60s)
  --window DUR      e.g. 30s, 5m
  --req ID          every record of one request, including its request/response pair
  --grep REGEX      records whose text matches (case-insensitive)
  --list            list records matching the other filters
  --requests        keep request records in the list
  --limit N         max records listed (default ${DEFAULT_LIST_LIMIT})

  --file PATH       log file (default: $PI_WEB_LOG_FILE, else $PI_CODING_AGENT_DIR/logs/pi-web.log, else ~/.pi/agent/logs/pi-web.log)`;

const TEXT_FLAGS = {
  "--file": "file",
  "--since": "since",
  "--until": "until",
  "--around": "around",
  "--window": "window",
  "--req": "reqId",
  "--grep": "grep",
} as const;
const NUMBER_FLAGS = { "--pid": "pid", "--slow-ms": "slowMs", "--frames": "frames", "--limit": "limit" } as const;
const BOOLEAN_FLAGS = { "--list": "list", "--requests": "requests", "--help": "help" } as const;

function emptyArgs(): CliArgs {
  return { window: DEFAULT_AROUND_WINDOW, limit: DEFAULT_LIST_LIMIT, list: false, requests: false, help: false };
}

function isFlagIn<T extends object>(table: T, flag: string): flag is Extract<keyof T, string> {
  return Object.hasOwn(table, flag);
}

/** Returns an error message, or undefined once the flag is applied. */
function applyValue(args: CliArgs, flag: string, value: string): string | undefined {
  if (isFlagIn(TEXT_FLAGS, flag)) {
    args[TEXT_FLAGS[flag]] = value;
    return undefined;
  }
  if (isFlagIn(NUMBER_FLAGS, flag)) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) return `${flag} needs a non-negative integer, got "${value}"`;
    args[NUMBER_FLAGS[flag]] = n;
    return undefined;
  }
  if (!isLogLevel(value)) return `--min-level must be one of ${Object.keys(LEVEL_RANK).join("|")}, got "${value}"`;
  args.minLevel = value;
  return undefined;
}

export function parseCliArgs(argv: string[]): ArgsResult {
  const args = emptyArgs();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (isFlagIn(BOOLEAN_FLAGS, flag)) {
      args[BOOLEAN_FLAGS[flag]] = true;
      continue;
    }
    if (!isFlagIn(TEXT_FLAGS, flag) && !isFlagIn(NUMBER_FLAGS, flag) && flag !== "--min-level") return { ok: false, error: `unknown option "${flag}"` };
    const value = argv[++i];
    if (value === undefined) return { ok: false, error: `${flag} needs a value` };
    const error = applyValue(args, flag, value);
    if (error !== undefined) return { ok: false, error };
  }
  return { ok: true, args };
}

/** Whether a time spec depends on the log's newest record rather than being absolute. */
function isAnchored(spec: string | undefined): boolean {
  return spec !== undefined && (RELATIVE.test(spec) || CLOCK.test(spec));
}

export function needsAnchor(args: CliArgs): boolean {
  return [args.since, args.until, args.around].some(isAnchored);
}

export function resolveTimeSpec(spec: string, anchorMs: number): number | undefined {
  const text = spec.trim();
  const relative = RELATIVE.exec(text);
  if (relative !== null) return anchorMs - Number(relative[1]) * UNIT_MS[relative[2]];
  const clock = CLOCK.exec(text);
  if (clock !== null) {
    const day = new Date(anchorMs);
    day.setHours(Number(clock[1]), Number(clock[2]), Number(clock[3] ?? 0), 0);
    return day.getTime();
  }
  const full = FULL.exec(text);
  if (full === null) return undefined;
  const ms = stampToMs(`${full[1]} ${full[2]}`);
  return Number.isNaN(ms) ? undefined : ms;
}

export function parseDuration(spec: string): number | undefined {
  const match = RELATIVE.exec(spec.trim());
  return match === null ? undefined : Number(match[1]) * UNIT_MS[match[2]];
}

type Resolved<T> = { ok: true; value: T | undefined } | { ok: false; error: string };

function resolveBound(label: string, spec: string | undefined, anchorMs: number): Resolved<number> {
  if (spec === undefined) return { ok: true, value: undefined };
  const ms = resolveTimeSpec(spec, anchorMs);
  if (ms === undefined) return { ok: false, error: `${label} "${spec}" is not a time; use 30m, 20:15 or "2026-11-17 20:15"` };
  return { ok: true, value: ms };
}

function compileGrep(pattern: string | undefined): Resolved<RegExp> {
  if (pattern === undefined) return { ok: true, value: undefined };
  try {
    return { ok: true, value: new RegExp(pattern, "i") };
  } catch {
    return { ok: false, error: `--grep "${pattern}" is not a valid regular expression` };
  }
}

interface Bounds {
  sinceMs?: number;
  untilMs?: number;
}

function aroundBounds(args: CliArgs, anchorMs: number): Resolved<Bounds> {
  if (args.around === undefined) return { ok: true, value: undefined };
  const center = resolveTimeSpec(args.around, anchorMs);
  const half = parseDuration(args.window);
  if (center === undefined) return { ok: false, error: `--around "${args.around}" is not a time` };
  if (half === undefined) return { ok: false, error: `--window "${args.window}" is not a duration like 30s or 5m` };
  return { ok: true, value: { sinceMs: center - half, untilMs: center + half } };
}

export function buildQuery(args: CliArgs, anchorMs: number): QueryResult {
  const since = resolveBound("--since", args.since, anchorMs);
  const until = resolveBound("--until", args.until, anchorMs);
  const grep = compileGrep(args.grep);
  const around = aroundBounds(args, anchorMs);
  if (!since.ok) return since;
  if (!until.ok) return until;
  if (!grep.ok) return grep;
  if (!around.ok) return around;
  return {
    ok: true,
    query: {
      sinceMs: around.value?.sinceMs ?? since.value,
      untilMs: around.value?.untilMs ?? until.value,
      pid: args.pid,
      minLevel: args.minLevel,
      reqId: args.reqId,
      grep: grep.value,
      limit: args.limit,
      list: args.list || args.reqId !== undefined || args.grep !== undefined || args.around !== undefined,
      includeRequests: args.requests || args.reqId !== undefined,
    },
  };
}

export function inWindow(record: LogRecord, query: LogQuery): boolean {
  if (query.sinceMs !== undefined && record.ms < query.sinceMs) return false;
  if (query.untilMs !== undefined && record.ms > query.untilMs) return false;
  return query.pid === undefined || record.pid === query.pid;
}

/** Whether a record belongs in list mode output. */
export function matchesList(record: LogRecord, query: LogQuery): boolean {
  if (!inWindow(record, query)) return false;
  if (!query.includeRequests && REQUEST_MESSAGES.has(record.msg)) return false;
  if (query.reqId !== undefined && record.fields.reqId !== query.reqId) return false;
  if (query.minLevel !== undefined && LEVEL_RANK[record.level] < LEVEL_RANK[query.minLevel]) return false;
  return query.grep === undefined || query.grep.test(record.lines.join("\n"));
}

export interface Selection {
  shown: LogRecord[];
  /** Matching records, including the ones past the limit. */
  total: number;
}

export function selectRecords(records: Iterable<LogRecord>, query: LogQuery): Selection {
  const shown: LogRecord[] = [];
  let total = 0;
  for (const record of records) {
    if (!matchesList(record, query)) continue;
    total += 1;
    if (shown.length < query.limit) shown.push(record);
  }
  return { shown, total };
}
