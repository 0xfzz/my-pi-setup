// Standalone latency benchmark for the pi-web hot paths.
//
// Every scenario measures one operation with a high-resolution clock and
// reports p50/p95/p99 in milliseconds. LOWER IS BETTER: a scenario's p95 is
// compared against its acceptance ceiling and the process exits non-zero when
// any ceiling is exceeded. Fixtures are generated in-process; no network
// beyond loopback, no user home directory and no running server are required.
//
// This is deliberately not part of `npm test` or `npm run test:web`.

import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { FastifyReply, FastifyRequest } from "fastify";
import { deriveKey, signJwt, verifyJwt, type JwtClaims } from "../core/auth/jwt.ts";
import { createStreamTracker } from "../core/server/stream-tracker.ts";
import { BoundedSseEvents, MAIN_SSE_LIMITS } from "../../lib/sse-pressure.ts";
import { WebUiStore } from "../core/plugin-contracts/ui-state-store.ts";
import { readHistory } from "../core/server/sessions.ts";
import { createWebApp } from "../core/server/app.ts";
import { setServedRoot } from "../core/server/client-build.ts";

interface Sample {
  p50: number;
  p95: number;
  p99: number;
  total: number;
}

interface Scenario {
  name: string;
  unit: string;
  /** Acceptance ceiling for p95, in milliseconds. Lower latency is better. */
  budgetP95Ms: number;
  iterations: number;
  setup?(): Promise<void> | void;
  run(): Promise<void> | void;
  teardown?(): Promise<void> | void;
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
}

async function sample(scenario: Scenario): Promise<Sample> {
  const warmup = Math.min(100, Math.floor(scenario.iterations / 10));
  for (let index = 0; index < warmup; index += 1) await scenario.run();
  const elapsed: number[] = [];
  let total = 0;
  for (let index = 0; index < scenario.iterations; index += 1) {
    const start = performance.now();
    await scenario.run();
    const duration = performance.now() - start;
    elapsed.push(duration);
    total += duration;
  }
  elapsed.sort((a, b) => a - b);
  return { p50: percentile(elapsed, 0.5), p95: percentile(elapsed, 0.95), p99: percentile(elapsed, 0.99), total };
}

const SECRET = Buffer.from("pi-web latency benchmark secret", "utf8");
const KEY = deriveKey(SECRET, "access");
const KID = "bench-kid";
const NOW_MS = Date.parse("2026-01-15T12:00:00.000Z");
const CLAIMS: JwtClaims = {
  iss: "pi-web",
  aud: "pi-web",
  sub: "bench-user",
  use: "access",
  iat: Math.floor(NOW_MS / 1000),
  exp: Math.floor(NOW_MS / 1000) + 3600,
  jti: "bench-jti",
  sid: "bench-session",
};
const TOKEN = signJwt(CLAIMS, KEY, KID);

function trackerScenario(): Scenario {
  let feed: (event: unknown) => void = () => {};
  let snapshot = (): unknown => null;
  let delta = 0;
  return {
    name: "stream-tracker",
    unit: "delta",
    budgetP95Ms: 2,
    iterations: 5_000,
    setup() {
      const tracker = createStreamTracker();
      feed = tracker.feed;
      snapshot = tracker.snapshot;
      const partial = (content: unknown[]) => ({ role: "assistant", content });
      tracker.feed({ type: "message_start", message: partial([]) });
      tracker.feed({
        type: "message_update",
        assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: partial([{ type: "text", text: "" }]) },
      });
      const argumentsBlock = { type: "toolCall", id: "c", name: "bash", arguments: {} };
      tracker.feed({
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 1,
          partial: partial([{ type: "text", text: "" }, argumentsBlock]),
        },
      });
      tracker.feed({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"text":"' },
      });
      for (let index = 0; index < 1_000; index += 1) {
        tracker.feed({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "x" } });
      }
    },
    run() {
      feed({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
      });
      delta += 1;
    },
    teardown() {
      assert.equal((snapshot() as { message?: { content?: Array<{ text?: string }> } }).message?.content?.[0]?.text?.length, delta);
    },
  };
}

function sseEncodeScenario(): Scenario {
  let buffer = new BoundedSseEvents();
  let key = 0;
  let encodedBytes = 0;
  return {
    name: "sse-coalesce",
    unit: "frame",
    // Encoded fast path: ~0.012 ms here; encode/parse/encode was ~0.021 ms.
    budgetP95Ms: 0.015,
    iterations: 3_000,
    setup() {
      buffer = new BoundedSseEvents();
      key = 0;
      encodedBytes = 0;
    },
    run() {
      key += 1;
      const event = { type: "tool_execution_update", toolCallId: `call-${key}`, partialResult: "x".repeat(2_048) };
      buffer.put(key, event, MAIN_SSE_LIMITS.closeAboveBytes);
      for (const { encoded } of buffer.consumeEncoded()) encodedBytes += Buffer.byteLength(encoded) + 8;
    },
    teardown() {
      assert.ok(encodedBytes > 0);
      assert.equal(buffer.bytes, 0);
    },
  };
}

function uiSnapshotScenario(): Scenario {
  let store = new WebUiStore();
  let key = 0;
  let frameBytes = 0;
  return {
    name: "ui-snapshot",
    unit: "publish+snapshot",
    // Per-session frozen snapshots: ~0.13 ms here; global clone was ~2.5 ms.
    budgetP95Ms: 0.3,
    iterations: 500,
    setup() {
      store = new WebUiStore();
      key = 0;
      frameBytes = 0;
      for (let session = 0; session < 32; session += 1) {
        store.publish(`session-${session}`, "ui.view.changed", {
          pluginId: "todo",
          view: { type: "kv", title: "todo", rows: Array.from({ length: 50 }, () => ({ label: "k", value: "v" })) },
        }, `setup-${session}`);
      }
    },
    run() {
      key += 1;
      store.publish("session-0", "ui.status.changed", { key: "status", text: `step ${key}` }, `source-${key % 100}`);
      const snapshot = store.snapshot();
      frameBytes += JSON.stringify(snapshot.sessions["session-0"]).length;
    },
    teardown() {
      assert.ok(frameBytes > 0);
    },
  };
}

async function historyScenario(): Promise<Scenario> {
  let directory = "";
  let file = "";
  let entries = 0;
  return {
    name: "history-tail",
    unit: "read",
    // Bounded tail reads: ~1.5 ms here; whole-file reads were ~4 ms.
    budgetP95Ms: 3,
    iterations: 30,
    async setup() {
      directory = await mkdtemp(join(tmpdir(), "pi-web-bench-history-"));
      file = join(directory, "session.jsonl");
      const line = `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "synthetic history line" }] } })}\n`;
      const block = line.repeat(500);
      const chunks: string[] = [];
      for (let index = 0; index < 80; index += 1) chunks.push(block);
      await writeFile(file, chunks.join(""), "utf8");
    },
    async run() {
      const history = await readHistory(file, 25);
      entries = history.entries.length;
    },
    async teardown() {
      assert.equal(entries, 25);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function httpScenarios(): Promise<Scenario[]> {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-bench-http-"));
  await writeFile(join(directory, "index.html"), "<html><head></head><body>bench</body></html>", "utf8");
  await writeFile(join(directory, "app.js"), 'console.log("bench");', "utf8");
  await writeFile(join(directory, "build.json"), JSON.stringify({ buildId: "bench-build", builtAt: NOW_MS }), "utf8");
  setServedRoot(directory);
  const app = await createWebApp({
    staticRoot: directory,
    authorize: (request: FastifyRequest, reply: FastifyReply): boolean => {
      if (!request.url.startsWith("/api/")) return true;
      const header = request.headers.authorization;
      const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!verifyJwt(token, { key: KEY, kid: KID, use: "access", now: NOW_MS, leewaySeconds: 30 }).ok) {
        void reply.code(401).send({ error: "unauthorized" });
        return false;
      }
      return true;
    },
  });
  app.get("/api/ping", async () => ({ ok: true }));
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Bearer ${TOKEN}` };

  const request = async (path: string): Promise<void> => {
    const response = await fetch(`${base}${path}`, { headers });
    await response.arrayBuffer();
    if (response.status !== 200) throw new Error(`${path} answered ${response.status}`);
  };
  for (const path of ["/api/ping", "/app.js", "/"]) await request(path);

  const close = async (): Promise<void> => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  };
  const paths = [
    { name: "http-api", path: "/api/ping", budgetP95Ms: 20 },
    { name: "http-asset", path: "/app.js", budgetP95Ms: 20 },
    { name: "http-shell", path: "/", budgetP95Ms: 20 },
  ];
  return paths.map(({ name, path, budgetP95Ms }) => ({
    name,
    unit: "request",
    budgetP95Ms,
    iterations: 1_000,
    run: () => request(path),
    teardown: path === "/" ? close : undefined,
  }));
}

function jwtScenario(): Scenario {
  return {
    name: "jwt-verify",
    unit: "verify",
    // Cached codecs: ~0.023 ms here; the uncached baseline was ~0.031 ms.
    budgetP95Ms: 0.03,
    iterations: 3_000,
    run() {
      const result = verifyJwt(TOKEN, { key: KEY, kid: KID, use: "access", now: NOW_MS, leewaySeconds: 30 });
      if (!result.ok) throw new Error(`unexpected JWT failure: ${result.reason}`);
    },
  };
}

async function main(): Promise<void> {
  const scenarios: Scenario[] = [
    jwtScenario(),
    trackerScenario(),
    sseEncodeScenario(),
    uiSnapshotScenario(),
    await historyScenario(),
    ...await httpScenarios(),
  ];

  console.log(`pi-web latency benchmark — node ${process.version}, lower is better`);
  console.log("scenario              unit              p50(ms)   p95(ms)   p99(ms)   budget   verdict");
  let failed = false;
  for (const scenario of scenarios) {
    await scenario.setup?.();
    let result: Sample;
    try {
      result = await sample(scenario);
    } finally {
      await scenario.teardown?.();
    }
    const passed = result.p95 <= scenario.budgetP95Ms;
    if (!passed) failed = true;
    console.log(
      `${scenario.name.padEnd(21)} ${scenario.unit.padEnd(17)} ${result.p50.toFixed(4).padStart(8)} ${result.p95.toFixed(4).padStart(10)} ${result.p99.toFixed(4).padStart(10)} ${scenario.budgetP95Ms.toFixed(4).padStart(8)} ${passed ? "PASS" : "FAIL"}`,
    );
  }
  if (failed) process.exitCode = 1;
}

await main();
