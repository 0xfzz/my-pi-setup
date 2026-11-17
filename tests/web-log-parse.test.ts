import test from "node:test";
import assert from "node:assert/strict";

import { formatStamp, isLogLevel, parseLogLines, stampToMs } from "../lib/web-log-parse.ts";

const parse = (text: string) => [...parseLogLines(text.split("\n"))];

const PRETTY_ERROR = `[2026-11-17 20:22:39.404] ERROR (784109): agent command threw
    reqId: "req-y"
    sessionId: "abc123"
    err: {
      "type": "Error",
      "message": "failed to spawn",
      "stack":
          Error: failed to spawn
              at startSessionHost (file:///repo/session-host.ts:126:11)
              at node:internal/process:1:1
      "code": "ESPAWN"
    }`;

test("a pretty record keeps its continuation lines instead of becoming one record per line", () => {
  const [record, ...rest] = parse(PRETTY_ERROR);
  assert.equal(rest.length, 0);
  assert.equal(record.level, "error");
  assert.equal(record.pid, 784109);
  assert.equal(record.msg, "agent command threw");
  assert.equal(record.fields.reqId, "req-y");
  assert.equal(record.fields.sessionId, "abc123");
});

test("a pretty error exposes message, code and only the real stack frames", () => {
  const { err } = parse(PRETTY_ERROR)[0];
  assert.equal(err?.type, "Error");
  assert.equal(err?.message, "failed to spawn");
  assert.equal(err?.code, "ESPAWN");
  assert.deepEqual(err?.frames, ["at startSessionHost (file:///repo/session-host.ts:126:11)", "at node:internal/process:1:1"]);
});

test("request fields are read from the nested req/res blocks of a pretty record", () => {
  const [incoming, completed] = parse(`[2026-11-17 18:13:03.804] INFO (484442): incoming request
    reqId: "req-1"
    req: {
      "method": "GET",
      "url": "/api/health",
      "remotePort": 54906
    }
[2026-11-17 18:13:03.814] INFO (484442): request completed
    reqId: "req-1"
    res: {
      "statusCode": 503
    }
    responseTime: 8.5`);
  assert.deepEqual([incoming.fields.method, incoming.fields.url], ["GET", "/api/health"]);
  assert.deepEqual([completed.fields.statusCode, completed.fields.responseTime], ["503", "8.5"]);
});

test("a legacy JSON line becomes the same record shape as a pretty one", () => {
  const line = JSON.stringify({
    level: 60, time: 1794912964217, pid: 452934, hostname: "h", msg: "unhandled rejection", origin: "unhandledRejection",
    err: { type: "Error", message: "listen EADDRINUSE", code: "EADDRINUSE", stack: "Error: listen EADDRINUSE\n    at Server.setup (node:net:1:1)" },
  });
  const [record] = parse(line);
  assert.equal(record.level, "fatal");
  assert.equal(record.pid, 452934);
  assert.equal(record.stamp, formatStamp(1794912964217));
  assert.equal(record.fields.origin, "unhandledRejection");
  assert.equal(record.err?.code, "EADDRINUSE");
  assert.deepEqual(record.err?.frames, ["at Server.setup (node:net:1:1)"]);
});

test("a log that switched from JSON to pretty mid-file parses both eras in order", () => {
  const json = JSON.stringify({ level: 30, time: 1794912963346, pid: 1, msg: "old era" });
  const records = parse(`${json}\n[2026-11-17 18:13:03.740] INFO (2): new era`);
  assert.deepEqual(records.map((r) => r.msg), ["old era", "new era"]);
});

test("a line that is neither JSON nor pretty is surfaced instead of silently dropped", () => {
  const records = parse("[2026-11-17 18:13:03.740] INFO (2): fine\nSegmentation fault (core dumped)");
  assert.equal(records.length, 2);
  assert.equal(records[1].level, "warn");
  assert.match(records[1].msg, /unparsed log line: Segmentation fault/);
  assert.equal(records[1].pid, 2, "an orphan line is attributed to the process that was logging before it");
});

test("blank lines and an empty file produce no records", () => {
  assert.deepEqual(parse(""), []);
  assert.deepEqual(parse("\n\n   \n"), []);
});

test("browser-style stack frames from /api/client/log are kept as frames", () => {
  const { err } = parse(`[2026-11-17 20:37:21.427] WARN (790746): Error: boom
    err: {
      "type": "Object",
      "message": "boom",
      "stack":
          @https://example.test/app.js:10:6230
    }`)[0];
  assert.deepEqual(err?.frames, ["@https://example.test/app.js:10:6230"]);
});

test("stamps round-trip through milliseconds in local time", () => {
  const ms = stampToMs("2026-11-17 20:22:39.404");
  assert.equal(formatStamp(ms), "2026-11-17 20:22:39.404");
});

test("isLogLevel rejects names that are not levels, including inherited object keys", () => {
  assert.equal(isLogLevel("warn"), true);
  assert.equal(isLogLevel("toString"), false);
  assert.equal(isLogLevel("verbose"), false);
});
