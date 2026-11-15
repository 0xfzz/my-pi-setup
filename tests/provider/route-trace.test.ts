import assert from "node:assert/strict";
import test from "node:test";

import {
  describeDecision, formatTrace, MAX_DECISIONS, pushDecision, type DecisionRecord,
} from "../../lib/provider/route-trace.ts";

const record = (overrides: Partial<DecisionRecord> = {}): DecisionRecord => ({
  at: 1_000,
  route: "auto",
  reason: "user",
  chosen: "primary/main-model",
  chain: ["primary/main-model", "secondary/backup-model"],
  rejected: [],
  ...overrides,
});

test("a decision reads as when, which route, why, and what answered", () => {
  assert.equal(
    describeDecision(record(), 61_000),
    "1m ago · auto · user · → primary/main-model",
  );
});

test("a fallback names the target that could not serve and why", () => {
  const line = describeDecision(record({
    chosen: "secondary/backup-model",
    rejected: [{ target: "primary/main-model", why: 'provider "primary" is not registered' }],
  }), 1_500);
  assert.match(line, /→ secondary\/backup-model/);
  assert.match(line, /skipped primary\/main-model \(provider "primary" is not registered\)/);
});

test("a cache-driven non-switch says so, which is the invisible decision", () => {
  const line = describeDecision(record({ cache: "stayed: cache warm (warm 60k · 2m left · 94% hit)" }), 1_000);
  assert.match(line, /stayed: cache warm \(warm 60k · 2m left · 94% hit\)/);
});

test("a request that found no target reports the reason instead of an empty arrow", () => {
  const line = describeDecision(record({ chosen: "", error: 'route "auto" has no usable target' }), 1_000);
  assert.match(line, /→ no target/);
  assert.match(line, /failed: route "auto" has no usable target/);
});

test("a long reason is shortened to stay on one line", () => {
  const long = `x ${"y".repeat(400)}`;
  const line = describeDecision(record({ rejected: [{ target: "a/b", why: long }] }), 1_000);
  assert.equal(line.split("\n").length, 1);
  assert.ok(line.length < 200, `line stays readable: ${line.length}`);
  assert.match(line, /…\)$/);
});

test("the buffer keeps the newest decisions and drops the oldest", () => {
  let buffer: DecisionRecord[] = [];
  for (let index = 0; index < MAX_DECISIONS + 5; index++) buffer = pushDecision(buffer, record({ at: index }));
  assert.equal(buffer.length, MAX_DECISIONS);
  assert.equal(buffer[0]!.at, 5, "the oldest were dropped");
  assert.equal(buffer.at(-1)!.at, MAX_DECISIONS + 4);
});

test("an empty trace says so rather than printing nothing", () => {
  assert.match(formatTrace([], 0), /No routing decisions yet/);
});

test("the trace prints one line per decision, oldest first", () => {
  const text = formatTrace([record({ at: 1_000 }), record({ at: 2_000, reason: "retry" })], 3_000);
  const lines = text.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^2s ago · auto · user/);
  assert.match(lines[1]!, /^1s ago · auto · retry/);
});
