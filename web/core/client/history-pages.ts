import type { AssistantBlock } from "./streaming.ts";

/** One rendered transcript row, from disk or from a live SSE event. */
export interface HistoryEntryLike {
  role: "user" | "assistant" | "compaction";
  blocks: AssistantBlock[];
  summary?: string;
  tokensBefore?: number;
  aborted?: boolean;
  error?: string;
}

/** A tool result joined to its call by id. */
export interface ToolResultLike {
  text: string;
  isError: boolean;
  diff?: string;
  images?: Array<{ data: string; mimeType: string }>;
  hasImages?: boolean;
}

/** The bounded history page the server returns. */
export interface HistoryPageResponse {
  entries?: HistoryEntryLike[];
  toolResults?: Record<string, ToolResultLike>;
  olderCursor?: string;
  newerCursor?: string;
  hasOlder?: boolean;
}

/** Structural identity: a live append and its disk copy must merge into one row. */
export function historyEntryKey(entry: HistoryEntryLike): string {
  return JSON.stringify([
    entry.role,
    entry.blocks,
    entry.summary,
    entry.tokensBefore,
    entry.aborted,
    entry.error,
  ]);
}

/** Merge a page into the loaded transcript without ever rendering a row twice. */
export function mergeHistoryEntries(
  current: readonly HistoryEntryLike[],
  incoming: readonly HistoryEntryLike[],
  placement: "prepend" | "append",
): HistoryEntryLike[] {
  // Identical prompts are legitimate; count occurrences so the second `hi`
  // is not mistaken for the disk copy of the first one.
  const loaded = new Map<string, number>();
  for (const entry of current) {
    const key = historyEntryKey(entry);
    loaded.set(key, (loaded.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const fresh = incoming.filter((entry) => {
    const key = historyEntryKey(entry);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    if ((loaded.get(key) ?? 0) >= occurrence) return false;
    loaded.set(key, (loaded.get(key) ?? 0) + 1);
    return true;
  });
  return placement === "prepend" ? [...fresh, ...current] : [...current, ...fresh];
}
