/**
 * Which completed work units may get a QA reviewer right now.
 *
 * The cap is derived from the wave, not configured: `clamp(floor(workers/2),1,3)`
 * (five workers => two reviewers). It is computed once from the wave size, so a
 * later completion cannot silently widen it — the churn that made reviewer counts
 * drift mid-wave.
 *
 * This is advice, not authority: it decides ordering and the cap, and the parent
 * still spawns through the ordinary `agent_spawn` gates (which enforce lane, caps
 * and military bookkeeping). Keeping it pure means the scheduling rules can be
 * asserted without a pane, a timer or a reviewer child.
 */
import { computeQaPoolCap, MAX_POOL_CAP } from "./qa-pool.ts";

export interface QaSchedulingInput {
  /** Work units in the wave, frozen at spawn time. */
  workerCount: number;
  /** Scopes of work units that completed; order is completion order. */
  completedScopes: readonly string[];
  /** Scopes that already carry a QA verdict, so they are not queued again. */
  reviewedScopes?: readonly string[];
  /** Reviewer children currently occupying a QA slot. */
  runningQaScopes?: readonly string[];
}

export interface QaSchedulingAdvice {
  cap: number;
  active: number;
  freeSlots: number;
  /** Waiting scopes, oldest completion first. */
  queue: string[];
  /** Scopes the parent should spawn QA for now. */
  spawnNow: string[];
  /** Scopes that must wait for a free slot. */
  deferred: string[];
  reason: string;
}

/**
 * Pure. No clock, no registry, no panes: the caller supplies what it observed.
 *
 * A duplicate completion (a resumed worker finishing twice) is queued once, and a
 * scope already under QA is not queued again — both were ways to burn a slot on
 * work that was already being judged.
 */
export function qaSchedulingAdvice(input: QaSchedulingInput): QaSchedulingAdvice {
  const workerCount = Math.max(1, Math.floor(Number.isFinite(input.workerCount) ? input.workerCount : 1));
  const cap = computeQaPoolCap(workerCount);
  const reviewed = new Set(input.reviewedScopes ?? []);
  const activeScopes = [...new Set(input.runningQaScopes ?? [])].filter(Boolean);
  const active = Math.min(cap, activeScopes.length);

  const queue: string[] = [];
  for (const scope of input.completedScopes) {
    if (!scope || reviewed.has(scope) || activeScopes.includes(scope) || queue.includes(scope)) continue;
    queue.push(scope);
  }

  const freeSlots = Math.max(0, cap - active);
  const spawnNow = queue.slice(0, freeSlots);
  const deferred = queue.slice(freeSlots);
  const reason = spawnNow.length
    ? `spawn QA for ${spawnNow.join(", ")} now`
    : deferred.length
      ? `wait: all ${cap} QA slot(s) busy`
      : "nothing to review";

  return { cap: Math.min(cap, MAX_POOL_CAP), active, freeSlots, queue, spawnNow, deferred, reason };
}
