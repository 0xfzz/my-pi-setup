import test from "node:test";
import assert from "node:assert/strict";

import {
  assignAvailableSlots,
  computeQaPoolCap,
  createQaPool,
  createQaPoolState,
  DEFAULT_MAX_CONSECUTIVE_REVERIFY,
  deserializeQaPoolState,
  enqueueJob,
  failJob,
  MAX_POOL_CAP,
  MAX_WORKER_COUNT,
  MIN_WORKER_COUNT,
  recoverActiveSlots,
  reserveNextSlot,
  serializeQaPoolState,
  settleJob,
  type QaPoolState,
} from "../../lib/orchestrator/qa-pool.ts";

test("cap 1..8: computeQaPoolCap calculates frozen cap min(3, max(1, floor(workerCount / 2)))", () => {
  assert.equal(computeQaPoolCap(1), 1, "workerCount 1 -> cap 1");
  assert.equal(computeQaPoolCap(2), 1, "workerCount 2 -> cap 1");
  assert.equal(computeQaPoolCap(3), 1, "workerCount 3 -> cap 1");
  assert.equal(computeQaPoolCap(4), 2, "workerCount 4 -> cap 2");
  assert.equal(computeQaPoolCap(5), 2, "workerCount 5 -> cap 2");
  assert.equal(computeQaPoolCap(6), 3, "workerCount 6 -> cap 3");
  assert.equal(computeQaPoolCap(7), 3, "workerCount 7 -> cap 3");
  assert.equal(computeQaPoolCap(8), 3, "workerCount 8 -> cap 3");
});

test("bounded input validation: enforces positive integer wave size and bounds", () => {
  // computeQaPoolCap validation
  assert.throws(() => computeQaPoolCap(0), /must be a positive integer/);
  assert.throws(() => computeQaPoolCap(-1), /must be a positive integer/);
  assert.throws(() => computeQaPoolCap(2.5), /must be a positive integer/);
  assert.throws(() => computeQaPoolCap(Number.NaN), /must be a positive integer/);
  assert.throws(() => computeQaPoolCap(MAX_WORKER_COUNT + 1), /exceeds maximum supported wave size/);

  // createQaPoolState validation
  assert.throws(() => createQaPoolState({ workerCount: 0 }), /must be a positive integer/);
  assert.throws(() => createQaPoolState({ workerCount: -5 }), /must be a positive integer/);
  assert.throws(() => createQaPoolState({ workerCount: 1.5 }), /must be a positive integer/);
  assert.throws(() => createQaPoolState({ workerCount: 5, maxConsecutiveReverify: 0 }), /must be a positive integer/);

  // createQaPool constructor validation
  assert.throws(() => createQaPool({ workerCount: 0 }), /must be a positive integer/);
});

test("FIFO sequence with 5 completions and 2 slots", () => {
  // workerCount 5 -> frozen cap 2 (slots qa-1, qa-2)
  const pool = createQaPool({ workerCount: 5 });
  assert.equal(pool.capacity, 2);
  assert.deepEqual(
    pool.getSlots().map((s) => s.slotId),
    ["qa-1", "qa-2"],
  );

  // 5 worker completions arrive in FIFO sequence
  const e1 = pool.enqueue({ scope: "unit-1", attempt: 1, specHash: "h1" });
  const e2 = pool.enqueue({ scope: "unit-2", attempt: 1, specHash: "h2" });
  const e3 = pool.enqueue({ scope: "unit-3", attempt: 1, specHash: "h3" });
  const e4 = pool.enqueue({ scope: "unit-4", attempt: 1, specHash: "h4" });
  const e5 = pool.enqueue({ scope: "unit-5", attempt: 1, specHash: "h5" });

  assert.equal(e1.ok && e2.ok && e3.ok && e4.ok && e5.ok, true);
  assert.equal(pool.getQueueLength(), 5);

  // Initial reservation: slot 1 (qa-1) takes unit-1
  const r1 = pool.reserveNextSlot();
  assert.equal(r1.ok, true);
  assert.equal(r1.slot?.slotId, "qa-1");
  assert.equal(r1.job?.scope, "unit-1");
  assert.equal(pool.getJobStatus("unit-1", 1), "active");

  // Initial reservation: slot 2 (qa-2) takes unit-2
  const r2 = pool.reserveNextSlot();
  assert.equal(r2.ok, true);
  assert.equal(r2.slot?.slotId, "qa-2");
  assert.equal(r2.job?.scope, "unit-2");
  assert.equal(pool.getJobStatus("unit-2", 1), "active");

  // Both slots busy: third reservation is refused by cap
  const rBlocked = pool.reserveNextSlot();
  assert.equal(rBlocked.ok, false);
  assert.equal(rBlocked.reason, "no-free-slots");
  assert.equal(pool.isFull(), true);
  assert.equal(pool.getQueueLength(), 3); // unit-3, unit-4, unit-5 queued

  // unit-1 settles in qa-1 -> qa-1 freed -> immediately reserves queued unit-3
  const s1 = pool.settle({ assignmentToken: r1.assignmentToken!, verdict: "pass" });
  assert.equal(s1.ok, true);
  assert.equal(pool.getJobStatus("unit-1", 1), "completed");
  const r3 = pool.reserveNextSlot();
  assert.equal(r3.ok, true);
  assert.equal(r3.slot?.slotId, "qa-1");
  assert.equal(r3.job?.scope, "unit-3");

  // unit-2 settles in qa-2 -> qa-2 freed -> immediately reserves queued unit-4
  const s2 = pool.settle({ assignmentToken: r2.assignmentToken!, verdict: "pass" });
  assert.equal(s2.ok, true);
  assert.equal(pool.getJobStatus("unit-2", 1), "completed");
  const r4 = pool.reserveNextSlot();
  assert.equal(r4.ok, true);
  assert.equal(r4.slot?.slotId, "qa-2");
  assert.equal(r4.job?.scope, "unit-4");

  // unit-3 settles in qa-1 -> qa-1 freed -> reserves queued unit-5
  const s3 = pool.settle({ assignmentToken: r3.assignmentToken!, verdict: "pass" });
  assert.equal(s3.ok, true);
  const r5 = pool.reserveNextSlot();
  assert.equal(r5.ok, true);
  assert.equal(r5.slot?.slotId, "qa-1");
  assert.equal(r5.job?.scope, "unit-5");
  assert.equal(pool.getQueueLength(), 0);

  // unit-4 settles in qa-2 -> qa-2 freed
  const s4 = pool.settle({ assignmentToken: r4.assignmentToken!, verdict: "pass" });
  assert.equal(s4.ok, true);
  assert.equal(pool.getSlot("qa-2")?.busy, false);

  // unit-5 settles in qa-1 -> qa-1 freed
  const s5 = pool.settle({ assignmentToken: r5.assignmentToken!, verdict: "pass" });
  assert.equal(s5.ok, true);
  assert.equal(pool.getSlot("qa-1")?.busy, false);

  // All 5 units settled, queue empty, both slots idle
  assert.equal(pool.isIdle(), true);
  assert.equal(pool.getCompleted().length, 5);
  assert.deepEqual(
    pool.getCompleted().map((c) => c.job.scope),
    ["unit-1", "unit-2", "unit-3", "unit-4", "unit-5"],
  );
});

test("duplicate completion: deduplicates enqueued attempts and rejects repeated settlement", () => {
  const pool = createQaPool({ workerCount: 4 });

  // 1. Enqueue unit-dup
  const first = pool.enqueue({ scope: "unit-dup", attempt: 1, specHash: "hash-d" });
  assert.equal(first.ok, true);

  // Re-enqueue while queued is refused
  const dupQ = pool.enqueue({ scope: "unit-dup", attempt: 1, specHash: "hash-d" });
  assert.equal(dupQ.ok, false);
  assert.equal(dupQ.duplicateOf, "queue");

  // Reserve slot
  const res = pool.reserve();
  assert.equal(res.ok, true);
  const token = res.assignmentToken!;

  // Re-enqueue while active is refused
  const dupActive = pool.enqueue({ scope: "unit-dup", attempt: 1, specHash: "hash-d" });
  assert.equal(dupActive.ok, false);
  assert.equal(dupActive.duplicateOf, "active");

  // Settle job
  const settle1 = pool.settle({ assignmentToken: token, verdict: "pass" });
  assert.equal(settle1.ok, true);
  assert.equal(settle1.stale, false);

  // Repeated settlement with same token is refused (stale: true)
  const settle2 = pool.settle({ assignmentToken: token, verdict: "pass" });
  assert.equal(settle2.ok, false);
  assert.equal(settle2.stale, true);

  // Re-enqueue after completed is refused
  const dupCompleted = pool.enqueue({ scope: "unit-dup", attempt: 1, specHash: "hash-d" });
  assert.equal(dupCompleted.ok, false);
  assert.equal(dupCompleted.duplicateOf, "completed");

  // But attempt 2 for the same scope is permitted
  const attempt2 = pool.enqueue({ scope: "unit-dup", attempt: 2, specHash: "hash-d", kind: "reverify" });
  assert.equal(attempt2.ok, true);
});

test("simultaneous reservations: assignAvailableSlots and sequential reservations fill up to cap", () => {
  const pool = createQaPool({ workerCount: 6 }); // cap = 3: qa-1, qa-2, qa-3
  assert.equal(pool.capacity, 3);

  pool.enqueue({ scope: "u1", attempt: 1, specHash: "h1" });
  pool.enqueue({ scope: "u2", attempt: 1, specHash: "h2" });
  pool.enqueue({ scope: "u3", attempt: 1, specHash: "h3" });
  pool.enqueue({ scope: "u4", attempt: 1, specHash: "h4" });

  // Greedily fill available slots simultaneously
  const assigned = pool.assignAvailableSlots();
  assert.equal(assigned.length, 3);
  assert.deepEqual(
    assigned.map((a) => a.slot.slotId),
    ["qa-1", "qa-2", "qa-3"],
  );
  assert.deepEqual(
    assigned.map((a) => a.job.scope),
    ["u1", "u2", "u3"],
  );
  assert.equal(pool.getQueueLength(), 1);
  assert.equal(pool.isFull(), true);

  // Additional reservation attempt fails because all slots are occupied
  const extra = pool.reserve();
  assert.equal(extra.ok, false);
  assert.equal(extra.reason, "no-free-slots");
});

test("stale assignment result: old token cannot release or corrupt a newer assignment in the slot", () => {
  const pool = createQaPool({ workerCount: 2 }); // cap = 1 (slot qa-1)

  pool.enqueue({ scope: "job-A", attempt: 1, specHash: "hA" });
  const rA = pool.reserve();
  assert.equal(rA.ok, true);
  const tokenA = rA.assignmentToken!;

  // Job A finishes and settles -> slot qa-1 freed
  const sA = pool.settle({ assignmentToken: tokenA, verdict: "pass" });
  assert.equal(sA.ok, true);
  assert.equal(pool.getSlot("qa-1")?.busy, false);

  // Slot qa-1 now reserved for job-B
  pool.enqueue({ scope: "job-B", attempt: 1, specHash: "hB" });
  const rB = pool.reserve();
  assert.equal(rB.ok, true);
  const tokenB = rB.assignmentToken!;
  assert.notEqual(tokenA, tokenB);

  assert.equal(pool.getSlot("qa-1")?.job?.scope, "job-B");
  assert.equal(pool.getSlot("qa-1")?.assignmentToken, tokenB);

  // Late stale settlement for tokenA arrives
  const staleSettle = pool.settle({ assignmentToken: tokenA, verdict: "pass" });
  assert.equal(staleSettle.ok, false);
  assert.equal(staleSettle.stale, true);

  // Verify: slot qa-1 is STILL busy with job-B and tokenB! Not released!
  const slotStillB = pool.getSlot("qa-1");
  assert.equal(slotStillB?.busy, true);
  assert.equal(slotStillB?.job?.scope, "job-B");
  assert.equal(slotStillB?.assignmentToken, tokenB);

  // Late stale failure for tokenA is also rejected
  const staleFail = pool.fail({ assignmentToken: tokenA, reason: "stale fail" });
  assert.equal(staleFail.ok, false);
  assert.equal(staleFail.stale, true);
  assert.equal(pool.getSlot("qa-1")?.busy, true);

  // Legitimate settlement for tokenB succeeds
  const validSettle = pool.settle({ assignmentToken: tokenB, verdict: "pass" });
  assert.equal(validSettle.ok, true);
  assert.equal(validSettle.stale, false);
  assert.equal(pool.getSlot("qa-1")?.busy, false);
});

test("reviewer failure: returns work to queue, increments reviewerFailures, and frees slot", () => {
  const pool = createQaPool({ workerCount: 4 }); // cap = 2

  pool.enqueue({ scope: "unit-crash", attempt: 1, specHash: "hc" });
  const r = pool.reserve();
  assert.equal(r.ok, true);
  assert.equal(r.slot?.slotId, "qa-1");
  assert.equal(pool.getQueueLength(), 0);

  // Reviewer failure
  const failRes = pool.fail({
    assignmentToken: r.assignmentToken!,
    reason: "subagent process died",
    requeueTo: "front",
  });
  assert.equal(failRes.ok, true);
  assert.equal(failRes.freedSlot?.slotId, "qa-1");
  assert.equal(failRes.requeuedJob?.scope, "unit-crash");
  assert.equal(failRes.requeuedJob?.reviewerFailures, 1);

  // Slot freed
  assert.equal(pool.getSlot("qa-1")?.busy, false);

  // Work returned to queue
  assert.equal(pool.getQueueLength(), 1);
  assert.equal(pool.getQueue()[0]?.scope, "unit-crash");
  assert.equal(pool.getJobStatus("unit-crash", 1), "queued");

  // Can be re-reserved immediately
  const r2 = pool.reserve();
  assert.equal(r2.ok, true);
  assert.equal(r2.job?.scope, "unit-crash");
  assert.equal(r2.job?.reviewerFailures, 1);
  assert.notEqual(r.assignmentToken, r2.assignmentToken);
});

test("reverify affinity: reviewer prefers its pinned reverify job ahead of older new jobs", () => {
  const pool = createQaPool({ workerCount: 5 }); // cap = 2: qa-1, qa-2

  // qa-1 reviews unit-1
  pool.enqueue({ scope: "unit-1", attempt: 1, specHash: "h1" });
  const a1 = pool.reserve();
  assert.equal(a1.slot?.slotId, "qa-1");

  // qa-2 reviews unit-2
  pool.enqueue({ scope: "unit-2", attempt: 1, specHash: "h2" });
  const a2 = pool.reserve();
  assert.equal(a2.slot?.slotId, "qa-2");

  // New jobs queued up
  pool.enqueue({ scope: "unit-3", attempt: 1, specHash: "h3" });
  pool.enqueue({ scope: "unit-4", attempt: 1, specHash: "h4" });

  // qa-1 settles review with findings (attempt 1 done)
  pool.settle({ assignmentToken: a1.assignmentToken!, verdict: "fail" });

  // Worker fixes issues -> enqueues attempt 2 with affinity pinned to finding reviewer qa-1
  pool.enqueueReverify({
    scope: "unit-1",
    attempt: 2,
    specHash: "h1",
    pinnedReviewerId: "qa-1",
  });

  // qa-1 is free. Queue has: unit-3 (new), unit-4 (new), unit-1 (reverify pinned to qa-1)
  // qa-1 MUST prefer the reverify job pinned to qa-1 ahead of older new jobs!
  const nextQa1 = pool.reserve();
  assert.equal(nextQa1.ok, true);
  assert.equal(nextQa1.slot?.slotId, "qa-1");
  assert.equal(nextQa1.job?.scope, "unit-1");
  assert.equal(nextQa1.job?.attempt, 2);
  assert.equal(nextQa1.job?.kind, "reverify");
});

test("bounded fairness: prevents starvation of new jobs during a flood of reverify jobs", () => {
  // workerCount 2 -> cap = 1 (slot qa-1). maxConsecutiveReverify = 2
  const pool = createQaPool({ workerCount: 2, maxConsecutiveReverify: 2 });

  // 1 new job waiting
  pool.enqueue({ scope: "new-unit", attempt: 1, specHash: "h-new" });

  // 4 reverify jobs waiting
  pool.enqueueReverify({ scope: "rev-1", attempt: 2, specHash: "h-r1" });
  pool.enqueueReverify({ scope: "rev-2", attempt: 2, specHash: "h-r2" });
  pool.enqueueReverify({ scope: "rev-3", attempt: 2, specHash: "h-r3" });
  pool.enqueueReverify({ scope: "rev-4", attempt: 2, specHash: "h-r4" });

  // 1st reverify scheduled (consecutive = 1)
  const a1 = pool.reserve();
  assert.equal(a1.job?.scope, "rev-1");
  pool.settle({ assignmentToken: a1.assignmentToken!, verdict: "pass" });

  // 2nd reverify scheduled (consecutive = 2)
  const a2 = pool.reserve();
  assert.equal(a2.job?.scope, "rev-2");
  pool.settle({ assignmentToken: a2.assignmentToken!, verdict: "pass" });

  // Consecutive limit reached! Bounded fairness enforces scheduling the waiting NEW job
  const a3 = pool.reserve();
  assert.equal(a3.job?.scope, "new-unit", "new job must not starve under reverify flood");
  assert.equal(a3.job?.kind, "new");
  pool.settle({ assignmentToken: a3.assignmentToken!, verdict: "pass" });

  // After new job runs, consecutive counter is reset -> reverifies can run again
  const a4 = pool.reserve();
  assert.equal(a4.job?.scope, "rev-3");
  assert.equal(a4.job?.kind, "reverify");
});

test("cross-reviewer reverify preference: reviewer prefers new job over job pinned to another reviewer", () => {
  const pool = createQaPool({ workerCount: 5 }); // cap = 2: qa-1, qa-2

  // Reverify job pinned to qa-1, plus a new job
  pool.enqueueReverify({ scope: "unit-rev-for-1", attempt: 2, specHash: "h1", pinnedReviewerId: "qa-1" });
  pool.enqueue({ scope: "unit-new", attempt: 1, specHash: "h-new" });

  // Suppose qa-1 is busy, and qa-2 is free:
  const slotQa1 = pool.getSlot("qa-1")!;
  slotQa1.busy = true;
  slotQa1.assignmentToken = "tok-mock";

  // qa-2 looks for work. Since unit-rev-for-1 is pinned to qa-1, qa-2 takes unit-new,
  // leaving unit-rev-for-1 for qa-1 when qa-1 is free!
  const a2 = pool.reserve();
  assert.equal(a2.slot?.slotId, "qa-2");
  assert.equal(a2.job?.scope, "unit-new");

  // Now qa-1 finishes and frees up:
  slotQa1.busy = false;
  slotQa1.assignmentToken = null;

  // qa-1 takes its pinned job!
  const a1 = pool.reserve();
  assert.equal(a1.slot?.slotId, "qa-1");
  assert.equal(a1.job?.scope, "unit-rev-for-1");
});

test("JSON roundtrip/recovery: preserves state, queue order, active tokens, and recovery options", () => {
  const pool = createQaPool({ workerCount: 5, waveId: "wave-rt-42" });

  pool.enqueue({ scope: "unit-active", attempt: 1, specHash: "h-act" });
  pool.enqueue({ scope: "unit-q1", attempt: 1, specHash: "h-q1" });
  pool.enqueueReverify({ scope: "unit-rev", attempt: 2, specHash: "h-rev", pinnedReviewerId: "qa-2" });

  const r1 = pool.reserve();
  assert.equal(r1.ok, true);
  const activeToken = r1.assignmentToken!;

  // Serialize
  const serialized = pool.serialize();
  assert.equal(typeof serialized, "string");

  // 1. Standard restore (e.g. process reconnection without crash): preserves active slot & token
  const restored = createQaPool(deserializeQaPoolState(serialized));
  assert.equal(restored.capacity, pool.capacity);
  assert.equal(restored.workerCount, pool.workerCount);
  assert.equal(restored.waveId, "wave-rt-42");

  const restoredSlot1 = restored.getSlot("qa-1");
  assert.equal(restoredSlot1?.busy, true);
  assert.equal(restoredSlot1?.assignmentToken, activeToken);
  assert.equal(restoredSlot1?.job?.scope, "unit-active");

  // Active job can settle with existing token
  const sRestored = restored.settle({ assignmentToken: activeToken, verdict: "pass" });
  assert.equal(sRestored.ok, true);
  assert.equal(restored.getSlot("qa-1")?.busy, false);

  // 2. Crash recovery semantics: recoverActiveSlots requeues interrupted jobs and frees slots
  const restoredAfterCrash = createQaPool(deserializeQaPoolState(serialized), {
    recoverActiveSlots: true,
    recoveryReason: "orchestrator crashed",
  });
  // Slot qa-1 was automatically freed and unit-active returned to queue
  assert.equal(restoredAfterCrash.getSlot("qa-1")?.busy, false);
  assert.equal(restoredAfterCrash.getQueueLength(), 3);
  assert.equal(restoredAfterCrash.getQueue()[0]?.scope, "unit-active");
  assert.equal(restoredAfterCrash.getQueue()[0]?.reviewerFailures, 1);
});

test("pure state transition functions operate identically without class wrapper", () => {
  const state = createQaPoolState({ workerCount: 4 });
  assert.equal(state.capacity, 2);

  const enq = enqueueJob(state, { scope: "pure-1", attempt: 1, specHash: "hp" });
  assert.equal(enq.ok, true);
  assert.equal(state.queue.length, 1);

  const res = reserveNextSlot(state);
  assert.equal(res.ok, true);
  assert.equal(state.queue.length, 0);
  assert.equal(state.slots[0]?.busy, true);

  const serialized = serializeQaPoolState(state);
  const reloaded = deserializeQaPoolState(serialized);
  assert.equal(reloaded.slots[0]?.busy, true);
  assert.equal(reloaded.slots[0]?.job?.scope, "pure-1");

  const s = settleJob(reloaded, { assignmentToken: reloaded.slots[0]!.assignmentToken!, verdict: "pass" });
  assert.equal(s.ok, true);
  assert.equal(reloaded.slots[0]?.busy, false);
  assert.equal(reloaded.completed.length, 1);
});
