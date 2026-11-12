// Pinned-panel policy for the right-sidebar launcher: pure decisions over
// ordered id lists. No DOM, storage, env or clock — the launcher owns those
// and the unit tests drive every branch without a browser.

/** At most this many feature icons are pinned ahead of the ⋯ menu. */
export const MAX_PINS = 3;
/** Shown when a user tries to pin a fourth panel. */
export const PIN_LIMIT_MESSAGE = "You can pin up to 3 panels. Unpin one first.";

export type PinResult =
  | { ok: true; pinned: string[] }
  | { ok: false; error: string };

/** Drop duplicate ids, keeping the first occurrence of each; skip empties. */
function dedupePreserveOrder(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The pin list a fresh install starts with, or a stored list re-read safely.
 * `saved === null` means "no stored preference yet": seed the first three
 * eligible panels in registry order. A stored list is de-duplicated and
 * capped, but never re-seeded — an explicit empty list stays empty.
 */
export function seedPins(
  eligibleIdOrder: readonly string[],
  saved: string[] | null,
): string[] {
  if (saved === null) return eligibleIdOrder.slice(0, MAX_PINS);
  return dedupePreserveOrder(saved).slice(0, MAX_PINS);
}

/** Add `id` to the tail; pinning the already-pinned id is a no-op. */
export function pinPanel(pinned: readonly string[], id: string): PinResult {
  const current = dedupePreserveOrder(pinned);
  if (current.includes(id)) return { ok: true, pinned: current };
  if (current.length >= MAX_PINS) return { ok: false, error: PIN_LIMIT_MESSAGE };
  return { ok: true, pinned: [...current, id] };
}

/** Remove `id`, leaving every other pin in its saved relative order. */
export function unpinPanel(pinned: readonly string[], id: string): string[] {
  return pinned.filter((candidate) => candidate !== id);
}

export interface PinPartition {
  /** Pinned ids that can be shown now, in pin order. */
  available: string[];
  /** Pinned ids whose panel is currently unavailable — kept, never shown on the rail. */
  unavailable: string[];
}

/** Split pins against the set of currently-available ids, preserving pin order. */
export function partitionPinned(
  pinned: readonly string[],
  availableIds: readonly string[],
): PinPartition {
  const available = new Set(availableIds);
  const result: PinPartition = { available: [], unavailable: [] };
  for (const id of dedupePreserveOrder(pinned)) {
    if (available.has(id)) result.available.push(id);
    else result.unavailable.push(id);
  }
  return result;
}