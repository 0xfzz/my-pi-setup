import test from "node:test";
import assert from "node:assert/strict";

import { type LogRecord, stampToMs } from "../lib/web-log-parse.ts";
import { buildQuery, matchesList, needsAnchor, parseCliArgs, resolveTimeSpec, selectRecords, USAGE, type CliArgs, type LogQuery } from "../lib/web-log-query.ts";

const NEWEST = stampToMs("2026-11-17 20:40:00.000");

function args(argv: string[]): CliArgs {
  const parsed = parseCliArgs(argv);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return parsed.args;
}

function query(argv: string[]): LogQuery {
  const built = buildQuery(args(argv), NEWEST);
  assert.ok(built.ok, built.ok ? "" : built.error);
  return built.query;
}

const rec = (msg: string, at: string, extra: Partial<LogRecord> = {}): LogRecord => ({
  ms: stampToMs(`2026-11-17 ${at}`), stamp: `2026-11-17 ${at}`, level: "info", pid: 1, msg, fields: {}, lines: [msg], ...extra,
});

test("no arguments means digest mode with sensible defaults", () => {
  const q = query([]);
  assert.equal(q.list, false);
  assert.equal(q.limit, 25);
  assert.equal(q.includeRequests, false);
});

test("an unknown option is refused rather than ignored", () => {
  assert.deepEqual(parseCliArgs(["--sinse", "5m"]), { ok: false, error: 'unknown option "--sinse"' });
});

test("a value flag at the end of argv says what is missing", () => {
  assert.deepEqual(parseCliArgs(["--pid"]), { ok: false, error: "--pid needs a value" });
});

test("numeric flags reject non-numbers and negatives", () => {
  assert.match(String((parseCliArgs(["--limit", "ten"]) as { error: string }).error), /non-negative integer/);
  assert.match(String((parseCliArgs(["--pid", "-3"]) as { error: string }).error), /non-negative integer/);
});

test("--min-level only accepts a real level", () => {
  assert.equal(args(["--min-level", "error"]).minLevel, "error");
  assert.match(String((parseCliArgs(["--min-level", "toString"]) as { error: string }).error), /must be one of/);
});

test("relative times count back from the newest record, not the wall clock", () => {
  assert.equal(resolveTimeSpec("30m", NEWEST), NEWEST - 30 * 60_000);
  assert.equal(resolveTimeSpec("2h", NEWEST), NEWEST - 2 * 3_600_000);
});

test("a bare clock time lands on the day of the newest record", () => {
  assert.equal(resolveTimeSpec("20:15", NEWEST), stampToMs("2026-11-17 20:15:00.000"));
  assert.equal(resolveTimeSpec("9:05:30", NEWEST), stampToMs("2026-11-17 09:05:30.000"));
});

test("a full timestamp is taken as written, with a space or a T", () => {
  const expected = stampToMs("2026-11-16 08:00:00.000");
  assert.equal(resolveTimeSpec("2026-11-16 08:00", NEWEST), expected);
  assert.equal(resolveTimeSpec("2026-11-16T08:00:00", NEWEST), expected);
});

test("text that is not a time resolves to nothing", () => {
  for (const bad of ["", "banana", "25h2", "2026-13", "-5m"]) assert.equal(resolveTimeSpec(bad, NEWEST), undefined, bad);
});

test("only relative and clock-only specs need the newest record", () => {
  assert.equal(needsAnchor(args(["--since", "5m"])), true);
  assert.equal(needsAnchor(args(["--since", "2026-11-17 20:00"])), false);
  assert.equal(needsAnchor(args([])), false);
});

test("a bad time is reported with the flag that carried it", () => {
  const built = buildQuery(args(["--since", "banana"]), NEWEST);
  assert.equal(built.ok, false);
  assert.match(built.ok ? "" : built.error, /--since "banana"/);
});

test("a malformed --grep pattern is an error, not a crash", () => {
  const built = buildQuery(args(["--grep", "("]), NEWEST);
  assert.equal(built.ok, false);
  assert.match(built.ok ? "" : built.error, /not a valid regular expression/);
});

test("--req, --grep and --around each switch to list mode; --req keeps request records", () => {
  assert.equal(query(["--grep", "boom"]).list, true);
  assert.equal(query(["--around", "20:22:39"]).list, true);
  const byRequest = query(["--req", "req-y"]);
  assert.equal(byRequest.list, true);
  assert.equal(byRequest.includeRequests, true);
});

test("--around opens a window of the requested size on both sides", () => {
  const q = query(["--around", "20:22:39", "--window", "5s"]);
  const centre = stampToMs("2026-11-17 20:22:39.000");
  assert.equal(q.sinceMs, centre - 5000);
  assert.equal(q.untilMs, centre + 5000);
});

test("list mode hides request noise unless asked", () => {
  const q = query(["--list"]);
  assert.equal(matchesList(rec("incoming request", "20:00:00.000"), q), false);
  assert.equal(matchesList(rec("agent command threw", "20:00:00.000"), q), true);
  assert.equal(matchesList(rec("incoming request", "20:00:00.000"), query(["--list", "--requests"])), true);
});

test("--pid and the time window both restrict list results", () => {
  const q = query(["--list", "--pid", "2", "--since", "20:10"]);
  assert.equal(matchesList(rec("x", "20:20:00.000", { pid: 2 }), q), true);
  assert.equal(matchesList(rec("x", "20:20:00.000", { pid: 1 }), q), false);
  assert.equal(matchesList(rec("x", "20:00:00.000", { pid: 2 }), q), false);
});

test("--grep matches the whole record text, case-insensitively", () => {
  const q = query(["--grep", "ENOENT"]);
  assert.equal(matchesList(rec("agent threw", "20:00:00.000", { lines: ["agent threw", "    spawn pi enoent"] }), q), true);
  assert.equal(matchesList(rec("agent threw", "20:00:00.000"), q), false);
});

test("--min-level filters list results by severity", () => {
  const q = query(["--list", "--min-level", "error"]);
  assert.equal(matchesList(rec("w", "20:00:00.000", { level: "warn" }), q), false);
  assert.equal(matchesList(rec("e", "20:00:00.000", { level: "fatal" }), q), true);
});

test("selection reports the true total even when it truncates to the limit", () => {
  const records = Array.from({ length: 10 }, (_, n) => rec(`m${n}`, "20:00:00.000"));
  const selection = selectRecords(records, query(["--list", "--limit", "3"]));
  assert.equal(selection.shown.length, 3);
  assert.equal(selection.total, 10);
});

test("every option the usage text advertises is accepted by the parser", () => {
  // The usage text is what an agent reads to learn the flags; a flag documented
  // there but rejected here would send it down a dead end.
  const advertised = [...new Set(USAGE.match(/--[a-z-]+/g) ?? [])];
  assert.ok(advertised.length >= 10, "usage should list the options");
  for (const flag of advertised) {
    const asValue = parseCliArgs([flag, "1"]);
    const asSwitch = parseCliArgs([flag]);
    assert.ok(asValue.ok || asSwitch.ok || !/unknown option/.test(asValue.error), `${flag} is documented but unknown to the parser`);
  }
});
