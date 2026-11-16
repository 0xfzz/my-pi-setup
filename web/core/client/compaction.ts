// Compaction feedback, in the web core.
//
// Pi compacts a session's context when the window fills (threshold), when a
// request overflows it (overflow recovery), or when the user asks (/compact).
// The terminal shows two things while that happens: a live status line, and —
// once it lands — a transcript row marking where the context was replaced.
// Neither existed in the web: /compact reached no listener, the compaction
// entry never left the session file, and the browser silently jumped from one
// conversation to a shorter one.
//
// The wording lives here as pure functions, so the reason → label mapping is
// tested without a browser and matches the terminal's own wording.

import { formatTokens } from "./context-usage.ts";

/** What triggered a compaction. */
export type CompactionReason = "manual" | "threshold" | "overflow";

export function isCompactionReason(value: unknown): value is CompactionReason {
  return value === "manual" || value === "threshold" || value === "overflow";
}

/**
 * The working line while a compaction runs — the terminal's labels, minus the
 * terminal's key hint (the web cancels with the composer's Stop button).
 */
export function compactionStatusLabel(reason: CompactionReason | null): string {
  if (reason === "overflow") return "Context overflow detected, auto-compacting...";
  if (reason === "threshold") return "Auto-compacting...";
  return "Compacting context...";
}

/**
 * The transcript row's label. The token count is what makes the marker useful
 * — it says how much context the summary replaced — so a missing count still
 * renders the marker, just without the number.
 */
export function compactionMarkerLabel(tokensBefore: number | undefined): string {
  if (tokensBefore === undefined || !Number.isFinite(tokensBefore) || tokensBefore <= 0) {
    return "Context compacted";
  }
  return `Compacted from ${formatTokens(tokensBefore)} tokens`;
}
