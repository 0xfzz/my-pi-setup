/**
 * Renders a `LogDigest` as terse text for an agent to read. Every section has a
 * hard cap and says how many entries it left out, so output size is bounded no
 * matter how large or noisy the log is.
 */
import type { LogDigest, LifecycleEvent, ProblemGroup, ProcessSummary, RouteIssue } from "./web-log-digest.ts";
import type { LogRecord } from "./web-log-parse.ts";
import type { LogQuery, Selection } from "./web-log-query.ts";

export interface RenderOptions {
  /** Stack frames shown per problem. */
  frames: number;
  maxProblems: number;
  maxRoutes: number;
  maxProcesses: number;
  maxLifecycle: number;
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = { frames: 4, maxProblems: 12, maxRoutes: 10, maxProcesses: 6, maxLifecycle: 12 };

const MAX_DETAILS_SHOWN = 3;
const MAX_LINE_LENGTH = 220;
const DAY_LENGTH = 10;
const CLOCK_START = 11;
const SECOND_END = 19;
const NOISE_FRAME = /node:|node_modules/;

const clip = (text: string, max = MAX_LINE_LENGTH): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Clock time when the stamp is on the digest's first day, full date otherwise. */
function shortStamp(stamp: string, day: string): string {
  return stamp.startsWith(day) ? stamp.slice(CLOCK_START, SECOND_END) : stamp.slice(0, SECOND_END);
}

function span(first: string, last: string, day: string): string {
  const a = shortStamp(first, day);
  const b = shortStamp(last, day);
  return a === b ? a : `${a}→${b}`;
}

/** Application frames first; Node internals only when nothing else is left. */
export function pickFrames(frames: string[], limit: number): string[] {
  const own = frames.filter((frame) => !NOISE_FRAME.test(frame));
  return (own.length > 0 ? own : frames).slice(0, limit).map((frame) => frame.replace("file://", ""));
}

/** The error text, unless it only repeats the headline (browser reports log the same string twice). */
function errLine(record: LogRecord): string | undefined {
  const err = record.err;
  if (err === undefined || err.message === record.msg) return undefined;
  const label = err.type === undefined ? "" : `${err.type}: `;
  const code = err.code === undefined ? "" : ` [${err.code}]`;
  return `${label}${err.message}${code}`;
}

function problemLines(group: ProblemGroup, index: number, day: string, frames: number): string[] {
  const times = group.count > 1 ? ` ×${group.count} ${span(group.firstStamp, group.lastStamp, day)}` : ` ${shortStamp(group.firstStamp, day)}`;
  const pids = group.pids.length > 1 ? ` pids ${group.pids.join(",")}` : ` pid ${group.pids[0]}`;
  const lines = [`#${index + 1} ${group.level.toUpperCase()}${times}${pids} — ${group.msg}`];
  const err = errLine(group.sample);
  if (err !== undefined) lines.push(`   ${clip(err)}`);
  for (const frame of pickFrames(group.sample.err?.frames ?? [], frames)) lines.push(`     ${clip(frame)}`);
  const details = [...group.details.entries()].sort((a, b) => b[1] - a[1]);
  if (group.sample.err === undefined) {
    for (const [text, n] of details.slice(0, MAX_DETAILS_SHOWN)) lines.push(`   ${n > 1 ? `×${n} ` : ""}${clip(text)}`);
    if (details.length > MAX_DETAILS_SHOWN) lines.push(`   (+${details.length - MAX_DETAILS_SHOWN} more distinct variants)`);
  }
  const context = [group.sampleRoute === undefined ? "" : `during ${group.sampleRoute}`, ...group.sessionIds.slice(0, 2).map((id) => `session ${id}`)];
  const shown = context.filter((part) => part !== "");
  if (shown.length > 0) lines.push(`   ctx: ${shown.join(" · ")}`);
  return lines;
}

function processLine(process: ProcessSummary, day: string): string {
  const flag = process.problems > 0 ? `  problems=${process.problems}` : "";
  return ` ${String(process.pid).padEnd(7)} ${span(process.firstStamp, process.lastStamp, day)}  records=${process.records} requests=${process.requests}${flag}`;
}

function routeLine(issue: RouteIssue, day: string): string {
  const slow = issue.maxMs >= 1000 ? `  max=${Math.round(issue.maxMs)}ms` : "";
  return ` ${issue.status} ×${issue.count} ${issue.route}  ${span(issue.firstStamp, issue.lastStamp, day)}${slow}`;
}

function lifecycleLine(event: LifecycleEvent, day: string): string {
  return ` ${shortStamp(event.stamp, day)} pid ${event.pid} ${clip(event.text)}`;
}

function section<T>(title: string, items: T[], limit: number, render: (item: T) => string): string[] {
  if (items.length === 0) return [];
  const shown = items.slice(0, limit).map(render);
  const hidden = items.length - limit;
  return ["", title, ...shown, ...(hidden > 0 ? [` (+${hidden} more)`] : [])];
}

function lifecycleTitle(digest: LogDigest, options: RenderOptions): string {
  const shown = Math.min(digest.lifecycle.length, options.maxLifecycle);
  return `LIFECYCLE (latest ${shown} of ${digest.lifecycle.length})`;
}

function headerLines(digest: LogDigest): string[] {
  const levels = Object.entries(digest.levels).map(([level, n]) => `${level}=${n}`).join(" ");
  return [
    `pi-web.log ${digest.firstStamp.slice(0, SECOND_END)} → ${digest.lastStamp.slice(0, SECOND_END)}`,
    `${digest.records} records, ${digest.requests} requests | ${levels}`,
  ];
}

function problemSection(digest: LogDigest, options: RenderOptions, day: string): string[] {
  if (digest.problems.length === 0) return ["", "PROBLEMS: none at or above the problem level"];
  const shown = digest.problems.slice(0, options.maxProblems);
  const body = shown.flatMap((group, index) => problemLines(group, index, day, options.frames));
  const hidden = digest.problems.length - shown.length;
  const title = `PROBLEMS (${plural(digest.problems.length, "group")}, most severe first, then earliest)`;
  return ["", title, ...body, ...(hidden > 0 ? [` (+${hidden} more groups; narrow with --since/--pid or raise --min-level)`] : [])];
}

export function renderDigest(digest: LogDigest, options: RenderOptions = DEFAULT_RENDER_OPTIONS): string {
  if (digest.records === 0) return "No log records matched the filters.";
  const day = digest.firstStamp.slice(0, DAY_LENGTH);
  const latestFirst = [...digest.processes].reverse();
  return [
    ...headerLines(digest),
    ...problemSection(digest, options, day),
    ...section("FAILED REQUESTS (status ×count route first→last)", digest.failedRoutes, options.maxRoutes, (issue) => routeLine(issue, day)),
    ...section("SLOW REQUESTS (streams excluded)", digest.slowRoutes, options.maxRoutes, (issue) => routeLine(issue, day)),
    ...section(lifecycleTitle(digest, options), digest.lifecycle.slice(-options.maxLifecycle), options.maxLifecycle, (event) => lifecycleLine(event, day)),
    ...section("PROCESSES (newest first; pid first→last)", latestFirst, options.maxProcesses, (process) => processLine(process, day)),
  ].join("\n");
}

const REQUEST_FIELDS = new Set(["reqId", "method", "url", "statusCode", "responseTime"]);

function requestSummary(record: LogRecord): string | undefined {
  const { method, url, statusCode, responseTime } = record.fields;
  if (record.msg === "incoming request") return `${method ?? "?"} ${url ?? ""}`;
  if (record.msg !== "request completed") return undefined;
  const ms = responseTime === undefined ? "" : ` ${Math.round(Number(responseTime))}ms`;
  return `${statusCode ?? "?"}${ms}`;
}

function extraFields(record: LogRecord): string {
  const pairs = Object.entries(record.fields).filter(([key]) => !REQUEST_FIELDS.has(key) || key === "reqId");
  return pairs.map(([key, value]) => `${key}=${clip(value, 120)}`).join(" ");
}

/** One record as a headline plus its error and top frames; never the raw multi-line body. */
export function formatRecord(record: LogRecord, frames: number): string[] {
  const summary = requestSummary(record);
  const fields = summary === undefined ? extraFields(record) : `${extraFields(record)} ${summary}`.trim();
  const headline = `${record.stamp.slice(CLOCK_START)} ${record.level.toUpperCase()} pid ${record.pid} ${record.msg}${fields === "" ? "" : ` | ${fields}`}`;
  const err = errLine(record);
  const errLines = [...(err === undefined ? [] : [`   ${clip(err)}`]), ...pickFrames(record.err?.frames ?? [], frames).map((frame) => `     ${clip(frame)}`)];
  return [clip(headline, MAX_LINE_LENGTH * 2), ...errLines];
}

export function renderRecordList(selection: Selection, query: LogQuery, frames: number): string {
  if (selection.total === 0) {
    const hint = query.includeRequests ? "" : " (request records are hidden; add --requests to include them)";
    return `No records matched${hint}.`;
  }
  const hidden = selection.total - selection.shown.length;
  const tail = hidden > 0 ? [`(+${hidden} more; raise --limit or narrow the filters)`] : [];
  return [`${selection.total} matching ${selection.total === 1 ? "record" : "records"}`, ...selection.shown.flatMap((record) => formatRecord(record, frames)), ...tail].join("\n");
}
