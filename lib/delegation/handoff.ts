/**
 * handoff.ts — the work-unit scope key.
 *
 * A scope is the isolation key for everything a delegated work unit touches: the
 * handoff artifact's visibility (`handoff-<scope>-<n>`), the child's artifact
 * catalog, the lane checks and the registry row. It has to be an exact slug, so
 * it is sanitised once, here, and every producer and consumer agrees.
 *
 * The handoff DOCUMENT itself — its ids, its rendering, its ticket and the
 * freeze it relies on — lives in `handoff-artifact.ts`. This module stays small
 * on purpose: a scope rule that drifted per call site would silently widen a
 * child's visibility.
 */

export class HandoffError extends Error {}

/** A scope is a work-unit slug. It is the isolation key, so it must be exact. */
export function sanitizeScope(scope: string): string {
  const cleaned = String(scope ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!cleaned) {
    throw new HandoffError(`Invalid scope identifier: "${scope}". Must be a non-empty alphanumeric slug.`);
  }
  if (cleaned === "global") {
    throw new HandoffError(
      `Invalid scope identifier: "global" is reserved for artifacts every scope can see. Pick a work-unit name instead.`,
    );
  }
  return cleaned;
}
