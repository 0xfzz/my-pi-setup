import test from "node:test";
import assert from "node:assert/strict";

import { buildDigest } from "../lib/web-log-digest.ts";
import { type LogRecord, parseLogLines } from "../lib/web-log-parse.ts";
import { type LogQuery } from "../lib/web-log-query.ts";
import { DEFAULT_RENDER_OPTIONS, formatRecord, pickFrames, renderDigest, renderRecordList } from "../lib/web-log-render.ts";

const parse = (text: string): LogRecord[] => [...parseLogLines(text.split("\n"))];

const CRASH = `[2026-11-17 20:22:39.407] FATAL (784109): uncaught exception
    origin: "uncaughtException"
    err: {
      "type": "Error",
      "message": "spawn pi ENOENT",
      "stack":
          Error: spawn pi ENOENT
              at ChildProcess._handle.onexit (node:internal/child_process:285:19)
              at spawnHost (file:///repo/session-host.ts:126:11)
      "code": "ENOENT"
    }`;

const listQuery: LogQuery = { limit: 25, list: true, includeRequests: false };

test("the digest names the failure, its code and the application frame that caused it", () => {
  const text = renderDigest(buildDigest(parse(CRASH)));
  assert.match(text, /FATAL 20:22:39 pid 784109 — uncaught exception/);
  assert.match(text, /Error: spawn pi ENOENT \[ENOENT\]/);
  assert.match(text, /at spawnHost \(\/repo\/session-host\.ts:126:11\)/);
});

test("Node internals are dropped from the frames unless nothing else is left", () => {
  const frames = ["at a (node:internal/x:1:1)", "at mine (/repo/a.ts:1:1)", "at b (/repo/node_modules/dep/i.js:1:1)"];
  assert.deepEqual(pickFrames(frames, 4), ["at mine (/repo/a.ts:1:1)"]);
  assert.deepEqual(pickFrames(["at a (node:internal/x:1:1)"], 4), ["at a (node:internal/x:1:1)"]);
});

test("the frame limit is respected", () => {
  const frames = ["at a (/r/1.ts:1:1)", "at b (/r/2.ts:1:1)", "at c (/r/3.ts:1:1)"];
  assert.equal(pickFrames(frames, 2).length, 2);
});

test("a huge noisy log renders within a bounded size", () => {
  const records = Array.from({ length: 300 }, (_, n) => ({
    ms: n, stamp: `2026-11-17 20:00:${String(n % 60).padStart(2, "0")}.000`, level: "error" as const, pid: 1, msg: `distinct failure ${n}`,
    fields: {}, err: { message: `unique problem ${String.fromCharCode(97 + (n % 26))}${"x".repeat(n % 7)}${n}`, frames: [] }, lines: [],
  }));
  const text = renderDigest(buildDigest(records));
  assert.ok(text.split("\n").length < 80, `rendered ${text.split("\n").length} lines`);
  assert.match(text, /\(\+\d+ more groups/);
});

test("an error that only repeats the headline is not printed twice", () => {
  const records = parse(`[2026-11-17 20:37:21.427] WARN (790746): Error: GET /x failed with HTTP 404
    err: {
      "type": "Object",
      "message": "Error: GET /x failed with HTTP 404",
      "stack":
          @https://example.test/app.js:10:6230
    }`);
  const lines = formatRecord(records[0], 4);
  assert.equal(lines.filter((line) => line.includes("failed with HTTP 404")).length, 1);
  assert.ok(lines.some((line) => line.includes("app.js:10:6230")), "the browser frame is still shown");
});

test("an empty digest says so instead of printing empty sections", () => {
  assert.equal(renderDigest(buildDigest([])), "No log records matched the filters.");
});

test("a clean log reports no problems rather than omitting the section", () => {
  const text = renderDigest(buildDigest(parse("[2026-11-17 20:00:00.000] INFO (1): pi-web-minimal listening")));
  assert.match(text, /PROBLEMS: none/);
});

test("a request pair is shown as one readable line each", () => {
  const records = parse(`[2026-11-17 20:00:00.000] INFO (1): incoming request
    reqId: "req-1"
    req: {
      "method": "GET",
      "url": "/api/health"
    }
[2026-11-17 20:00:00.010] INFO (1): request completed
    reqId: "req-1"
    res: {
      "statusCode": 503
    }
    responseTime: 9.6`);
  assert.match(formatRecord(records[0], 4)[0], /GET \/api\/health/);
  assert.match(formatRecord(records[1], 4)[0], /503 10ms/);
});

test("an empty list explains that request records are hidden", () => {
  assert.match(renderRecordList({ shown: [], total: 0 }, listQuery, 4), /--requests/);
  assert.doesNotMatch(renderRecordList({ shown: [], total: 0 }, { ...listQuery, includeRequests: true }, 4), /--requests/);
});

test("a truncated list says how many records it left out", () => {
  const records = parse(CRASH);
  assert.match(renderRecordList({ shown: records, total: 9 }, listQuery, 4), /\(\+8 more/);
});

test("the section caps come from the options, not from hidden constants", () => {
  const records = Array.from({ length: 5 }, (_, n) => ({
    ms: n, stamp: "2026-11-17 20:00:00.000", level: "error" as const, pid: 1, msg: `m${n}`, fields: {}, err: { message: `e${n}`, frames: [] }, lines: [],
  }));
  const text = renderDigest(buildDigest(records), { ...DEFAULT_RENDER_OPTIONS, maxProblems: 2 });
  assert.match(text, /\(\+3 more groups/);
});
