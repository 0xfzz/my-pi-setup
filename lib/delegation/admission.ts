/**
 * admission.ts — need-based spawn admission and its reservation ledger.
 *
 * Enforces TWO user-ownable ceilings on delegation, both per owner session and
 * per work batch:
 *
 *   1. Concurrency: one occupied slot covers RUNNing, BLOCKed, and a terminal
 *      child whose result still awaits parent review or requested changes.
 *      Closing a pane does not release the slot — a disposition does (scope-
 *      registry.recordDisposition). This keeps a parent from reviewing work it
 *      already forgot while spawning five new children.
 *   2. Cumulative launches per batch: completion no longer frees capacity for
 *      unbounded sequential spawning. A change-requested row keeps its slot
 *      until settled, so rework is steered through the SAME child instead of a
 *      fresh spawn.
 *
 * Defaults are deliberately conservative starting values, not proven constants.
 * An explicitly configured ceiling (the legacy `maxDelegates` from /agent max,
 * `maxConcurrentDelegations`, or PI_SUBAGENT_MAX_CHILDREN) is honoured: the
 * effective concurrent cap is the strictest explicitly-configured value, and
 * the default applies only where nothing is configured. A refusal names its
 * governing cap and the user-owned escape hatch (/agent batch) — a model can
 * recommend raising it, never apply it silently.
 *
 * Reservations are the atomicity seam. Tool calls from one assistant message
 * run in parallel, but JS is single threaded: muting the ledger SYNCHRONOUSLY,
 * before the first await, serialises racing spawn calls. The second call sees
 * the first's reservation and is refused instead of both passing the same
 * last-slot check. A reservation is released when its launch fails; once the
 * row is registered the REGISTRY owns the count, and the ledger entry drops.
 *
 * What admission can enforce: presence of the reason, duplicate work units,
 * ceilings. What it cannot: whether the natural-language reason is genuinely
 * useful. Presence is the gate; quality stays the parent's judgement.
 */

/** Sanity cap on the cumulative per-batch budget a user may configure. */
export const MAX_LAUNCHES_PER_BATCH_LIMIT = 50;

/**
 * How many times ONE work unit may be re-spawned against its frozen handoff.
 *
 * A rework exists because a child missed the handoff. Two rounds is enough to
 * tell "the child got it wrong" from "the handoff, the lane or the goal is
 * wrong" -- and the second is a decision for the user, not for a third launch.
 */
export const MAX_REWORK_ROUNDS = 2;

export interface SpawnBudgets {
  concurrent: number;
  launchesPerBatch: number;
}

/** Defaults: 2 running slots, 4 new launches per user-resettable batch. */
export const DEFAULT_CONCURRENT_DELEGATIONS = 2;
export const DEFAULT_LAUNCHES_PER_BATCH = 4;

type Env = Readonly<Record<string, string | undefined>>;

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "number"
    ? value
    : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Effective ceilings. Explicit user/operator configuration wins over the
 * defaults (strictest configured value); the defaults only fill the unmapped
 * slots, so a migrated setup keeps the ceiling its owner chose.
 */
export function resolveBudgets(
  settings: {
    maxConcurrentDelegations?: unknown;
    maxLaunchesPerBatch?: unknown;
    maxDelegates?: unknown;
  },
  env: Env = process.env,
): SpawnBudgets {
  const concurrentSources: number[] = [];
  for (const source of [settings.maxConcurrentDelegations, settings.maxDelegates, env.PI_SUBAGENT_MAX_CHILDREN]) {
    const parsed = positiveInt(source);
    if (parsed !== undefined) concurrentSources.push(parsed);
  }
  const launches = positiveInt(settings.maxLaunchesPerBatch);
  return {
    concurrent: concurrentSources.length
      ? Math.min(...concurrentSources)
      : DEFAULT_CONCURRENT_DELEGATIONS,
    launchesPerBatch: launches
      ? Math.min(launches, MAX_LAUNCHES_PER_BATCH_LIMIT)
      : DEFAULT_LAUNCHES_PER_BATCH,
  };
}

export interface AdmissionInput {
  /** Registry rows already occupying a slot for this owner (see occupancy). */
  occupied: number;
  /** Reservations outstanding for this owner, INCLUDING the caller's own. */
  reserved: number;
  /** Successful launches recorded against the caller's current batch. */
  launchesInBatch: number;
  workUnitKey: string;
  delegationReason: string;
  /** Work-unit keys already occupied by this owner, for duplicate detection. */
  occupiedKeys: readonly string[];
  budgets: SpawnBudgets;
}

/** The refusal text, or undefined when the spawn is admitted. */
export function admissionProblem(input: AdmissionInput): string | undefined {
  if (!input.delegationReason.trim()) {
    return "Refused: delegationReason is required. State the concrete benefit of a separate agent "
      + "(independent parallel lane, bounded substantial research, specialised context). "
      + "Small, tightly coupled, quick or coordination-heavy work belongs in this session.";
  }
  if (input.occupiedKeys.includes(input.workUnitKey)) {
    return `Refused: work unit "${input.workUnitKey}" already occupies a slot. Steer or resume that child `
      + "(agent_steer / agent_resume), settle its result first, or pass `replaces` with the child id "
      + "and why reuse is unsuitable.";
  }
  // A reservation IS the caller's own in-flight claim, so the gate is strictly
  // greater: 1 occupied + 1 reserved admits at a cap of 2, while two parallel
  // calls at 0 occupied see reserved 2 and the second is refused.
  const occupied = input.occupied + input.reserved;
  if (occupied > input.budgets.concurrent) {
    const pendingNote = input.reserved > 0 ? ` (${input.reserved} being launched right now)` : "";
    return `Refused: the delegation concurrency cap is reached — ${occupied} occupied slot(s)`
      + `${pendingNote}, cap ${input.budgets.concurrent}. A slot frees only when a child's result is `
      + "accepted, abandoned or resumed, not when its pane closes. Settle pending results, or ask the "
      + "user to raise the configured ceiling.";
  }
  // In-flight reservations hold budget too, so parallel calls cannot overshoot
  // the cumulative limit when both launch after passing the same read.
  if (input.launchesInBatch + input.reserved > input.budgets.launchesPerBatch) {
    return `Refused: the launch budget for this batch is exhausted (${input.launchesInBatch}`
      + `/${input.budgets.launchesPerBatch}). Finish and integrate existing results, or the user can `
      + "reset the batch explicitly with /agent batch. A model must not raise or reset it silently.";
  }
  return undefined;
}

const pendingReservations = new Map<string, number>();

/**
 * Reserve one launch slot synchronously, before any await, per owner session.
 * Returns the owner's outstanding total including this reservation.
 */
export function reserveLaunchSlot(ownerSessionId: string): number {
  const next = (pendingReservations.get(ownerSessionId) ?? 0) + 1;
  pendingReservations.set(ownerSessionId, next);
  return next;
}

/** Release a reservation whose launch did not happen. */
export function releaseLaunchSlot(ownerSessionId: string): void {
  const current = pendingReservations.get(ownerSessionId) ?? 0;
  if (current <= 1) pendingReservations.delete(ownerSessionId);
  else pendingReservations.set(ownerSessionId, current - 1);
}

/** Outstanding reservations for one owner; the registry, not this ledger, owns launched rows. */
export function outstandingLaunchSlots(ownerSessionId: string): number {
  return pendingReservations.get(ownerSessionId) ?? 0;
}

/** Test seam only: the ledger lives in this process and dies with it. */
export function resetLaunchReservations(): void {
  pendingReservations.clear();
}
