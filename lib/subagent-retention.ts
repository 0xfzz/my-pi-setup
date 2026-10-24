import { existsSync } from "node:fs";
import { PROGRESS_SUFFIX, type ChildRecord } from "./subagent-state.ts";

/**
 * Retention for seeded child transcripts.
 *
 * A `fork` child's session file is a full copy of the parent's branch, so a long
 * session with many forks accumulates real disk. This module decides which
 * copies are safe to remove — and nothing here ever deletes: collection is an
 * explicit `/subagents gc` the user runs, because a transcript is evidence.
 *
 * What is kept no matter what:
 * - the `.progress-checkpoint.json` sidecar (the milestone summary), and
 * - any child that is not verifiably finished.
 */

/** Copies younger than this are never even offered for collection. */
export const RETENTION_DEFAULT_DAYS = 14;

const DAY_MS = 86_400_000;

export interface RetentionOptions {
  now?: number;
  olderThanDays?: number;
  /** Injected for tests; defaults to a real `existsSync`. */
  exists?: (path: string) => boolean;
}

export interface RetentionCandidate {
  record: ChildRecord;
  ageDays: number;
  /** The transcript that would be removed. */
  sessionFile: string;
  /** The milestone summary that is always retained. */
  checkpointFile: string;
}

/**
 * Whether a record is definitely finished.
 *
 * Deliberately conservative: `unverified` (a child whose completion monitoring
 * was never reattached) is NOT finished. Deleting the transcript of a child that
 * might still be writing would destroy live evidence.
 */
export function isSettled(record: ChildRecord, observed: boolean): boolean {
  if (record.status === "running" || record.status === "blocked") return false;
  return record.ended && observed;
}

/**
 * Fork copies old enough and settled enough to offer for collection.
 *
 * Only `fork` children qualify: a `fresh` or `digest` child's transcript is
 * small and holds no copy of the parent's branch, so collecting it would trade
 * evidence for almost no disk.
 */
export function retentionCandidates(
  records: Iterable<ChildRecord>,
  observed: ReadonlySet<string>,
  options: RetentionOptions = {},
): RetentionCandidate[] {
  const now = options.now ?? Date.now();
  const olderThanDays = Math.max(0, options.olderThanDays ?? RETENTION_DEFAULT_DAYS);
  const exists = options.exists ?? existsSync;
  const cutoff = now - olderThanDays * DAY_MS;

  const candidates: RetentionCandidate[] = [];
  for (const record of records) {
    if (record.context?.mode !== "fork") continue;
    if (!isSettled(record, observed.has(record.sessionFile))) continue;
    const updated = Date.parse(record.updatedAt);
    // An unparsable timestamp is not evidence of age.
    if (!Number.isFinite(updated) || updated > cutoff) continue;
    if (!exists(record.sessionFile)) continue;
    candidates.push({
      record,
      ageDays: Math.floor((now - updated) / DAY_MS),
      sessionFile: record.sessionFile,
      checkpointFile: record.sessionFile + PROGRESS_SUFFIX,
    });
  }
  return candidates.sort((a, b) => a.record.updatedAt.localeCompare(b.record.updatedAt));
}

/** The confirmation text for a collection: exactly what goes, and what stays. */
export function describeRetention(candidates: readonly RetentionCandidate[]): string {
  if (!candidates.length) return "No fork copies are old enough to collect. Nothing deleted.";
  const lines = candidates.map(
    (candidate) =>
      `• ${candidate.record.name} — ${candidate.ageDays}d old — ${candidate.sessionFile}`,
  );
  return [
    `Remove ${candidates.length} fork transcript cop${candidates.length === 1 ? "y" : "ies"}?`,
    "",
    ...lines,
    "",
    "Kept: every .progress-checkpoint.json milestone summary, and every child that is",
    "running, blocked, or not verifiably finished. The parent session is never touched.",
    "This cannot be undone.",
  ].join("\n");
}
