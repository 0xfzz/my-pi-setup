import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ACTIVE_WINDOW_MS, decideBudget } from "../../lib/delegation/budget.ts";

const MIN = 60_000;
const base = { budgetMs: 30 * MIN, nowMs: 1_000_000_000 };

describe("progress-aware budget", () => {
  it("is fine before the soft limit", () => {
    assert.equal(decideBudget({ ...base, elapsedMs: 10 * MIN, lastActivityAt: null }), "ok");
  });
  it("extends a child that is still writing its transcript", () => {
    assert.equal(decideBudget({ ...base, elapsedMs: 31 * MIN, lastActivityAt: base.nowMs - 30_000 }), "extend");
  });
  it("trips a quiet child at the soft limit", () => {
    assert.equal(decideBudget({ ...base, elapsedMs: 31 * MIN, lastActivityAt: base.nowMs - ACTIVE_WINDOW_MS - 1 }), "trip");
    assert.equal(decideBudget({ ...base, elapsedMs: 31 * MIN, lastActivityAt: null }), "trip");
  });
  it("always trips at the hard cap, active or not", () => {
    assert.equal(decideBudget({ ...base, elapsedMs: 120 * MIN, lastActivityAt: base.nowMs }), "trip");
    assert.equal(decideBudget({ ...base, elapsedMs: 50 * MIN, lastActivityAt: base.nowMs, hardCapMs: 45 * MIN }), "trip");
  });
});
