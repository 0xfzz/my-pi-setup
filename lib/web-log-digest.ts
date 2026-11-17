/**
 * Reduces a stream of pi-web log records to a small, root-cause-oriented digest.
 *
 * A busy server log is ~99% `incoming request` / `request completed` pairs. Those
 * are folded into per-route counters; every other record is deduplicated by its
 * message and error text, so a crash loop that logs the same failure 500 times
 * costs one entry with a count instead of 500.
 */
import { LEVEL_RANK, type LogLevel, type LogRecord } from "./web-log-parse.ts";

export interface DigestOptions {
  /** Requests slower than this (ms) are reported, except streaming routes. */
  slowMs: number;
  /** Only records at or above this level become problem entries. */
  minProblemLevel: LogLevel;
}

export interface ProblemGroup {
  level: LogLevel;
  msg: string;
  /** Normalised error text that distinguishes errors sharing a message; empty for records without an error. */
  signature: string;
  count: number;
  firstStamp: string;
  lastStamp: string;
  firstMs: number;
  pids: number[];
  /** Distinct detail texts (warning/stderr/reason/error message) with their counts. */
  details: Map<string, number>;
  sample: LogRecord;
  /** `METHOD route` of the request that was being served when the sample was logged. */
  sampleRoute?: string;
  sessionIds: string[];
}

export interface RouteIssue {
  key: string;
  status: number;
  route: string;
  count: number;
  firstStamp: string;
  lastStamp: string;
  maxMs: number;
}

export interface ProcessSummary {
  pid: number;
  firstStamp: string;
  lastStamp: string;
  firstMs: number;
  lastMs: number;
  records: number;
  requests: number;
  problems: number;
}

export interface LifecycleEvent {
  stamp: string;
  pid: number;
  text: string;
}

export interface LogDigest {
  firstStamp: string;
  lastStamp: string;
  records: number;
  requests: number;
  levels: Partial<Record<LogLevel, number>>;
  processes: ProcessSummary[];
  lifecycle: LifecycleEvent[];
  problems: ProblemGroup[];
  failedRoutes: RouteIssue[];
  slowRoutes: RouteIssue[];
}

export const DEFAULT_DIGEST_OPTIONS: DigestOptions = { slowMs: 2000, minProblemLevel: "warn" };

/** Long-lived SSE streams stay open for minutes by design; their duration is not latency. */
const STREAMING_ROUTE = /^GET .*\/(attach|events)$/;
const LIFECYCLE_MESSAGE = /listening|stopped|safe mode|shutting down|restart/i;
const DETAIL_FIELDS = ["warning", "stderr", "reason", "origin"] as const;
const ID_SEGMENT = /^([0-9a-f-]{12,}|\d+)$/i;
const MAX_DETAIL_LENGTH = 240;
const MAX_LIFECYCLE_EVENTS = 40;

export function normalizeRoute(url: string): string {
  const path = url.split("?")[0];
  return path
    .split("/")
    .map((segment) => (ID_SEGMENT.test(segment) ? ":id" : segment))
    .join("/");
}

function normalizeSignature(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f-]{4,}/gi, "#")
    .replace(/\b[0-9a-f]{12,}\b/gi, "#")
    .replace(/\b\d{2,}\b/g, "#")
    .slice(0, MAX_DETAIL_LENGTH);
}

function detailOf(record: LogRecord): string {
  if (record.err !== undefined && record.err.message !== "") return record.err.message;
  for (const field of DETAIL_FIELDS) {
    const value = record.fields[field];
    if (value !== undefined) return value;
  }
  return "";
}

function pushUnique<T>(list: T[], value: T): void {
  if (!list.includes(value)) list.push(value);
}

interface DigestState {
  options: DigestOptions;
  records: number;
  requests: number;
  firstStamp: string;
  lastStamp: string;
  levels: Partial<Record<LogLevel, number>>;
  processes: Map<number, ProcessSummary>;
  lifecycle: LifecycleEvent[];
  problems: Map<string, ProblemGroup>;
  failed: Map<string, RouteIssue>;
  slow: Map<string, RouteIssue>;
  /** `pid:reqId` -> `METHOD route`; request ids restart from req-1 in every process. */
  routeByRequest: Map<string, string>;
}

function newState(options: DigestOptions): DigestState {
  return {
    options,
    records: 0,
    requests: 0,
    firstStamp: "",
    lastStamp: "",
    levels: {},
    processes: new Map(),
    lifecycle: [],
    problems: new Map(),
    failed: new Map(),
    slow: new Map(),
    routeByRequest: new Map(),
  };
}

function requestKey(record: LogRecord): string {
  return `${record.pid}:${record.fields.reqId ?? ""}`;
}

function touchProcess(state: DigestState, record: LogRecord): ProcessSummary {
  const known = state.processes.get(record.pid);
  const process = known ?? {
    pid: record.pid,
    firstStamp: record.stamp,
    lastStamp: record.stamp,
    firstMs: record.ms,
    lastMs: record.ms,
    records: 0,
    requests: 0,
    problems: 0,
  };
  process.records += 1;
  process.lastStamp = record.stamp;
  process.lastMs = record.ms;
  state.processes.set(record.pid, process);
  return process;
}

function recordRouteIssue(into: Map<string, RouteIssue>, status: number, route: string, record: LogRecord): void {
  const key = `${status} ${route}`;
  const ms = Number(record.fields.responseTime) || 0;
  const existing = into.get(key);
  if (existing === undefined) {
    into.set(key, { key, status, route, count: 1, firstStamp: record.stamp, lastStamp: record.stamp, maxMs: ms });
    return;
  }
  existing.count += 1;
  existing.lastStamp = record.stamp;
  existing.maxMs = Math.max(existing.maxMs, ms);
}

function absorbRequest(state: DigestState, record: LogRecord, process: ProcessSummary): void {
  if (record.msg === "incoming request") {
    state.requests += 1;
    process.requests += 1;
    const route = `${record.fields.method ?? "?"} ${normalizeRoute(record.fields.url ?? "")}`;
    state.routeByRequest.set(requestKey(record), route);
    return;
  }
  const route = state.routeByRequest.get(requestKey(record)) ?? "? (request began before this window)";
  state.routeByRequest.delete(requestKey(record));
  const status = Number(record.fields.statusCode);
  if (status >= 400) recordRouteIssue(state.failed, status, route, record);
  const isSlow = Number(record.fields.responseTime) >= state.options.slowMs && !STREAMING_ROUTE.test(route);
  if (isSlow) recordRouteIssue(state.slow, status, route, record);
}

function absorbLifecycle(state: DigestState, record: LogRecord): void {
  if (!LIFECYCLE_MESSAGE.test(record.msg)) return;
  const detail = detailOf(record);
  state.lifecycle.push({ stamp: record.stamp, pid: record.pid, text: detail === "" ? record.msg : `${record.msg} (${detail})` });
  if (state.lifecycle.length > MAX_LIFECYCLE_EVENTS) state.lifecycle.shift();
}

function absorbProblem(state: DigestState, record: LogRecord, process: ProcessSummary): void {
  const detail = detailOf(record);
  // Only a real error splits a group. Free-text details (a warning naming a
  // different plugin each time) are variants of one problem, not new problems.
  const signature = normalizeSignature(record.err?.message ?? "");
  const key = `${record.level}|${record.msg}|${signature}`;
  const route = state.routeByRequest.get(requestKey(record));
  const sessionId = record.fields.sessionId;
  process.problems += 1;
  const existing = state.problems.get(key);
  if (existing === undefined) {
    state.problems.set(key, {
      level: record.level,
      msg: record.msg,
      signature,
      count: 1,
      firstStamp: record.stamp,
      lastStamp: record.stamp,
      firstMs: record.ms,
      pids: [record.pid],
      details: new Map(detail === "" ? [] : [[detail.slice(0, MAX_DETAIL_LENGTH), 1]]),
      sample: record,
      sampleRoute: route,
      sessionIds: sessionId === undefined ? [] : [sessionId],
    });
    return;
  }
  existing.count += 1;
  existing.lastStamp = record.stamp;
  pushUnique(existing.pids, record.pid);
  if (sessionId !== undefined) pushUnique(existing.sessionIds, sessionId);
  const shown = detail.slice(0, MAX_DETAIL_LENGTH);
  if (detail !== "") existing.details.set(shown, (existing.details.get(shown) ?? 0) + 1);
}

function absorb(state: DigestState, record: LogRecord): void {
  state.records += 1;
  if (state.firstStamp === "") state.firstStamp = record.stamp;
  state.lastStamp = record.stamp;
  state.levels[record.level] = (state.levels[record.level] ?? 0) + 1;
  const process = touchProcess(state, record);
  if (record.msg === "incoming request" || record.msg === "request completed") {
    absorbRequest(state, record, process);
    return;
  }
  absorbLifecycle(state, record);
  if (LEVEL_RANK[record.level] >= LEVEL_RANK[state.options.minProblemLevel]) absorbProblem(state, record, process);
}

function bySeverityThenTime(a: ProblemGroup, b: ProblemGroup): number {
  return LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.firstMs - b.firstMs;
}

function byStatusThenCount(a: RouteIssue, b: RouteIssue): number {
  const aServerError = a.status >= 500 ? 1 : 0;
  const bServerError = b.status >= 500 ? 1 : 0;
  return bServerError - aServerError || b.count - a.count;
}

export function buildDigest(records: Iterable<LogRecord>, options: DigestOptions = DEFAULT_DIGEST_OPTIONS): LogDigest {
  const state = newState(options);
  for (const record of records) absorb(state, record);
  return {
    firstStamp: state.firstStamp,
    lastStamp: state.lastStamp,
    records: state.records,
    requests: state.requests,
    levels: state.levels,
    processes: [...state.processes.values()].sort((a, b) => a.firstMs - b.firstMs),
    lifecycle: state.lifecycle,
    problems: [...state.problems.values()].sort(bySeverityThenTime),
    failedRoutes: [...state.failed.values()].sort(byStatusThenCount),
    slowRoutes: [...state.slow.values()].sort((a, b) => b.maxMs - a.maxMs),
  };
}
