import test from "node:test";
import assert from "node:assert/strict";
import { isWebLogFileDisabled, shouldPrettyLog, webLogFileFormat, webLogFilePath } from "../lib/web-logging.ts";
import { parseWebLogLevel } from "../web/core/shared/web-log-levels.ts";
import {
  browserLogEntry,
  browserLogLine,
  parseBrowserLogEntries,
  redactLogText,
  rejectionError,
} from "../web/core/shared/web-log-browser.ts";

test("web log level accepts pino levels and falls back to info", () => {
  assert.equal(parseWebLogLevel("debug"), "debug");
  assert.equal(parseWebLogLevel(" TRACE "), "trace");
  assert.equal(parseWebLogLevel("nonsense"), "info");
  assert.equal(parseWebLogLevel(undefined), "info");
});

test("web log file settings support a default path and explicit disable", () => {
  assert.equal(webLogFilePath("/agents/pi"), "/agents/pi/logs/pi-web.log");
  assert.equal(webLogFilePath("/agents/pi", "/tmp/custom.log"), "/tmp/custom.log");
  assert.equal(isWebLogFileDisabled("off"), true);
  assert.equal(isWebLogFileDisabled("0"), true);
  assert.equal(isWebLogFileDisabled(undefined), false);
  assert.equal(webLogFileFormat("json"), "json");
  assert.equal(webLogFileFormat(undefined), "pretty");
  assert.equal(shouldPrettyLog(false, "1"), true);
  assert.equal(shouldPrettyLog(true, "off"), false);
  assert.equal(shouldPrettyLog(true, undefined), true);
});

test("free-form log text redacts common credential shapes", () => {
  const text = redactLogText("Bearer abc.def-123 token=shh password: hunter2 api_key=xyz cookie: sid=1");
  assert.match(text, /Bearer \[REDACTED\]/);
  assert.match(text, /token=\[REDACTED\]/);
  assert.match(text, /password: \[REDACTED\]/);
  assert.match(text, /api_key=\[REDACTED\]/);
  assert.match(text, /cookie: \[REDACTED\]/);
});

test("browser log lines keep error stacks and bound their text", () => {
  const error = new Error("boom");
  const line = browserLogLine("error", [{ err: error }, "failed"]);
  assert.equal(line?.level, "error");
  assert.match(String(line?.message), /Error: boom failed/);
  assert.match(String(line?.stack), /Error: boom/);
  assert.equal(browserLogLine("nonsense", ["x"]), undefined);
  assert.equal(browserLogLine("warn", []), undefined);
  assert.equal(browserLogEntry("fatal", ["dead"], 12)?.ts, 12);
});

test("browser log payloads are re-validated and redacted by the server", () => {
  const valid = {
    entries: [{
      level: "error",
      message: "Bearer abc123 leaked",
      stack: "Error: x\n at page",
      ts: 42,
      source: "browser",
    }],
  };
  const parsed = parseBrowserLogEntries(valid);
  assert.equal(parsed?.length, 1);
  assert.match(parsed![0]!.message, /Bearer \[REDACTED\] leaked/);
  assert.equal(parseBrowserLogEntries({ entries: [] }), undefined);
  assert.equal(parseBrowserLogEntries({ entries: [{ ...valid.entries[0], source: "cli" }] }), undefined);
  assert.equal(parseBrowserLogEntries({ entries: [{ ...valid.entries[0], level: "nonsense" }] }), undefined);
});

test("non-error rejection reasons are rendered as named errors", () => {
  const error = rejectionError("nope");
  assert.equal(error.name, "UnhandledRejection");
  assert.equal(error.message, "nope");
  const original = new Error("original");
  assert.equal(rejectionError(original), original);
});
