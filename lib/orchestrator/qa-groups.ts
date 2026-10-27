/**
 * qa-groups.ts — how many children may run, and how QA work is split.
 *
 * Two independent limits keep a wave reviewable rather than a queue:
 *
 * - at most 5 workers run at once, because a parent that spawns ten reviews none
 *   of them properly;
 * - at most 3 QA reviewers, each judging at most 3 units, because a single QA
 *   over a large batch degrades into a skim.
 *
 * The partition is balanced, with the remainder on the later groups: five units
 * become 2 + 3, which is the shape the user asked for. Labels are `qa-1…qa-K`,
 * one per reviewer, so `orch_review` and the dashboard name the same thing the
 * parent sees.
 *
 * Pure: no I/O and no pi imports, so the arithmetic that decides how many panes
 * open is testable without launching anything.
 */

export const MAX_ACTIVE_WORKERS = 5;
export const MAX_ACTIVE_QA = 3;
/** Beyond three units a review stops being a review and becomes a skim. */
export const MAX_UNITS_PER_QA = 3;

export interface QaGroup {
  /** `qa-1` … `qa-K`; also the child scope unless it collides. */
  label: string;
  scopes: string[];
}

export type QaPlan = { ok: true; groups: QaGroup[] } | { ok: false; problems: string[] };

/** The smallest reviewer count that keeps every group within the per-reviewer cap. */
export function qaGroupCount(unitCount: number): number {
  if (unitCount <= 0) return 0;
  return Math.min(MAX_ACTIVE_QA, Math.ceil(unitCount / MAX_UNITS_PER_QA));
}

/**
 * Partition completed work units across QA reviewers.
 *
 * `reviewers` is an optional floor-raising hint, not a way to exceed either cap:
 * asking for fewer than the units require is refused rather than silently
 * producing an oversized group.
 */
export function planQaGroups(scopes: readonly string[], options: { reviewers?: number } = {}): QaPlan {
  const cleaned = scopes.map((scope) => String(scope ?? "").trim()).filter(Boolean);
  const problems: string[] = [];

  if (!cleaned.length) problems.push("give at least one completed work-unit scope");
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const scope of cleaned) {
    if (seen.has(scope)) duplicates.add(scope);
    seen.add(scope);
  }
  if (duplicates.size) problems.push(`listed twice: ${[...duplicates].join(", ")}`);
  if (cleaned.length > MAX_ACTIVE_QA * MAX_UNITS_PER_QA) {
    problems.push(
      `at most ${MAX_ACTIVE_QA * MAX_UNITS_PER_QA} units per batch (got ${cleaned.length}); split the wave or raise the cap deliberately`,
    );
  }
  if (problems.length) return { ok: false, problems };

  const minimum = qaGroupCount(cleaned.length);
  let count = minimum;
  if (options.reviewers != null) {
    if (!Number.isFinite(options.reviewers) || !Number.isInteger(options.reviewers)) {
      return { ok: false, problems: ["reviewers must be a whole number"] };
    }
    if (options.reviewers < minimum) {
      return {
        ok: false,
        problems: [
          `${cleaned.length} units need at least ${minimum} reviewer(s) at ${MAX_UNITS_PER_QA} units each`,
        ],
      };
    }
    if (options.reviewers > MAX_ACTIVE_QA) {
      return { ok: false, problems: [`the cap is ${MAX_ACTIVE_QA} QA reviewers`] };
    }
    count = options.reviewers;
  }

  const base = Math.floor(cleaned.length / count);
  const remainder = cleaned.length % count;
  const groups: QaGroup[] = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    // Remainder goes to the later groups, so 5 units split as 2 + 3.
    const size = base + (index >= count - remainder ? 1 : 0);
    groups.push({ label: `qa-${index + 1}`, scopes: cleaned.slice(cursor, cursor + size) });
    cursor += size;
  }
  return { ok: true, groups };
}

/** Refusal text when another worker would exceed the concurrency cap. */
export function workerLimitRefusal(runningScopes: readonly string[]): string | undefined {
  if (runningScopes.length < MAX_ACTIVE_WORKERS) return undefined;
  return (
    `Refused: ${runningScopes.length} workers are already running (${runningScopes.join(", ")}). `
    + `The cap is ${MAX_ACTIVE_WORKERS} concurrent workers, so a wave stays reviewable. `
    + `Wait for a completion trigger, review that result, then spawn the next unit.`
  );
}

/** Refusal text when more QA reviewers would exceed their cap. */
export function qaLimitRefusal(runningScopes: readonly string[], incoming = 1): string | undefined {
  if (runningScopes.length + incoming <= MAX_ACTIVE_QA) return undefined;
  const running = runningScopes.length ? runningScopes.join(", ") : "none";
  return (
    `Refused: ${runningScopes.length} QA reviewer(s) are already running (${running}), and this adds ${incoming}. `
    + `The cap is ${MAX_ACTIVE_QA}. Collect the running verdicts with orch_review before spawning more.`
  );
}
