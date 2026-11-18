// Bridge protocol hot-path benchmark: latency and transient heap per operation.
//
// Run with `npm run bench:bridge` (Node is started with --expose-gc). The
// payloads are generated in-process; no server, browser or home-directory
// state is needed. This is deliberately not part of `npm test` or `test:web`.
//
// Heap figures are approximate bytes allocated per operation, measured as the
// heap growth across a bounded run before the collector intervenes. They are
// useful for comparing two revisions of the same scenario, not as an absolute
// memory guarantee. Retained heap is measured separately after a forced GC.

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { parseEnvelope, type BridgeEnvelope } from "../core/protocol/envelope.ts";
import { publishBridgeMessage } from "../core/protocol/publisher.ts";
import { lookupMessage, MESSAGE_NAMES } from "../core/protocol/catalog.ts";
import { BRIDGE_PROTOCOL, BRIDGE_PROTOCOL_VERSION } from "../core/protocol/version.ts";
import { createProtocolHost } from "../core/server/protocol-host.ts";
import { protocolEvent } from "../core/server/event-stream.ts";
import { createStreamTracker } from "../core/server/stream-tracker.ts";
import { slimBridgeEvent } from "../../lib/bridge-event-slim.ts";
import type { SessionSurface } from "../core/adapters/session.ts";

interface Scenario {
  readonly name: string;
  readonly unit: string;
  readonly iterations: number;
  readonly heapIterations: number;
  /** Acceptance ceilings: p95 latency in ms, allocation in bytes per operation. */
  readonly budgetP95Ms: number;
  readonly budgetHeapBytes: number;
  run(): number | Promise<number>;
}

const gc = (): void => (globalThis as typeof globalThis & { gc?: () => void }).gc?.();

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
}

const TEXT = "The bridge protocol carries session events and UI updates. ".repeat(80);

function envelope(name: string, payload: unknown): BridgeEnvelope {
  return {
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_PROTOCOL_VERSION,
    kind: "event",
    name,
    messageId: "bench-message",
    sessionId: "bench-session",
    source: { type: "browser", id: "pi-web" },
    timestamp: 0,
    payload,
  };
}

function parseScenario(): Scenario {
  const frame = JSON.parse(JSON.stringify(envelope("session.events", { type: "message_update", text: TEXT }))) as BridgeEnvelope;
  const customNames = ["fixture.note", "router.route.changed", "todo.tasks.changed", "files.tree.changed"];
  return {
    name: "envelope-parse",
    unit: "frame",
    iterations: 5_000,
    heapIterations: 1_000,
    budgetP95Ms: 0.05,
    budgetHeapBytes: 16_000,
    run() {
      const parsed = parseEnvelope(frame, customNames);
      return parsed.ok ? parsed.envelope.messageId.length : 0;
    },
  };
}

function lookupScenario(): Scenario {
  let index = 0;
  return {
    name: "catalog-lookup",
    unit: "name",
    iterations: 20_000,
    heapIterations: 10_000,
    budgetP95Ms: 0.005,
    budgetHeapBytes: 512,
    run() {
      index = (index + 1) % MESSAGE_NAMES.length;
      return lookupMessage(MESSAGE_NAMES[index] ?? "")?.name.length ?? 0;
    },
  };
}

function publishScenario(): Scenario {
  let emitted = 0;
  const pi = { events: { emit: () => { emitted += 1; } } };
  let sequence = 0;
  return {
    name: "envelope-publish",
    unit: "event",
    iterations: 5_000,
    heapIterations: 1_000,
    budgetP95Ms: 0.05,
    budgetHeapBytes: 16_000,
    run() {
      sequence += 1;
      const result = publishBridgeMessage(pi, { type: "extension", id: "fixture" }, "ui.status.changed", { text: TEXT }, `fixture:${sequence}`);
      return result.ok ? result.envelope.name.length : 0;
    },
  };
}

const STUB_SESSION: SessionSurface = {
  prompt: () => {},
  abort: () => {},
  get: () => ({ running: false, state: null }),
  models: () => ({ models: [{ provider: "openai", id: "gpt-5" }] }),
  snapshot: () => ({ views: {} }),
  resync: () => ({ entries: [] }),
};

async function protocolScenario(): Promise<Scenario> {
  const host = createProtocolHost({
    sessionId: "bench-session",
    cwd: process.cwd(),
    grantedCapabilities: ["session.read"],
    session: STUB_SESSION,
  });
  const hello = await host.handle(envelope("bridge.hello", {
    version: BRIDGE_PROTOCOL_VERSION,
    bindings: ["http-sse"],
    clientId: "pi-web",
    capabilities: ["session.read"],
  }));
  assert.equal(hello.ok, true, "handshake must succeed");
  const request = envelope("session.models", {});
  return {
    name: "protocol-query",
    unit: "request",
    iterations: 2_000,
    heapIterations: 500,
    budgetP95Ms: 0.08,
    budgetHeapBytes: 24_000,
    async run() {
      const reply = await host.handle(request);
      return reply.ok ? reply.value.name.length : 0;
    },
  };
}

function eventFrameScenario(): Scenario {
  let sequence = 0;
  const tracker = createStreamTracker();
  tracker.feed({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "" }] } });
  return {
    name: "bridge-event-frame",
    unit: "delta",
    iterations: 5_000,
    heapIterations: 1_000,
    budgetP95Ms: 0.05,
    budgetHeapBytes: 16_000,
    run() {
      sequence += 1;
      const delta = { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } };
      const slimmer = slimBridgeEvent(delta);
      tracker.feed(slimmer);
      const frame = protocolEvent("session.events", "bench-session", slimmer, sequence);
      return JSON.stringify(frame).length;
    },
  };
}

async function measure(scenario: Scenario): Promise<{ p50: number; p95: number; p99: number; heap: number; retained: number }> {
  scenario.run();
  const warmup = Math.min(100, Math.floor(scenario.iterations / 10));
  for (let index = 0; index < warmup; index += 1) await scenario.run();

  const elapsed: number[] = [];
  let total = 0;
  for (let index = 0; index < scenario.iterations; index += 1) {
    const start = performance.now();
    total += await scenario.run();
    elapsed.push(performance.now() - start);
  }
  elapsed.sort((a, b) => a - b);

  gc();
  const heapStart = process.memoryUsage().heapUsed;
  for (let index = 0; index < scenario.heapIterations; index += 1) total += await scenario.run();
  const heapEnd = process.memoryUsage().heapUsed;
  gc();
  const heapSettled = process.memoryUsage().heapUsed;
  assert.ok(total > 0, `${scenario.name} produced no output`);
  return {
    p50: percentile(elapsed, 0.5),
    p95: percentile(elapsed, 0.95),
    p99: percentile(elapsed, 0.99),
    heap: Math.max(0, heapEnd - heapStart) / scenario.heapIterations,
    retained: Math.max(0, heapSettled - heapStart) / scenario.heapIterations,
  };
}

const scenarios = [
  lookupScenario(),
  parseScenario(),
  publishScenario(),
  await protocolScenario(),
  eventFrameScenario(),
];

console.log(`bridge protocol benchmark — node ${process.version}, lower is better`);
console.log("scenario              unit          p50(ms)    p95(ms)    p99(ms)    B/op    kept/op   p95 budget  B budget  verdict");
let failed = false;
for (const scenario of scenarios) {
  const result = await measure(scenario);
  const latencyOk = result.p95 <= scenario.budgetP95Ms;
  const heapOk = result.heap <= scenario.budgetHeapBytes;
  if (!latencyOk || !heapOk) failed = true;
  console.log(
    `${scenario.name.padEnd(21)} ${scenario.unit.padEnd(13)} ${result.p50.toFixed(4).padStart(8)} ${result.p95.toFixed(4).padStart(10)} ${result.p99.toFixed(4).padStart(10)} ${result.heap.toFixed(0).padStart(7)} ${result.retained.toFixed(1).padStart(10)} ${scenario.budgetP95Ms.toFixed(4).padStart(11)} ${String(scenario.budgetHeapBytes).padStart(9)}  ${latencyOk && heapOk ? "PASS" : "FAIL"}`,
  );
}
if (failed) process.exitCode = 1;
