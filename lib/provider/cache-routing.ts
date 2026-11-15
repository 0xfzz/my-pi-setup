// Prompt-cache warmth: which side wrote the prefix the next request re-sends.
//
// A provider cache is scoped to the account (or org) and model that wrote it,
// and to an exact prefix. Which target answered the last request therefore
// decides whether the next one pays ~10% of the prompt price or ~125% of it.
// This module turns the usage every assistant message already carries into that
// answer: a small ledger per conversation, and the price arithmetic a routing
// decision needs (see docs/prds/cache-aware-routing.md).
//
// Pure: no Pi imports, no clock of its own, no I/O in the decision functions.
// The extension supplies `now` and the observations; `payload-fingerprint.ts`
// answers "did the prefix change at all".

import { existsSync, readFileSync } from "node:fs";
import { tokens } from "../cache-stats.ts";
import { diverge, type Fingerprint } from "../payload-fingerprint.ts";

/** Provider-reported prompt accounting: the three disjoint parts. */
export type CacheUsage = { input?: number; cacheRead?: number; cacheWrite?: number };

/**
 * What one conversation knows about its cache entry on one (account, model).
 *
 * `ttlFloorMs` and `ttlCeilMs` are the only TTL facts a provider never states
 * outright: a hit proves the entry lived at least that long, and a miss on an
 * *unchanged* prefix proves it did not live longer.
 */
export type Warmth = {
  /** Time of the last observed request. */
  lastAt: number;
  /** Last request that read cached tokens, if any. */
  lastHitAt?: number;
  /** Last request that wrote a cache entry, if any. */
  lastWriteAt?: number;
  /** Prompt tokens of that request: input + cacheRead + cacheWrite. */
  prefixTokens: number;
  /** Of those, how many came from cache. */
  readTokens: number;
  /** False once the provider demonstrably does not cache this prefix. */
  reportsCache: boolean;
  /** Lowest TTL the observations prove (a hit at +X). */
  ttlFloorMs?: number;
  /** Highest TTL the observations allow (a miss at +Y on an unchanged prefix). */
  ttlCeilMs?: number;
  /** Consecutive misses on an unchanged prefix. */
  misses: number;
};

export type CacheLedger = { version: 1; entries: Record<string, Warmth> };

/** One request's contribution to the ledger. */
export type Observation = {
  at: number;
  usage: CacheUsage | undefined;
  /** True when the previous request's whole item list is a prefix of this one. */
  prefixUnchanged: boolean;
};

/** The fields of an assistant message this module reads. */
export type MessageLike = {
  role?: string;
  stopReason?: string;
  provider?: string;
  model?: string;
  usage?: CacheUsage;
};

export type CacheConfig = {
  /** Turns a switch must repay itself over; 1 means never leave a warm target. */
  horizon: number;
  /** Below this prompt size the provider would not cache it, so cache logic is off. */
  minCacheableTokens: number;
  /** Prior TTL per provider, `"*"` as the fallback. */
  ttlMs: Record<string, number>;
  /** Read price as a fraction of the input price, when the catalog reports none. */
  readRatio: number;
  /** Write price as a fraction of the input price, when the catalog reports none. */
  writeRatio: number;
};

export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  horizon: 3,
  minCacheableTokens: 1024,
  ttlMs: { "*": 300_000 },
  readRatio: 0.1,
  writeRatio: 1.25,
};

/** Bound on ledger entries per conversation; the coldest is evicted. */
export const MAX_LEDGER_ENTRIES = 32;

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** `provider/model`, the identity a cache entry is scoped to. */
export function cacheKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

export function emptyLedger(): CacheLedger {
  return { version: 1, entries: {} };
}

export function warmthFor(ledger: CacheLedger, key: string): Warmth | undefined {
  return ledger.entries[key];
}

/** Replace one entry, evicting the coldest once the ledger is full. */
export function withWarmth(ledger: CacheLedger, key: string, warmth: Warmth): CacheLedger {
  const entries = { ...ledger.entries, [key]: warmth };
  const keys = Object.keys(entries);
  if (keys.length > MAX_LEDGER_ENTRIES) {
    const coldest = keys.reduce((oldest, candidate) =>
      (entries[candidate]!.lastAt < entries[oldest]!.lastAt ? candidate : oldest));
    delete entries[coldest];
  }
  return { version: 1, entries };
}

/**
 * Whether the previous request's item list is still a prefix of this one.
 *
 * With no changed top-level field and every previous item shared in order, the
 * request is the same conversation extended — so a miss cannot be blamed on the
 * prefix, and the entry must have expired.
 */
export function prefixUnchanged(previous: Fingerprint | undefined, current: Fingerprint | undefined): boolean {
  if (!previous || !current) return false;
  const difference = diverge(previous, current);
  return difference.changedFields.length === 0 && difference.sharedItems === previous.items.length;
}

/** The cache identity a successful assistant message reports, or undefined. */
export function cacheIdentityOf(message: MessageLike | undefined): string | undefined {
  if (!message || message.role !== "assistant") return undefined;
  if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
  const provider = message.provider?.trim();
  const modelId = message.model?.trim();
  if (!provider || !modelId) return undefined;
  if (promptTokens(message.usage) === 0) return undefined;
  return cacheKey(provider, modelId);
}

/** Prompt tokens a usage block reports, or 0 when it reports none. */
export function promptTokens(usage: CacheUsage | undefined): number {
  if (!usage) return 0;
  return count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite);
}

/** The moment an entry's age is measured from: the last hit, else the last write. */
function anchorOf(warmth: Warmth | undefined): number | undefined {
  return warmth?.lastHitAt ?? warmth?.lastWriteAt;
}

/**
 * Fold one request into an entry.
 *
 * Returns undefined when the usage carries no prompt tokens, so a caller keeps
 * whatever it had: an error or an aborted request proves nothing about the
 * cache either way.
 */
export function observe(previous: Warmth | undefined, observation: Observation): Warmth | undefined {
  const prompt = promptTokens(observation.usage);
  if (prompt === 0) return undefined;
  const read = count(observation.usage?.cacheRead);
  const wrote = count(observation.usage?.cacheWrite) > 0;
  const hit = read > 0;
  const anchor = anchorOf(previous);
  // A miss only blames the cache when the request was the same conversation:
  // otherwise the prefix itself changed, which says nothing about expiry.
  const expired = !hit && observation.prefixUnchanged && anchor !== undefined;
  const floor = hit && anchor !== undefined ? observation.at - anchor : undefined;
  const ceiling = expired && anchor !== undefined ? observation.at - anchor : undefined;
  return {
    lastAt: observation.at,
    ...keepTime("lastHitAt", hit ? observation.at : previous?.lastHitAt),
    ...keepTime("lastWriteAt", wrote ? observation.at : previous?.lastWriteAt),
    prefixTokens: prompt,
    readTokens: read,
    reportsCache: reportsCacheAfter(previous, { hit, wrote, expired }),
    ...keepNumber("ttlFloorMs", Math.max(previous?.ttlFloorMs ?? 0, floor ?? 0) || undefined),
    ...keepNumber("ttlCeilMs", ceiling === undefined
      ? previous?.ttlCeilMs
      : Math.min(previous?.ttlCeilMs ?? Number.POSITIVE_INFINITY, ceiling)),
    misses: hit ? 0 : observation.prefixUnchanged ? (previous?.misses ?? 0) + 1 : (previous?.misses ?? 0),
  };
}

/** Only an unchanged prefix reporting no cache at all disproves caching. */
function reportsCacheAfter(
  previous: Warmth | undefined,
  request: { hit: boolean; wrote: boolean; expired: boolean },
): boolean {
  if (request.hit || request.wrote) return true;
  if (request.expired) return false;
  return previous?.reportsCache ?? true;
}

function keepTime(field: "lastHitAt" | "lastWriteAt", value: number | undefined): Partial<Warmth> {
  return value === undefined ? {} : { [field]: value };
}

function keepNumber(field: "ttlFloorMs" | "ttlCeilMs", value: number | undefined): Partial<Warmth> {
  return value === undefined || !Number.isFinite(value) ? {} : { [field]: value };
}

export type WarmthOptions = { now: number; ttlMs: number; minCacheableTokens?: number };

/** The TTL an entry is judged by: the prior, capped by what a miss proved. */
function ttlOf(warmth: Warmth, ttlMs: number): number {
  return Math.min(ttlMs, warmth.ttlCeilMs ?? Number.POSITIVE_INFINITY);
}

/**
 * Whether the next request would read this entry instead of writing it.
 *
 * A prefix too small to be worth caching counts as cold: the provider would not
 * have stored it, so there is nothing to lose by moving.
 */
export function isWarm(warmth: Warmth | undefined, options: WarmthOptions): boolean {
  if (!warmth || !warmth.reportsCache) return false;
  if (warmth.prefixTokens < (options.minCacheableTokens ?? DEFAULT_CACHE_CONFIG.minCacheableTokens)) return false;
  const anchor = anchorOf(warmth);
  if (anchor === undefined) return false;
  return options.now - anchor < ttlOf(warmth, options.ttlMs);
}

/** `warm 58k · 2m left · 94% hit`, `cold · last 6m ago`, `no cache`, or `–`. */
export function describeWarmth(warmth: Warmth | undefined, options: WarmthOptions): string {
  if (!warmth) return "–";
  if (!warmth.reportsCache) return "no cache";
  if (isWarm(warmth, options)) {
    const left = ttlOf(warmth, options.ttlMs) - (options.now - (anchorOf(warmth) ?? options.now));
    const rate = warmth.prefixTokens > 0 ? Math.round((warmth.readTokens / warmth.prefixTokens) * 100) : 0;
    return `warm ${tokens(warmth.prefixTokens)} · ${duration(left)} left · ${rate}% hit`;
  }
  return `cold · last ${duration(options.now - warmth.lastAt)} ago`;
}

/** Compact remaining time: 45s, 12m, 3h. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

/** TTL prior for a provider, `"*"` as the fallback. */
export function ttlFor(config: CacheConfig, provider: string): number {
  return config.ttlMs[provider] ?? config.ttlMs["*"] ?? DEFAULT_CACHE_CONFIG.ttlMs["*"]!;
}

/** Validate the `cache` block of a config document. */
export function normalizeCacheConfig(raw: unknown): { config: CacheConfig; errors: string[] } {
  if (raw === undefined) return { config: DEFAULT_CACHE_CONFIG, errors: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { config: DEFAULT_CACHE_CONFIG, errors: ['"cache" must be an object'] };
  }
  const doc = raw as Record<string, unknown>;
  const errors: string[] = [];
  const number = (key: string, fallback: number, positive: boolean): number => {
    const value = doc[key];
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || (positive && value <= 0)) {
      errors.push(`cache.${key} must be a ${positive ? "positive" : "non-negative"} number`);
      return fallback;
    }
    return value;
  };
  const ttlMs: Record<string, number> = { ...DEFAULT_CACHE_CONFIG.ttlMs };
  if (doc.ttlMs !== undefined) {
    if (typeof doc.ttlMs !== "object" || doc.ttlMs === null || Array.isArray(doc.ttlMs)) {
      errors.push('cache.ttlMs must be an object of provider → milliseconds');
    } else {
      for (const [provider, value] of Object.entries(doc.ttlMs as Record<string, unknown>)) {
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
          errors.push(`cache.ttlMs["${provider}"] must be a positive number`);
          continue;
        }
        ttlMs[provider] = value;
      }
    }
  }
  return {
    config: {
      horizon: number("horizon", DEFAULT_CACHE_CONFIG.horizon, true),
      minCacheableTokens: number("minCacheableTokens", DEFAULT_CACHE_CONFIG.minCacheableTokens, false),
      readRatio: number("readRatio", DEFAULT_CACHE_CONFIG.readRatio, false),
      writeRatio: number("writeRatio", DEFAULT_CACHE_CONFIG.writeRatio, false),
      ttlMs,
    },
    errors,
  };
}

/** Read the `cache` block from a config file; a missing file keeps the defaults. */
export function readCacheConfig(path: string): { config: CacheConfig; errors: string[] } {
  if (!existsSync(path)) return { config: DEFAULT_CACHE_CONFIG, errors: [] };
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { config: DEFAULT_CACHE_CONFIG, errors: [`${path}: expected a JSON object`] };
    }
    return normalizeCacheConfig((raw as Record<string, unknown>).cache);
  } catch (error) {
    return { config: DEFAULT_CACHE_CONFIG, errors: [`${path}: ${(error as Error).message}`] };
  }
}

/** Restore a ledger from branch state or disk, dropping anything malformed. */
export function normalizeLedger(raw: unknown): CacheLedger {
  const ledger = emptyLedger();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ledger;
  const doc = raw as Record<string, unknown>;
  if (doc.version !== 1) return ledger;
  const entries = doc.entries;
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return ledger;
  for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.lastAt !== "number" || !Number.isFinite(entry.lastAt)) continue;
    ledger.entries[key] = {
      lastAt: entry.lastAt,
      prefixTokens: count(entry.prefixTokens),
      readTokens: count(entry.readTokens),
      reportsCache: entry.reportsCache !== false,
      misses: typeof entry.misses === "number" && Number.isFinite(entry.misses) ? entry.misses : 0,
      ...keepTime("lastHitAt", timeOf(entry.lastHitAt)),
      ...keepTime("lastWriteAt", timeOf(entry.lastWriteAt)),
      ...keepNumber("ttlFloorMs", timeOf(entry.ttlFloorMs)),
      ...keepNumber("ttlCeilMs", timeOf(entry.ttlCeilMs)),
    };
  }
  return ledger;
}

function timeOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
