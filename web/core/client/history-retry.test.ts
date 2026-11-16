import test from "node:test";
import assert from "node:assert/strict";
import { HISTORY_FETCH_TIMEOUT_MS, historyRetryDelayMs } from "./history-retry.ts";

test("the first retry waits one second, and each later retry waits longer", () => {
  assert.equal(historyRetryDelayMs(0), 1_000);
  assert.equal(historyRetryDelayMs(1), 2_000);
  assert.equal(historyRetryDelayMs(2), 4_000);
  assert.equal(historyRetryDelayMs(3), 8_000);
});

test("retries keep going at the longest interval, so a slow network recovers without giving up", () => {
  assert.equal(historyRetryDelayMs(4), 8_000);
  assert.equal(historyRetryDelayMs(100), 8_000);
});

test("an invalid attempt number falls back to the first retry", () => {
  assert.equal(historyRetryDelayMs(-1), 1_000);
  assert.equal(historyRetryDelayMs(1.5), 1_000);
});

test("one attempt is long enough for a large conversation on a slow link", () => {
  assert.ok(HISTORY_FETCH_TIMEOUT_MS >= 30_000);
});
