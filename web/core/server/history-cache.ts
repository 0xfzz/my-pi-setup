// A small cache of parsed session histories. Opening a conversation, a
// reconnect, and expanding a screenshot each read the same session file, and
// parsing a 37 MB file takes hundreds of milliseconds each time. The cache is
// keyed on the file's stamp (size and mtime), so an appended turn is always
// re-read and a cached history is never stale.

import { stat } from "node:fs/promises";

/** The stamp of a session file: its size and mtime. A missing file has its own stamp. */
export async function fileStamp(file: string): Promise<string> {
  try {
    const info = await stat(file);
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return "missing";
  }
}

export interface HistoryCacheOptions<T> {
  /** Parse one session file. */
  load(file: string): Promise<T>;
  /** A value that changes whenever the file changes (size and mtime). */
  stamp(file: string): Promise<string>;
  /** How many parsed histories to keep; the least recently stored is dropped first. */
  capacity?: number;
}

export function createHistoryCache<T>(options: HistoryCacheOptions<T>): (file: string) => Promise<T> {
  const capacity = options.capacity ?? 4;
  const entries = new Map<string, { stamp: string; value: T }>();

  return async (file) => {
    // Stamp before loading: a write that lands during the load leaves the
    // cached stamp older than the file, so the next read re-parses it.
    const stamp = await options.stamp(file);
    const cached = entries.get(file);
    if (cached !== undefined && cached.stamp === stamp) return cached.value;

    const value = await options.load(file);
    entries.delete(file);
    entries.set(file, { stamp, value });
    while (entries.size > capacity) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    return value;
  };
}
