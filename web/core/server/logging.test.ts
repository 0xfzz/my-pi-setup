import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { createWebLogger, installCrashLogging, type CrashProcess } from "../http/logging.ts";
import { lineLogStream } from "../http/observability.ts";

function capturedLines(): { lines: string[]; stream: ReturnType<typeof lineLogStream> } {
  const lines: string[] = [];
  return { lines, stream: lineLogStream(line => lines.push(line)) };
}

test("web logger appends redacted JSON lines with error stacks to its file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-logging-"));
  const file = join(dir, "nested", "pi-web.log");
  const console = capturedLines();
  try {
    const logging = createWebLogger({
      env: { ...process.env, PI_WEB_LOG_FILE: file, PI_WEB_LOG_FILE_FORMAT: "json", PI_WEB_LOG_LEVEL: "info" },
      stderr: console.stream,
      isTTY: false,
    });
    logging.logger.error({ err: new Error("disk boom"), password: "hunter2", token: "abc123" }, "failed");
    logging.flush();

    const raw = await readFile(file, "utf8");
    assert.ok(!raw.includes("hunter2"));
    assert.ok(!raw.includes("abc123"));
    assert.match(raw, /\[REDACTED\]/);
    const logged = raw.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal(logged[0]?.msg, "failed");
    assert.match(String((logged[0]?.err as { stack?: string } | undefined)?.stack), /disk boom/);
    assert.ok(console.lines.some(line => line.includes("ERROR") && line.includes("failed")), "console stays pretty");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("web logger writes readable text with stacks to its default file format", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-logging-pretty-"));
  const file = join(dir, "pi-web.log");
  const console = capturedLines();
  try {
    const logging = createWebLogger({
      env: { ...process.env, PI_WEB_LOG_FILE: file, PI_WEB_LOG_LEVEL: "error" },
      stderr: console.stream,
      isTTY: false,
    });
    logging.logger.error({ err: new Error("pretty boom") }, "pretty failure");
    logging.flush();

    const raw = await readFile(file, "utf8");
    assert.match(raw, /pretty failure/);
    assert.match(raw, /pretty boom/);
    assert.doesNotMatch(raw.trimStart(), /^\{/, "the default log file is human-readable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("crash handlers log fatal stacks and node warnings before exiting", () => {
  const { lines, stream } = capturedLines();
  const logger = pino({ level: "trace", serializers: { err: pino.stdSerializers.err } }, stream);
  const events = new EventEmitter();
  const exits: number[] = [];
  const target: CrashProcess = {
    on(event, listener) {
      events.on(event, listener);
      return target;
    },
    exit(code = 1) {
      exits.push(code);
      throw new Error("test exit");
    },
  };
  installCrashLogging(logger, target);

  assert.throws(() => events.emit("uncaughtException", new Error("fatal crash"), "test"), /test exit/);
  assert.throws(() => events.emit("unhandledRejection", "plain reason"), /test exit/);
  events.emit("warning", new Error("node warning"));

  const logged = lines.map(line => JSON.parse(line) as Record<string, unknown>);
  assert.ok(logged.some(line => line.msg === "uncaught exception" && String((line.err as { stack?: string }).stack).includes("fatal crash")));
  assert.ok(logged.some(line => line.msg === "unhandled rejection" && (line.err as { message?: string }).message === "plain reason"));
  assert.ok(logged.some(line => line.msg === "node warning" && String((line.err as { stack?: string }).stack).includes("node warning")));
  assert.deepEqual(exits, [1, 1]);
});
