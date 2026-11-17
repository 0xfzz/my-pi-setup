import test from "node:test";
import assert from "node:assert/strict";

import { buildDigest, normalizeRoute } from "../lib/web-log-digest.ts";
import { type LogLevel, type LogRecord, stampToMs } from "../lib/web-log-parse.ts";

let clock = stampToMs("2026-11-17 20:00:00.000");

function record(partial: Partial<LogRecord> & { msg: string }): LogRecord {
  clock += 1000;
  return { ms: clock, stamp: new Date(clock).toISOString(), level: "info", pid: 1, fields: {}, lines: [], ...partial };
}

const incoming = (reqId: string, method: string, url: string, pid = 1) => record({ msg: "incoming request", pid, fields: { reqId, method, url } });
const completed = (reqId: string, statusCode: number, responseTime: number, pid = 1) =>
  record({ msg: "request completed", pid, fields: { reqId, statusCode: String(statusCode), responseTime: String(responseTime) } });
const failure = (msg: string, errMessage: string, level: LogLevel = "error", pid = 1) =>
  record({ msg, level, pid, err: { message: errMessage, frames: [] } });

test("a crash loop that logs the same failure many times is one group with a count", () => {
  const records = Array.from({ length: 500 }, () => failure("agent command threw", "spawn pi ENOENT"));
  const digest = buildDigest(records);
  assert.equal(digest.problems.length, 1);
  assert.equal(digest.problems[0].count, 500);
});

test("the same message with a different error is a different problem", () => {
  const digest = buildDigest([failure("agent command threw", "spawn pi ENOENT"), failure("agent command threw", "EACCES: permission denied")]);
  assert.equal(digest.problems.length, 2);
});

test("ids inside an error message do not split one failure into many groups", () => {
  const digest = buildDigest([
    failure("agent command threw", "failed to spawn a session host for e2e1a1e7ca24b4"),
    failure("agent command threw", "failed to spawn a session host for 0a1b2c3d4e5f60"),
  ]);
  assert.equal(digest.problems.length, 1);
});

test("warnings that differ only in free text collapse into one group with variants", () => {
  const warnings = ["artifacts", "ask-user", "modes"].map((name) =>
    record({ msg: "web plugin host warning", level: "warn", fields: { warning: `shadowed ${name}` } }),
  );
  const [group, ...rest] = buildDigest(warnings).problems;
  assert.equal(rest.length, 0);
  assert.equal(group.count, 3);
  assert.equal(group.details.size, 3);
});

test("problems are ordered most severe first, then earliest", () => {
  const digest = buildDigest([failure("late warn", "x", "warn"), failure("first error", "y", "error"), failure("fatal", "z", "fatal")]);
  assert.deepEqual(digest.problems.map((p) => p.level), ["fatal", "error", "warn"]);
});

test("records below the problem level never become problems", () => {
  const digest = buildDigest([record({ msg: "listening", level: "info" })]);
  assert.deepEqual(digest.problems, []);
});

test("min problem level can be raised to ignore warnings", () => {
  const digest = buildDigest([failure("noisy", "x", "warn"), failure("real", "y", "error")], { slowMs: 2000, minProblemLevel: "error" });
  assert.deepEqual(digest.problems.map((p) => p.msg), ["real"]);
});

test("request pairs are counted but never stored as problems", () => {
  const digest = buildDigest([incoming("req-1", "GET", "/api/health"), completed("req-1", 200, 3)]);
  assert.equal(digest.requests, 1);
  assert.deepEqual(digest.failedRoutes, []);
  assert.deepEqual(digest.problems, []);
});

test("failed requests group by status and route with ids normalised away", () => {
  const digest = buildDigest([
    incoming("req-1", "GET", "/api/agent/01a1e776-52a4-7725-a01b-7f07f63ab564/commands"), completed("req-1", 404, 2),
    incoming("req-2", "GET", "/api/agent/01a1e893-79ef-7228-8ca5-fcb0774042c7/commands"), completed("req-2", 404, 5),
  ]);
  assert.equal(digest.failedRoutes.length, 1);
  assert.equal(digest.failedRoutes[0].route, "GET /api/agent/:id/commands");
  assert.equal(digest.failedRoutes[0].count, 2);
});

test("server errors are listed before more frequent client errors", () => {
  const digest = buildDigest([
    ...[1, 2, 3].flatMap((n) => [incoming(`a${n}`, "GET", "/favicon.ico"), completed(`a${n}`, 404, 1)]),
    incoming("b", "POST", "/api/x"), completed("b", 503, 1),
  ]);
  assert.deepEqual(digest.failedRoutes.map((r) => r.status), [503, 404]);
});

test("request ids restart per process, so the same id in two pids is not mixed up", () => {
  const digest = buildDigest([
    incoming("req-1", "GET", "/a", 1), incoming("req-1", "GET", "/b", 2),
    completed("req-1", 500, 1, 1), completed("req-1", 500, 1, 2),
  ]);
  assert.deepEqual(digest.failedRoutes.map((r) => r.route).sort(), ["GET /a", "GET /b"]);
});

test("long-lived streams are not reported as slow requests", () => {
  const digest = buildDigest([
    incoming("s1", "GET", "/api/bridge/01a1e776-52a4-7725-a01b-7f07f63ab564/attach"), completed("s1", 200, 3_000_000),
    incoming("s2", "GET", "/api/agent/01a1e776-52a4-7725-a01b-7f07f63ab564/events"), completed("s2", 200, 90_000),
  ]);
  assert.deepEqual(digest.slowRoutes, []);
});

test("an ordinary slow request is reported with its worst time", () => {
  const digest = buildDigest([incoming("r", "GET", "/api/agent/x/history"), completed("r", 200, 4200)]);
  assert.equal(digest.slowRoutes[0].route, "GET /api/agent/x/history");
  assert.equal(digest.slowRoutes[0].maxMs, 4200);
});

test("a problem remembers which request was being served and which session it concerned", () => {
  const digest = buildDigest([
    incoming("req-y", "GET", "/api/agent/e2e1a1e7ca24b4"),
    record({ msg: "agent command threw", level: "error", fields: { reqId: "req-y", sessionId: "e2e1a1e7ca24b4" }, err: { message: "boom", frames: [] } }),
  ]);
  assert.equal(digest.problems[0].sampleRoute, "GET /api/agent/:id");
  assert.deepEqual(digest.problems[0].sessionIds, ["e2e1a1e7ca24b4"]);
});

test("a completion whose request began before the window is still counted, with an honest route", () => {
  const digest = buildDigest([completed("req-9", 500, 1)]);
  assert.match(digest.failedRoutes[0].route, /began before this window/);
});

test("processes are summarised in start order with their own problem counts", () => {
  const digest = buildDigest([record({ msg: "listening", pid: 10 }), failure("boom", "x", "error", 20), record({ msg: "listening", pid: 10 })]);
  assert.deepEqual(digest.processes.map((p) => [p.pid, p.records, p.problems]), [[10, 2, 0], [20, 1, 1]]);
});

test("lifecycle keeps the newest events when there are more than it can hold", () => {
  const events = Array.from({ length: 60 }, (_, n) => record({ msg: `server listening #${n}` }));
  const { lifecycle } = buildDigest(events);
  assert.equal(lifecycle.length, 40);
  assert.match(lifecycle.at(-1)?.text ?? "", /#59$/);
});

test("an empty stream digests to zero records", () => {
  const digest = buildDigest([]);
  assert.equal(digest.records, 0);
  assert.deepEqual(digest.problems, []);
});

test("normalizeRoute drops the query string and non-uuid ids but keeps asset names", () => {
  assert.equal(normalizeRoute("/api/bridge/3ce88709-8630fb50-61f3b5b6-0760/events?x=1"), "/api/bridge/:id/events");
  assert.equal(normalizeRoute("/chunk-JTX4HWDT.js"), "/chunk-JTX4HWDT.js");
  assert.equal(normalizeRoute("/api/items/42"), "/api/items/:id");
});
