/**
 * chunking.ts — how a wave of work units is split across reviewers.
 *
 * One arithmetic rule, used by both phases of the lifecycle:
 *
 *   worker units → QA reviewers      (planQaGroups)
 *   work-unit specs → spec reviewers (planSpecChunks)
 *
 * The rule is deliberately not clever: as few reviewers as the per-reviewer cap
 * allows, balanced, with the remainder on the later chunks. Five units at three
 * per reviewer is 2 + 3, which is the shape the lifecycle promises in both
 * phases. If the two phases ever disagreed about that split, a wave would be
 * reviewed by a different shape than it is QA'd by, and "5 became 2 + 3" would
 * stop being a fact a user can hold in their head.
 *
 * Pure: no I/O, no pi imports, no clock. The code that decides how many panes
 * open has to be testable without opening one.
 */

/** A contiguous partition of `items`; `count` chunks, sizes differing by at most one. */
export type RemainderPlacement = "last" | "first";

/**
 * The smallest chunk count that keeps every chunk within `maxPerChunk`,
 * capped at `maxChunks`. Zero items need zero chunks.
 */
export function chunkCount(
  unitCount: number,
  options: { maxPerChunk: number; maxChunks: number },
): number {
  if (!Number.isFinite(unitCount) || unitCount <= 0) return 0;
  const per = Math.max(1, Math.floor(options.maxPerChunk));
  const cap = Math.max(1, Math.floor(options.maxChunks));
  return Math.min(cap, Math.ceil(unitCount / per));
}

/**
 * Partition `items` into exactly `count` contiguous chunks.
 *
 * `remainder: "last"` gives the extra unit to the later chunks (5 over 2 → 2 + 3),
 * which is the convention the lifecycle documents. `"first"` is the mirror, kept
 * because a caller that wants 3 + 2 should be able to say so rather than
 * reimplement the loop.
 *
 * `count` must be >= 1 and <= items.length; the caller has already applied the
 * cap, and a zero/oversized count is a programming error, not a user refusal.
 */
export function balancedChunks<T>(
  items: readonly T[],
  count: number,
  options: { remainder?: RemainderPlacement } = {},
): T[][] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`balancedChunks needs a positive whole chunk count (got ${String(count)})`);
  }
  if (count > items.length) {
    throw new Error(`cannot split ${items.length} item(s) into ${count} non-empty chunks`);
  }
  const base = Math.floor(items.length / count);
  const remainder = items.length % count;
  const extraFirst = (options.remainder ?? "last") === "first";
  const chunks: T[][] = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    // The remainder goes to the later chunks by default: 5 over 2 is 2 + 3.
    const getsExtra = extraFirst ? index < remainder : index >= count - remainder;
    const size = base + (getsExtra ? 1 : 0);
    chunks.push(items.slice(cursor, cursor + size));
    cursor += size;
  }
  return chunks;
}
