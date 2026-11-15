// Why a request went where it did.
//
// The router makes exactly one decision per request and then hides it: a
// fallback, a cooling target, a cache-aware non-switch and a pool rotation all
// look identical in the transcript. A short bounded record makes them
// answerable, which is also the only way a cache-driven decision can be checked
// without re-running the session.
//
// Pure: the caller supplies the clock.

import { duration } from "./cache-routing.ts";

export type RouteReason = "user" | "continuation" | "retry" | "direct";

/** One request's decision, kept only in memory. */
export type DecisionRecord = {
  at: number;
  /** Route name, without the provider prefix. */
  route: string;
  reason: RouteReason;
  /** The target that answered, or the empty string when nothing resolved. */
  chosen: string;
  /** The ordered candidate chain, so a fallback is visible as a move. */
  chain: readonly string[];
  /** The cache fact that drove the decision, when one did. */
  cache?: string;
  /** Candidates that could not serve, with the reason. */
  rejected: readonly { target: string; why: string }[];
  /** The reason no target was chosen at all. */
  error?: string;
};

/** How many decisions `/router why` keeps. */
export const MAX_DECISIONS = 32;

/** A reason long enough to be useful, short enough to read on one line. */
const MAX_REASON = 90;

function brief(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_REASON ? `${oneLine.slice(0, MAX_REASON - 1)}…` : oneLine;
}

/** Keep the newest decisions, oldest first. */
export function pushDecision(
  buffer: readonly DecisionRecord[],
  record: DecisionRecord,
  limit = MAX_DECISIONS,
): DecisionRecord[] {
  const next = [...buffer, record];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/**
 * One decision as a single line: when, which route, why it was asked, what
 * answered, what was skipped and why.
 */
export function describeDecision(record: DecisionRecord, now: number): string {
  const parts = [
    `${duration(now - record.at)} ago`,
    record.route,
    record.reason,
    record.chosen ? `→ ${record.chosen}` : "→ no target",
  ];
  if (record.cache) parts.push(record.cache);
  if (record.error) parts.push(`failed: ${brief(record.error)}`);
  const skipped = record.rejected.map((entry) => `${entry.target} (${brief(entry.why)})`);
  if (skipped.length) parts.push(`skipped ${skipped.join(", ")}`);
  return parts.join(" · ");
}

/** `/router why`: the newest decision last, so the latest is closest to the prompt. */
export function formatTrace(records: readonly DecisionRecord[], now: number): string {
  if (!records.length) return "No routing decisions yet in this session.";
  return records.map((record) => describeDecision(record, now)).join("\n");
}
