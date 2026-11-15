// Shutdown is where a leak becomes an orphan: an unbounded teardown is killed
// by the supervisor, and every child the host still tracked survives it. These
// tests pin the deadline, not the steps.

import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SHUTDOWN_BUDGET_MS, runTeardown, teardownNote } from "../web/core/server/shutdown.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("steps run in order and a clean teardown reports nothing", async () => {
  const order: string[] = [];
  const outcome = await runTeardown([
    { name: "http", run: async () => void order.push("http") },
    { name: "host", run: async () => void order.push("host") },
  ]);
  assert.deepEqual(order, ["http", "host"]);
  assert.deepEqual(outcome, { failed: [], timedOut: false });
  assert.equal(teardownNote(outcome), "");
});

test("a step that never settles is abandoned, and the rest still run", async () => {
  const ran: string[] = [];
  const outcome = await runTeardown(
    [
      { name: "hung", run: () => new Promise<void>(() => undefined) },
      { name: "host", run: async () => void ran.push("host") },
    ],
    { budgetMs: 60 },
  );
  assert.deepEqual(ran, ["host"], "a hung step must not block the ones after it");
  assert.deepEqual(outcome.failed, ["hung"]);
  assert.equal(outcome.timedOut, true);
});

test("a step that throws is recorded and the next step still runs", async () => {
  const ran: string[] = [];
  const outcome = await runTeardown([
    { name: "http", run: async () => Promise.reject(new Error("already closed")) },
    { name: "host", run: async () => void ran.push("host") },
  ]);
  assert.deepEqual(ran, ["host"]);
  assert.deepEqual(outcome.failed, ["http"]);
  assert.equal(outcome.timedOut, false, "an error is not a timeout");
  assert.match(teardownNote(outcome), /reported: http/);
});

test("two slow steps cannot exceed one overall deadline", async () => {
  const started = Date.now();
  const outcome = await runTeardown(
    [
      { name: "first", run: () => sleep(120) },
      { name: "second", run: () => sleep(120) },
    ],
    { budgetMs: 100 },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 300, `teardown must respect one deadline, took ${elapsed} ms`);
  assert.deepEqual(outcome.failed, ["first", "second"]);
  assert.equal(outcome.timedOut, true);
});

test("a step's own budget overrides its share of the total", async () => {
  const ran: string[] = [];
  const outcome = await runTeardown(
    [
      { name: "quick", run: () => sleep(120), budgetMs: 20 },
      { name: "host", run: async () => void ran.push("host") },
    ],
    { budgetMs: 200 },
  );
  assert.deepEqual(ran, ["host"], "the remaining budget still serves the next step");
  assert.deepEqual(outcome.failed, ["quick"]);
  assert.equal(outcome.timedOut, true);
  assert.match(teardownNote(outcome), new RegExp(`${DEFAULT_SHUTDOWN_BUDGET_MS} ms budget`));
});
