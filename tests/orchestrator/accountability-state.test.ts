import test from "node:test";
import assert from "node:assert/strict";
import { ScopeRegistry, type ScopedChild } from "../../lib/orchestrator/scope-registry.ts";

function child(id = "first"): ScopedChild {
  return {
    id, name: id, scope: "unit", sessionFile: "/tmp/unit.jsonl", status: "running",
    laneFiles: ["src/unit.ts"], lastMilestoneFiles: [], updatedAt: "2026-01-01",
    accountability: {
      ownerSessionId: "parent", batchId: "parent:1", workUnitKey: "unit",
      delegationReason: "Independent substantial task", reviewPlan: "Read diff and run tests",
      resultRevision: 0, disposition: "pending", reviews: [], attempts: [],
    },
  };
}
const decision = {
  disposition: "accepted" as const, resultRevision: 1, summary: "Checked criteria",
  evidence: ["file digest checked"], integration: "Integrated and tested",
};

test("terminal execution remains owned and pending, including after pane cleanup", () => {
  const r = new ScopeRegistry();
  r.registerChild(child());
  r.updateStatus("/tmp/unit.jsonl", "completed");
  assert.equal(r.getPendingResults("parent").length, 1);
  r.closeChild("/tmp/unit.jsonl", "user-closed");
  assert.equal(r.getOccupiedChildren("parent").length, 1);
  assert.equal(r.getChildById("first")!.accountability!.resultRevision, 1);
  r.recordDisposition("parent", "first", decision);
  r.recordDisposition("parent", "first", decision);
  assert.equal(r.getOccupiedChildren("parent").length, 0);
  assert.equal(r.getChildById("first")!.accountability!.reviews.length, 1);
});

test("disposition refuses live work, wrong parent, stale attempt/revision, and absent evidence", () => {
  const r = new ScopeRegistry();
  r.registerChild(child());
  assert.throws(() => r.recordDisposition("parent", "first", decision), /active/);
  r.updateStatus("/tmp/unit.jsonl", "failed");
  assert.throws(() => r.recordDisposition("other", "first", decision), /owner/);
  assert.throws(() => r.recordDisposition("parent", "old", decision), /Unknown/);
  assert.throws(() => r.recordDisposition("parent", "first", { ...decision, resultRevision: 0 }), /Stale/);
  assert.throws(() => r.recordDisposition("parent", "first", { ...decision, evidence: [] }), /evidence/);
});

test("resume retains owner, audit trail and spend but invalidates accepted output", () => {
  const r = new ScopeRegistry();
  r.registerChild(child());
  r.recordLaunch("parent");
  r.updateStatus("/tmp/unit.jsonl", "completed");
  r.recordDisposition("parent", "first", decision);
  const next = child("second");
  delete next.accountability;
  r.registerChild(next);
  const a = next.accountability!;
  assert.equal(a.ownerSessionId, "parent");
  assert.equal(a.disposition, "pending");
  assert.equal(a.resultRevision, 2);
  assert.equal(a.attempts[0].reviews[0].disposition, "accepted");
  assert.equal(r.getBatch("parent").launches, 1);
  // The superseded attempt is unknown by id but named in its successor's trail:
  // the refusal says the verdict is stale, not that the child never existed.
  assert.throws(() => r.recordDisposition("parent", "first", decision), /Stale/);
});

test("snapshot preserves obligations and cumulative batches; reset is session isolated", () => {
  const r = new ScopeRegistry();
  r.registerChild(child());
  r.recordLaunch("parent");
  r.closeChild("/tmp/unit.jsonl", "pane-gone");
  const restored = new ScopeRegistry();
  restored.loadSnapshot(JSON.parse(JSON.stringify(r.toSnapshot())));
  assert.equal(restored.getBatch("parent").launches, 1);
  assert.equal(restored.getPendingResults("parent").length, 1);
  assert.equal(restored.getPendingResults("other").length, 0);
  assert.equal(restored.newBatch("parent").launches, 0);
  assert.equal(restored.getPendingResults("parent").length, 1);
  restored.reset();
  assert.equal(restored.getAllChildren().length, 0);
  assert.equal(restored.getBatch("other").id, "other:1");
});

test("legacy terminal rows remain unreviewed without a retroactive review backlog", () => {
  const r = new ScopeRegistry();
  const legacy = child();
  delete legacy.accountability;
  legacy.status = "completed";
  r.loadSnapshot({ version: 1, savedAt: "now", children: [legacy], steers: [], reviews: [] });
  assert.equal(r.getChildById("first")!.accountability, undefined);
  assert.equal(r.getPendingResults().length, 0);
  assert.throws(() => r.recordDisposition("parent", "first", decision), /legacy/);
});
