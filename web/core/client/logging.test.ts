import test from "node:test";
import assert from "node:assert/strict";
import type { LogEvent } from "pino";
import { createBrowserLogSender, installBrowserLogging, reportClientError, reportClientWarning } from "./logging.ts";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(calls: FetchCall[]): typeof fetch {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 200 });
  };
}

function event(level: string, messages: unknown[], ts = 1): LogEvent {
  return { ts, level: { label: level, value: 50 }, messages, bindings: [] };
}

test("browser log sender posts bounded, redacted entries with stacks", async () => {
  const calls: FetchCall[] = [];
  const sender = createBrowserLogSender({ fetch: fakeFetch(calls), endpoint: "/test-log" });
  sender.send(event("error", [{ err: new Error("browser boom") }, "Bearer abc123 leaked"]));
  await sender.flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "/test-log");
  const body = JSON.parse(String(calls[0]!.init?.body)) as { entries: Array<{ level: string; message: string; stack?: string; source: string }> };
  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0]!.level, "error");
  assert.equal(body.entries[0]!.source, "browser");
  assert.match(body.entries[0]!.message, /Bearer \[REDACTED\] leaked/);
  assert.match(String(body.entries[0]!.stack), /browser boom/);
});

test("browser log sender ignores unsupported levels and empty events", async () => {
  const calls: FetchCall[] = [];
  const sender = createBrowserLogSender({ fetch: fakeFetch(calls) });
  sender.send(event("nonsense", ["ignored"]));
  sender.send(event("warn", []));
  await sender.flush();
  assert.equal(calls.length, 0);
});

test("handled client failures use the installed logger with their stacks", async () => {
  const calls: FetchCall[] = [];
  const logging = installBrowserLogging({
    fetch: fakeFetch(calls),
    target: { addEventListener() {}, removeEventListener() {} } as unknown as Pick<Window, "addEventListener" | "removeEventListener">,
    console: { warn() {}, error() {} } as unknown as Pick<Console, "warn" | "error">,
    setTimeout: (callback) => { callback(); return 1; },
    clearTimeout: () => {},
  });

  reportClientError("handled failure", new Error("save failed"), { operation: "save" });
  reportClientWarning("soft failure", new Error("retry failed"), { operation: "retry" });
  await logging.flush();

  const entries = calls.flatMap(call => {
    const body = JSON.parse(String(call.init?.body)) as { entries: Array<{ level: string; message: string; stack?: string }> };
    return body.entries;
  });
  assert.ok(entries.some(entry => entry.level === "error" && entry.message.includes("save failed") && entry.stack?.includes("save failed")));
  assert.ok(entries.some(entry => entry.level === "warn" && entry.message.includes("retry failed")));
  logging.stop();
});

test("browser logging forwards console errors, uncaught errors and rejections", async () => {
  const calls: FetchCall[] = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const target = {
    addEventListener(type: string, listener: (...args: unknown[]) => void) { listeners.set(type, listener); },
    removeEventListener(type: string) { listeners.delete(type); },
  } as unknown as Pick<Window, "addEventListener" | "removeEventListener">;
  const consoleMethods = {
    warn() {},
    error() {},
  } as unknown as Pick<Console, "warn" | "error">;
  const logging = installBrowserLogging({
    fetch: fakeFetch(calls),
    target,
    console: consoleMethods,
    setTimeout: (callback) => { callback(); return 1; },
    clearTimeout: () => {},
  });

  consoleMethods.error("console boom");
  const error = new Error("uncaught boom");
  listeners.get("error")?.({ error, message: error.message, filename: "app.js", lineno: 1, colno: 2 } as unknown as ErrorEvent);
  listeners.get("unhandledrejection")?.({ reason: "rejected boom" } as unknown as PromiseRejectionEvent);
  await logging.flush();

  const bodies = calls.map(call => JSON.parse(String(call.init?.body)) as { entries: Array<{ message: string }> });
  const messages = bodies.flatMap(body => body.entries.map(entry => entry.message));
  assert.ok(messages.some(message => message.includes("console boom")));
  assert.ok(messages.some(message => message.includes("uncaught boom")));
  assert.ok(messages.some(message => message.includes("rejected boom")));
  logging.stop();
});
