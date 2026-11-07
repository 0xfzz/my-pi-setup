import test from "node:test";
import assert from "node:assert/strict";

import { CircuitBreaker } from "../lib/web-plugins/kernel/breaker.ts";
import { runWithBudget } from "../lib/web-plugins/kernel/budget.ts";
import { AuditLog } from "../lib/web-plugins/kernel/audit.ts";

test("the breaker trips exactly once, on the failure that reaches the threshold", () => {
  let now = 0;
  const breaker = new CircuitBreaker({ threshold: 3, windowMs: 60_000, clock: () => now });
  assert.equal(breaker.recordFailure(), false);
  assert.equal(breaker.recordFailure(), false);
  assert.equal(breaker.recordFailure(), true);
  assert.equal(breaker.isTripped, true);
  assert.equal(breaker.recordFailure(), false, "a tripped breaker does not trip again");
});

test("failures outside the window do not count", () => {
  let now = 0;
  const breaker = new CircuitBreaker({ threshold: 3, windowMs: 1000, clock: () => now });
  breaker.recordFailure();
  breaker.recordFailure();
  now = 1500;
  assert.equal(breaker.count(), 0);
  assert.equal(breaker.recordFailure(), false);
  assert.equal(breaker.isTripped, false);
});

test("reset clears the trip and the window (quarantine clear)", () => {
  const breaker = new CircuitBreaker({ threshold: 1, windowMs: 1000 });
  assert.equal(breaker.recordFailure(), true);
  breaker.reset();
  assert.equal(breaker.isTripped, false);
  assert.equal(breaker.count(), 0);
});

test("invalid breaker settings are rejected up front", () => {
  assert.throws(() => new CircuitBreaker({ threshold: 0, windowMs: 1000 }), RangeError);
  assert.throws(() => new CircuitBreaker({ threshold: 1, windowMs: 0 }), RangeError);
});

test("runWithBudget returns the value when work settles inside the budget", async () => {
  const out = await runWithBudget("setup", 200, () => 42);
  assert.equal(out.ok, true);
  assert.ok(out.ok && out.value === 42);
});

test("a slow activate times out, aborts its signal, and reports the budget", async () => {
  let aborted = false;
  const out = await runWithBudget("activate", 20, (signal) =>
    new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      setTimeout(resolve, 500);
    }));
  assert.equal(out.ok, false);
  assert.ok(!out.ok && out.reason === "timeout");
  assert.match(!out.ok ? out.error : "", /activate exceeded its 20 ms budget/);
  assert.equal(aborted, true);
});

test("a throwing plugin is an error outcome, never an exception into the host", async () => {
  const out = await runWithBudget("setup", 200, () => {
    throw new Error("boom");
  });
  assert.equal(out.ok, false);
  assert.ok(!out.ok && out.reason === "error" && out.error === "boom");
});

test("the audit log is bounded, keeps counting sequence numbers, and filters", () => {
  const log = new AuditLog({ limit: 2, clock: () => 7 });
  log.append("discovered", "acme.a", "found");
  log.append("granted", "acme.a", "routes");
  log.append("capability-denied", "acme.b", "session.write");
  assert.equal(log.dropped, 1);
  assert.deepEqual(log.list().map((e) => e.seq), [2, 3]);
  assert.deepEqual(log.list({ pluginId: "acme.b" }).map((e) => e.kind), ["capability-denied"]);
  assert.equal(log.list({ kind: "granted" }).length, 1);
});
