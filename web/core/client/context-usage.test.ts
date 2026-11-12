import test from "node:test";
import assert from "node:assert/strict";
import {
  clampPercent,
  contextLevel,
  contextUsageDisplay,
  formatTokens,
} from "./context-usage.ts";

test("clampPercent bounds out-of-range and non-finite values to 0..100", () => {
  assert.equal(clampPercent(42), 42);
  assert.equal(clampPercent(0), 0);
  assert.equal(clampPercent(100), 100);
  assert.equal(clampPercent(-4), 0);
  assert.equal(clampPercent(140), 100);
  assert.equal(clampPercent(Number.NaN), 0);
  assert.equal(clampPercent(Number.POSITIVE_INFINITY), 0);
});

test("contextLevel thresholds at 80% warning and 95% critical", () => {
  assert.equal(contextLevel(0), "normal");
  assert.equal(contextLevel(79.9), "normal");
  assert.equal(contextLevel(80), "warning");
  assert.equal(contextLevel(94.9), "warning");
  assert.equal(contextLevel(95), "critical");
  assert.equal(contextLevel(200), "critical");
});

test("formatTokens renders raw, kilo and mega counts", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(-5), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(8400), "8.4k");
  assert.equal(formatTokens(200000), "200k");
  assert.equal(formatTokens(1_200_000), "1.2M");
  assert.equal(formatTokens(Number.NaN), "0");
});

test("contextUsageDisplay formats full, missing-window and missing-reading cases", () => {
  assert.deepEqual(
    contextUsageDisplay({ percent: 42, contextWindow: 200_000, tokens: 84_000 }),
    { percentLabel: "42%", tokensLabel: "84k", maxLabel: "200k", fillPercent: 42, level: "normal" },
  );
  assert.deepEqual(
    contextUsageDisplay({ percent: 130, contextWindow: 200_000, tokens: 240_000 }),
    { percentLabel: "100%", tokensLabel: "240k", maxLabel: "200k", fillPercent: 100, level: "critical" },
  );
  assert.deepEqual(
    contextUsageDisplay({ percent: 0, contextWindow: 0, tokens: 84_000 }),
    { percentLabel: "—", tokensLabel: "84k", maxLabel: "—", fillPercent: 0, level: "normal" },
  );
  assert.deepEqual(contextUsageDisplay(null), {
    percentLabel: "—",
    tokensLabel: "—",
    maxLabel: "—",
    fillPercent: 0,
    level: "normal",
  });
  assert.deepEqual(contextUsageDisplay(undefined), contextUsageDisplay(null));
});