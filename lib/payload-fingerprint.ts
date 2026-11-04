// Locate where two consecutive provider requests stop sharing a prefix.
//
// A prompt cache matches the longest unchanged prefix. When a provider reports
// a cache read that stops growing, the cause is a byte that differs early in
// the request. This hashes each top-level field and each input item so two
// requests can be compared without storing their content.

import { createHash } from "node:crypto";

export interface Fingerprint {
  /** Hash of every top-level field except the item list, keyed by field name. */
  fields: Record<string, string>;
  /** Hash of each item of the request's item list, in order. */
  items: string[];
  /** Which key held the item list. */
  itemsKey: string;
}

const ITEM_KEYS = ["input", "messages"] as const;
const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex").slice(0, 12);

export function fingerprint(payload: unknown): Fingerprint | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const body = payload as Record<string, unknown>;
  const itemsKey = ITEM_KEYS.find((key) => Array.isArray(body[key]));
  if (!itemsKey) return undefined;
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) if (key !== itemsKey) fields[key] = hash(value);
  return { fields, items: (body[itemsKey] as unknown[]).map(hash), itemsKey };
}

export interface Divergence {
  /** Top-level fields whose value changed: each one invalidates the whole cache. */
  changedFields: string[];
  /** Items shared as an exact prefix; a cache can reuse at most this much. */
  sharedItems: number;
  previousItems: number;
  currentItems: number;
  /** The first item that differs, if the previous request was not a pure prefix. */
  firstChangedItem?: number;
}

export function diverge(previous: Fingerprint, current: Fingerprint): Divergence {
  const names = new Set([...Object.keys(previous.fields), ...Object.keys(current.fields)]);
  const changedFields = [...names].filter((name) => previous.fields[name] !== current.fields[name]);
  let shared = 0;
  const limit = Math.min(previous.items.length, current.items.length);
  while (shared < limit && previous.items[shared] === current.items[shared]) shared++;
  return {
    changedFields,
    sharedItems: shared,
    previousItems: previous.items.length,
    currentItems: current.items.length,
    ...(shared < previous.items.length ? { firstChangedItem: shared } : {}),
  };
}
