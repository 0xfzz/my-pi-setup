// Persistence for the launcher's pinned-panel ids. The stored schema is a
// small versioned JSON object; reads tolerate invalid JSON, a wrong version,
// a denied store and non-string entries, and writes are best-effort.

const STORAGE_KEY = "pi-web-minimal:pinned-panels:v1";
const SCHEMA_VERSION = 1;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Read the stored pin list.
 * - `null` — no usable stored preference (never saved, corrupt, or wrong
 *   version): the caller seeds the first three eligible panels.
 * - `string[]` — the stored, validated ids, possibly empty.
 */
export function loadPinnedIds(storage: StorageLike): string[] | null {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (record.version !== SCHEMA_VERSION || !Array.isArray(record.pinned)) {
      return null;
    }
    const ids: string[] = [];
    for (const item of record.pinned) {
      if (typeof item === "string" && item !== "") ids.push(item);
    }
    return ids;
  } catch {
    return null;
  }
}

/** Persist the pin list; a full or denied store is silently ignored. */
export function savePinnedIds(storage: StorageLike, pinned: readonly string[]): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, pinned }));
  } catch {
    // Best effort: losing the preference is better than breaking the render.
  }
}

/**
 * The browser's localStorage wrapped to survive being unavailable (private
 * mode, storage disabled). Returns an inert store in that case.
 */
export function browserStorage(): StorageLike {
  try {
    if (typeof window !== "undefined" && window.localStorage !== undefined) {
      return window.localStorage;
    }
  } catch {
    // Fall through to the inert store.
  }
  return { getItem: () => null, setItem: () => {} };
}