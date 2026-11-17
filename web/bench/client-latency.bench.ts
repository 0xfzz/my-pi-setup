// Browser-side hot paths that can be measured in Node without a DOM.
//
// Kept separate from the server benchmark: the server must never import client
// source (tests/web-boundaries.test.ts enforces that rule). Lower is better.

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { streamReducer, INITIAL_STREAMING_STATE } from "../core/client/streaming.ts";
import { splitMarkdownChunks } from "../core/client/markdown-chunks.ts";

interface Scenario {
  name: string;
  unit: string;
  budgetP95Ms: number;
  iterations: number;
  setup?(): void;
  run(): void;
  teardown?(): void;
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
}

function clientStreamScenario(): Scenario {
  let state = INITIAL_STREAMING_STATE;
  let delta = 0;
  return {
    name: "client-stream-delta",
    unit: "delta",
    budgetP95Ms: 0.01,
    iterations: 5_000,
    setup() {
      state = streamReducer(state, { type: "message_start", message: { role: "assistant", content: [{ kind: "text", text: "" }] } });
      state = streamReducer(state, { type: "delta", event: { type: "text_start", contentIndex: 0 } });
      delta = 0;
    },
    run() {
      state = streamReducer(state, { type: "delta", event: { type: "text_delta", contentIndex: 0, delta: "x" } });
      delta += 1;
    },
    teardown() {
      assert.equal((state.streamingMessage?.content[0] as { text?: string } | undefined)?.text?.length, delta);
    },
  };
}

function markdownScenario(): Scenario {
  let text = "";
  let stableChunks = 0;
  return {
    name: "markdown-split",
    unit: "append",
    budgetP95Ms: 0.15,
    iterations: 2_000,
    setup() {
      text = "";
      stableChunks = 0;
    },
    run() {
      text += "A benchmark sentence that grows one delta at a time. ";
      if (text.length % 400 < 50) text += "\n\n";
      stableChunks = splitMarkdownChunks(text).stable.length;
    },
    teardown() {
      assert.ok(stableChunks > 0);
    },
  };
}

function measure(scenario: Scenario): { p50: number; p95: number; p99: number } {
  scenario.setup?.();
  const warmup = Math.min(100, Math.floor(scenario.iterations / 10));
  for (let index = 0; index < warmup; index += 1) scenario.run();
  const elapsed: number[] = [];
  try {
    for (let index = 0; index < scenario.iterations; index += 1) {
      const start = performance.now();
      scenario.run();
      elapsed.push(performance.now() - start);
    }
  } finally {
    scenario.teardown?.();
  }
  elapsed.sort((a, b) => a - b);
  return { p50: percentile(elapsed, 0.5), p95: percentile(elapsed, 0.95), p99: percentile(elapsed, 0.99) };
}

const scenarios = [clientStreamScenario(), markdownScenario()];
console.log(`pi-web client latency benchmark — node ${process.version}, lower is better`);
console.log("scenario              unit              p50(ms)   p95(ms)   p99(ms)   budget   verdict");
let failed = false;
for (const scenario of scenarios) {
  const result = measure(scenario);
  const passed = result.p95 <= scenario.budgetP95Ms;
  if (!passed) failed = true;
  console.log(
    `${scenario.name.padEnd(21)} ${scenario.unit.padEnd(17)} ${result.p50.toFixed(4).padStart(8)} ${result.p95.toFixed(4).padStart(10)} ${result.p99.toFixed(4).padStart(10)} ${scenario.budgetP95Ms.toFixed(4).padStart(8)} ${passed ? "PASS" : "FAIL"}`,
  );
}
if (failed) process.exitCode = 1;
