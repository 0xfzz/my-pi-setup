/**
 * qa-pool.ts — Bounded QA reviewer pool domain.
 *
 * Implements a pure, serializable, bounded QA reviewer pool:
 * - Frozen capacity wave: cap = min(3, max(1, floor(workerCount / 2)))
 * - Positive integer wave size with bounded input validation
 * - Worker completion FIFO queue with deduplication by (scope, attempt)
 * - Scope original frozen spec hash attached to every job
 * - Slot reservation: first available free slot taken before spawn
 * - Per-assignment token preventing stale completions/failures from releasing newer jobs
 * - Slot reuse across jobs
 * - Reverify jobs pinned to finding reviewer with affinity
 * - Bounded fairness avoiding starvation of new jobs (maxConsecutiveReverify)
 * - Reviewer failure returns work to queue and frees slot
 * - Explicit crash recovery semantics (recoverActiveSlots / restore options)
 * - Full JSON serialization and recovery roundtrip
 * - Pure functions with zero timers, filesystem, processes, or model calls
 */

import { MAX_ACTIVE_QA } from "./qa-groups.ts";

export const MAX_POOL_CAP = MAX_ACTIVE_QA; // 3
export const MIN_WORKER_COUNT = 1;
export const MAX_WORKER_COUNT = 100;
export const DEFAULT_MAX_CONSECUTIVE_REVERIFY = 2;

export type QaJobKind = "new" | "reverify";
export type QaJobStatus = "queued" | "active" | "completed" | "not-found";

export interface QaPoolJob {
  /** Unique monotonic job ID (e.g. `job-1`) */
  id: string;
  /** Work-unit scope (e.g. "feature-auth") */
  scope: string;
  /** Worker iteration attempt (1, 2, ...) */
  attempt: number;
  /** Scope original frozen specification content hash */
  specHash: string;
  /** Whether this is a new unit review or a reverification after fixes */
  kind: QaJobKind;
  /** Finding reviewer ID if this job is pinned to a specific reviewer */
  pinnedReviewerId?: string;
  /** Monotonic queue sequence order */
  enqueuedSeq: number;
  /** Number of times reviewer failures caused this job to be requeued */
  reviewerFailures?: number;
}

export interface QaSlotState {
  /** Slot ID, e.g. "qa-1", "qa-2", "qa-3" */
  slotId: string;
  /** Reviewer identity bound to this slot */
  reviewerId: string;
  /** Whether the slot is currently occupied by an active review */
  busy: boolean;
  /** Unique assignment token for the active job, or null if idle */
  assignmentToken: string | null;
  /** Active job assigned to this slot, or null if idle */
  job: QaPoolJob | null;
  /** Sequence at which assignment occurred */
  assignedSeq: number | null;
}

export interface SettleJobRecord {
  job: QaPoolJob;
  assignmentToken: string;
  reviewerId: string;
  settledSeq: number;
  verdict?: "pass" | "fail" | "blocked" | string;
  findings?: unknown[];
  result?: unknown;
}

export interface QaPoolState {
  version: 1;
  waveId: string;
  workerCount: number;
  /** Frozen reviewer concurrency cap: min(3, max(1, floor(workerCount / 2))) */
  capacity: number;
  maxConsecutiveReverify: number;
  consecutiveReverifies: number;
  nextSeq: number;
  slots: QaSlotState[];
  queue: QaPoolJob[];
  completed: SettleJobRecord[];
}

export interface CreateQaPoolOptions {
  workerCount: number;
  waveId?: string;
  maxConsecutiveReverify?: number;
}

export interface EnqueueJobInput {
  scope: string;
  attempt?: number;
  specHash: string;
  kind?: QaJobKind;
  pinnedReviewerId?: string;
}

export interface EnqueueResult {
  ok: boolean;
  enqueued: boolean;
  job?: QaPoolJob;
  reason?: string;
  duplicateOf?: "queue" | "active" | "completed";
}

export interface AssignmentResult {
  ok: boolean;
  slot?: QaSlotState;
  job?: QaPoolJob;
  assignmentToken?: string;
  reason?: string;
}

export interface SettleJobInput {
  assignmentToken: string;
  slotId?: string;
  verdict?: "pass" | "fail" | "blocked" | string;
  findings?: unknown[];
  result?: unknown;
}

export interface SettleJobResult {
  ok: boolean;
  stale: boolean;
  freedSlot?: QaSlotState;
  completedJob?: QaPoolJob;
  reason?: string;
}

export interface FailJobInput {
  assignmentToken: string;
  slotId?: string;
  reason?: string;
  requeueTo?: "front" | "back";
}

export interface FailJobResult {
  ok: boolean;
  stale: boolean;
  freedSlot?: QaSlotState;
  requeuedJob?: QaPoolJob;
  reason?: string;
}

export interface RecoverActiveSlotsOptions {
  reason?: string;
  slotIds?: string[];
}

export interface RecoverActiveSlotsResult {
  requeuedJobs: QaPoolJob[];
  freedSlots: QaSlotState[];
}

/**
 * Compute the frozen reviewer capacity cap for a wave of workers.
 * Formula: min(3, max(1, floor(workerCount / 2)))
 * Validates bounded positive integer input [1..MAX_WORKER_COUNT].
 */
export function computeQaPoolCap(workerCount: number): number {
  if (typeof workerCount !== "number" || !Number.isInteger(workerCount) || workerCount < MIN_WORKER_COUNT) {
    throw new Error(`workerCount must be a positive integer >= ${MIN_WORKER_COUNT}, got ${workerCount}`);
  }
  if (workerCount > MAX_WORKER_COUNT) {
    throw new Error(`workerCount exceeds maximum supported wave size of ${MAX_WORKER_COUNT}, got ${workerCount}`);
  }
  return Math.min(MAX_POOL_CAP, Math.max(1, Math.floor(workerCount / 2)));
}

/**
 * Initialize a fresh, empty QA pool state with a frozen capacity cap.
 */
export function createQaPoolState(options: CreateQaPoolOptions): QaPoolState {
  const capacity = computeQaPoolCap(options.workerCount);
  const slots: QaSlotState[] = Array.from({ length: capacity }, (_, i) => ({
    slotId: `qa-${i + 1}`,
    reviewerId: `qa-${i + 1}`,
    busy: false,
    assignmentToken: null,
    job: null,
    assignedSeq: null,
  }));

  const maxConsecutive = options.maxConsecutiveReverify ?? DEFAULT_MAX_CONSECUTIVE_REVERIFY;
  if (!Number.isInteger(maxConsecutive) || maxConsecutive < 1) {
    throw new Error(`maxConsecutiveReverify must be a positive integer, got ${maxConsecutive}`);
  }

  return {
    version: 1,
    waveId: options.waveId ?? `wave-${Date.now().toString(36)}`,
    workerCount: options.workerCount,
    capacity,
    maxConsecutiveReverify: maxConsecutive,
    consecutiveReverifies: 0,
    nextSeq: 1,
    slots,
    queue: [],
    completed: [],
  };
}

/**
 * Enqueue a worker completion into the FIFO review queue.
 * Deduplicates by (scope, attempt) across queue, active slots, and completed history.
 * Requires original frozen specHash.
 */
export function enqueueJob(state: QaPoolState, input: EnqueueJobInput): EnqueueResult {
  const scope = String(input.scope ?? "").trim();
  if (!scope) {
    return { ok: false, enqueued: false, reason: "missing-scope" };
  }

  const specHash = String(input.specHash ?? "").trim();
  if (!specHash) {
    return { ok: false, enqueued: false, reason: "missing-spec-hash" };
  }

  const attempt = Number.isInteger(input.attempt) && (input.attempt as number) > 0 ? (input.attempt as number) : 1;
  const kind: QaJobKind = input.kind === "reverify" ? "reverify" : "new";
  const pinnedReviewerId = typeof input.pinnedReviewerId === "string" && input.pinnedReviewerId.trim()
    ? input.pinnedReviewerId.trim()
    : undefined;

  // Dedup 1: In queue
  const inQueue = state.queue.some((j) => j.scope === scope && j.attempt === attempt);
  if (inQueue) {
    return {
      ok: false,
      enqueued: false,
      reason: `duplicate job for scope "${scope}" attempt ${attempt} already in queue`,
      duplicateOf: "queue",
    };
  }

  // Dedup 2: In active slots
  const inActive = state.slots.some((s) => s.busy && s.job && s.job.scope === scope && s.job.attempt === attempt);
  if (inActive) {
    return {
      ok: false,
      enqueued: false,
      reason: `duplicate job for scope "${scope}" attempt ${attempt} currently active in a reviewer slot`,
      duplicateOf: "active",
    };
  }

  // Dedup 3: In completed history
  const inCompleted = state.completed.some((c) => c.job.scope === scope && c.job.attempt === attempt);
  if (inCompleted) {
    return {
      ok: false,
      enqueued: false,
      reason: `duplicate job for scope "${scope}" attempt ${attempt} already completed`,
      duplicateOf: "completed",
    };
  }

  const job: QaPoolJob = {
    id: `job-${state.nextSeq++}`,
    scope,
    attempt,
    specHash,
    kind,
    ...(pinnedReviewerId ? { pinnedReviewerId } : {}),
    enqueuedSeq: state.nextSeq++,
    reviewerFailures: 0,
  };

  state.queue.push(job);
  return { ok: true, enqueued: true, job };
}

/**
 * Select the best matching job from the queue for a given free slot.
 *
 * Scheduling rules:
 * 1. Bounded fairness: if consecutiveReverifies >= maxConsecutiveReverify and a "new" job is waiting,
 *    assign the oldest "new" job to prevent starvation of new jobs.
 * 2. Reverify affinity:
 *    - Reverify job pinned to this slot's reviewerId is top priority (affinity).
 *    - Unpinned reverify jobs next.
 *    - If reverify is pinned to another reviewer:
 *      * If new jobs exist, prefer new job so the pinned reviewer can take their own job when free.
 *      * If NO new jobs exist, take the reverify job so the slot does not sit idle.
 * 3. Default to oldest "new" job (FIFO).
 */
function selectJobForSlot(state: QaPoolState, slot: QaSlotState): { job: QaPoolJob; index: number } | undefined {
  if (state.queue.length === 0) return undefined;

  const hasNewJobs = state.queue.some((j) => j.kind === "new");

  // Rule 1: Bounded fairness check
  if (state.consecutiveReverifies >= state.maxConsecutiveReverify && hasNewJobs) {
    const newIdx = state.queue.findIndex((j) => j.kind === "new");
    if (newIdx !== -1) {
      return { job: state.queue[newIdx]!, index: newIdx };
    }
  }

  // Rule 2: Reverify jobs with affinity
  // 2a. Pinned directly to this reviewer
  const pinnedIdx = state.queue.findIndex((j) => j.kind === "reverify" && j.pinnedReviewerId === slot.reviewerId);
  if (pinnedIdx !== -1) {
    return { job: state.queue[pinnedIdx]!, index: pinnedIdx };
  }

  // 2b. Unpinned reverify jobs
  const unpinnedReverifyIdx = state.queue.findIndex((j) => j.kind === "reverify" && !j.pinnedReviewerId);
  if (unpinnedReverifyIdx !== -1) {
    return { job: state.queue[unpinnedReverifyIdx]!, index: unpinnedReverifyIdx };
  }

  // 2c. Reverify jobs pinned to another reviewer:
  // If no new jobs exist, take it so neither the slot nor the reverify job idles.
  if (!hasNewJobs) {
    const anyReverifyIdx = state.queue.findIndex((j) => j.kind === "reverify");
    if (anyReverifyIdx !== -1) {
      return { job: state.queue[anyReverifyIdx]!, index: anyReverifyIdx };
    }
  }

  // Rule 3: Oldest "new" job (FIFO)
  const newIdx = state.queue.findIndex((j) => j.kind === "new");
  if (newIdx !== -1) {
    return { job: state.queue[newIdx]!, index: newIdx };
  }

  // Fallback: pick the first job in queue
  return { job: state.queue[0]!, index: 0 };
}

/**
 * Reserve the first available free slot before launching a reviewer child.
 * Generates a unique per-assignment token.
 */
export function reserveNextSlot(state: QaPoolState): AssignmentResult {
  const freeSlot = state.slots.find((s) => !s.busy);
  if (!freeSlot) {
    return { ok: false, reason: "no-free-slots" };
  }

  const selection = selectJobForSlot(state, freeSlot);
  if (!selection) {
    return { ok: false, reason: "queue-empty" };
  }

  const { job, index } = selection;
  state.queue.splice(index, 1);

  // Mint unique per-assignment token
  const tokenSeq = state.nextSeq++;
  const assignmentToken = `assign-${freeSlot.slotId}-${job.scope}-a${job.attempt}-${tokenSeq}`;

  freeSlot.busy = true;
  freeSlot.assignmentToken = assignmentToken;
  freeSlot.job = job;
  freeSlot.assignedSeq = state.nextSeq++;

  // Update fairness counter
  if (job.kind === "reverify") {
    state.consecutiveReverifies += 1;
  } else {
    state.consecutiveReverifies = 0;
  }

  return {
    ok: true,
    slot: freeSlot,
    job,
    assignmentToken,
  };
}

/**
 * Greedily reserve all available free slots until slots or eligible jobs are exhausted.
 */
export function assignAvailableSlots(state: QaPoolState): {
  assignments: Array<{ slot: QaSlotState; job: QaPoolJob; assignmentToken: string }>;
} {
  const assignments: Array<{ slot: QaSlotState; job: QaPoolJob; assignmentToken: string }> = [];

  while (true) {
    const res = reserveNextSlot(state);
    if (!res.ok || !res.slot || !res.job || !res.assignmentToken) {
      break;
    }
    assignments.push({
      slot: res.slot,
      job: res.job,
      assignmentToken: res.assignmentToken,
    });
  }

  return { assignments };
}

/**
 * Settle (complete) an active job using its assignment token.
 * Guarded against stale events: if the token does not match the active assignment in the slot,
 * the request is rejected with stale: true and NO slot state is mutated.
 */
export function settleJob(state: QaPoolState, input: SettleJobInput): SettleJobResult {
  const token = String(input.assignmentToken ?? "").trim();
  if (!token) {
    return { ok: false, stale: false, reason: "missing-assignment-token" };
  }

  // Find slot currently holding this token
  const slot = state.slots.find((s) => s.busy && s.assignmentToken === token);
  if (!slot) {
    return {
      ok: false,
      stale: true,
      reason: `stale or invalid assignment token "${token}": no active slot matches`,
    };
  }

  if (input.slotId && slot.slotId !== input.slotId) {
    return {
      ok: false,
      stale: true,
      reason: `assignment token matches slot "${slot.slotId}", but expected "${input.slotId}"`,
    };
  }

  const completedJob = slot.job!;
  state.completed.push({
    job: completedJob,
    assignmentToken: token,
    reviewerId: slot.reviewerId,
    settledSeq: state.nextSeq++,
    verdict: input.verdict,
    findings: input.findings,
    result: input.result,
  });

  // Slot reuse: release slot back to idle
  slot.busy = false;
  slot.assignmentToken = null;
  slot.job = null;
  slot.assignedSeq = null;

  return {
    ok: true,
    stale: false,
    freedSlot: slot,
    completedJob,
  };
}

/** Alias completeJob to settleJob for API compatibility */
export const completeJob = settleJob;

/**
 * Handle a reviewer failure: requeue the job and release the slot.
 * Guarded against stale events via assignmentToken.
 */
export function failJob(state: QaPoolState, input: FailJobInput): FailJobResult {
  const token = String(input.assignmentToken ?? "").trim();
  if (!token) {
    return { ok: false, stale: false, reason: "missing-assignment-token" };
  }

  const slot = state.slots.find((s) => s.busy && s.assignmentToken === token);
  if (!slot) {
    return {
      ok: false,
      stale: true,
      reason: `stale or invalid assignment token "${token}": no active slot matches`,
    };
  }

  if (input.slotId && slot.slotId !== input.slotId) {
    return {
      ok: false,
      stale: true,
      reason: `assignment token matches slot "${slot.slotId}", but expected "${input.slotId}"`,
    };
  }

  const failedJob = slot.job!;
  failedJob.reviewerFailures = (failedJob.reviewerFailures ?? 0) + 1;

  // Requeue job: front (default) so retry is prioritized, or back
  if (input.requeueTo === "back") {
    state.queue.push(failedJob);
  } else {
    state.queue.unshift(failedJob);
  }

  // Release slot
  slot.busy = false;
  slot.assignmentToken = null;
  slot.job = null;
  slot.assignedSeq = null;

  return {
    ok: true,
    stale: false,
    freedSlot: slot,
    requeuedJob: failedJob,
  };
}

/**
 * Explicit crash recovery semantics:
 * When the orchestrator recovers from an unclean shutdown, in-flight reviewer slots
 * that were interrupted can be reclaimed: their jobs are safely requeued to the front
 * of the queue and the slots freed for fresh assignment.
 */
export function recoverActiveSlots(state: QaPoolState, options: RecoverActiveSlotsOptions = {}): RecoverActiveSlotsResult {
  const requeuedJobs: QaPoolJob[] = [];
  const freedSlots: QaSlotState[] = [];

  for (const slot of state.slots) {
    if (!slot.busy || !slot.job) continue;
    if (options.slotIds && !options.slotIds.includes(slot.slotId)) continue;

    const job = slot.job;
    job.reviewerFailures = (job.reviewerFailures ?? 0) + 1;
    state.queue.unshift(job);
    requeuedJobs.push(job);

    slot.busy = false;
    slot.assignmentToken = null;
    slot.job = null;
    slot.assignedSeq = null;
    freedSlots.push(slot);
  }

  return { requeuedJobs, freedSlots };
}

/**
 * Serialize QA pool state to JSON string.
 */
export function serializeQaPoolState(state: QaPoolState): string {
  return JSON.stringify(state);
}

/**
 * Deserialize and validate a QA pool state from a JSON string or state object.
 */
export function deserializeQaPoolState(raw: string | unknown): QaPoolState {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid QA pool state: must be an object");
  }

  const state = parsed as Partial<QaPoolState>;
  if (state.version !== 1) {
    throw new Error(`Unsupported QA pool version: ${state.version}`);
  }
  if (!Number.isInteger(state.workerCount) || (state.workerCount as number) < 1) {
    throw new Error("Invalid workerCount in QA pool state");
  }
  if (!Number.isInteger(state.capacity) || (state.capacity as number) < 1 || (state.capacity as number) > MAX_POOL_CAP) {
    throw new Error("Invalid capacity in QA pool state");
  }
  if (!Array.isArray(state.slots)) {
    throw new Error("Invalid slots array in QA pool state");
  }
  if (!Array.isArray(state.queue)) {
    throw new Error("Invalid queue array in QA pool state");
  }
  if (!Array.isArray(state.completed)) {
    throw new Error("Invalid completed array in QA pool state");
  }

  // Structured deep clone
  return JSON.parse(JSON.stringify(state)) as QaPoolState;
}

export interface RestoreQaPoolOptions {
  recoverActiveSlots?: boolean;
  recoveryReason?: string;
}

/**
 * High-level factory wrapper providing a usable object API over the pure functions.
 */
export class QaPool {
  private state: QaPoolState;

  constructor(optionsOrState: CreateQaPoolOptions | QaPoolState, restoreOptions?: RestoreQaPoolOptions) {
    if ("version" in optionsOrState && optionsOrState.version === 1) {
      this.state = deserializeQaPoolState(optionsOrState);
      if (restoreOptions?.recoverActiveSlots) {
        recoverActiveSlots(this.state, { reason: restoreOptions.recoveryReason });
      }
    } else {
      this.state = createQaPoolState(optionsOrState as CreateQaPoolOptions);
    }
  }

  get capacity(): number {
    return this.state.capacity;
  }

  get workerCount(): number {
    return this.state.workerCount;
  }

  get waveId(): string {
    return this.state.waveId;
  }

  enqueue(input: EnqueueJobInput): EnqueueResult {
    return enqueueJob(this.state, input);
  }

  enqueueReverify(input: Omit<EnqueueJobInput, "kind"> & { pinnedReviewerId?: string }): EnqueueResult {
    return enqueueJob(this.state, { ...input, kind: "reverify" });
  }

  reserveNextSlot(): AssignmentResult {
    return reserveNextSlot(this.state);
  }

  reserve(): AssignmentResult {
    return this.reserveNextSlot();
  }

  assignAvailableSlots(): Array<{ slot: QaSlotState; job: QaPoolJob; assignmentToken: string }> {
    return assignAvailableSlots(this.state).assignments;
  }

  settle(input: SettleJobInput): SettleJobResult {
    return settleJob(this.state, input);
  }

  completeJob(input: SettleJobInput): SettleJobResult {
    return this.settle(input);
  }

  fail(input: FailJobInput): FailJobResult {
    return failJob(this.state, input);
  }

  failJob(input: FailJobInput): FailJobResult {
    return this.fail(input);
  }

  recoverActiveSlots(options?: RecoverActiveSlotsOptions): RecoverActiveSlotsResult {
    return recoverActiveSlots(this.state, options);
  }

  getJobStatus(scope: string, attempt: number): QaJobStatus {
    if (this.state.queue.some((j) => j.scope === scope && j.attempt === attempt)) {
      return "queued";
    }
    if (this.state.slots.some((s) => s.busy && s.job && s.job.scope === scope && s.job.attempt === attempt)) {
      return "active";
    }
    if (this.state.completed.some((c) => c.job.scope === scope && c.job.attempt === attempt)) {
      return "completed";
    }
    return "not-found";
  }

  getState(): QaPoolState {
    return JSON.parse(JSON.stringify(this.state)) as QaPoolState;
  }

  toJSON(): QaPoolState {
    return this.getState();
  }

  serialize(): string {
    return serializeQaPoolState(this.state);
  }

  getSlots(): readonly QaSlotState[] {
    return this.state.slots;
  }

  getSlot(slotId: string): QaSlotState | undefined {
    return this.state.slots.find((s) => s.slotId === slotId);
  }

  getQueue(): readonly QaPoolJob[] {
    return this.state.queue;
  }

  getCompleted(): readonly SettleJobRecord[] {
    return this.state.completed;
  }

  getActiveCount(): number {
    return this.state.slots.filter((s) => s.busy).length;
  }

  getQueueLength(): number {
    return this.state.queue.length;
  }

  isIdle(): boolean {
    return this.getActiveCount() === 0 && this.state.queue.length === 0;
  }

  isFull(): boolean {
    return this.getActiveCount() >= this.capacity;
  }

  hasPendingWork(): boolean {
    return this.state.queue.length > 0 || this.getActiveCount() > 0;
  }
}

/**
 * Usable factory entrypoint.
 */
export function createQaPool(
  optionsOrState: CreateQaPoolOptions | QaPoolState,
  restoreOptions?: RestoreQaPoolOptions,
): QaPool {
  return new QaPool(optionsOrState, restoreOptions);
}
