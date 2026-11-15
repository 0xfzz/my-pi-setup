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

/**
 * Read the `cache` block from a config file.
 *
 * `declared` says whether this file holds one at all: unlike `pools`, `cache` is
 * a single document rather than a per-name map, so a project file that omits it
 * must not reset the global one to the defaults.
 */
export function readCacheConfig(path: string): { config: CacheConfig; errors: string[]; declared: boolean } {
  if (!existsSync(path)) return { config: DEFAULT_CACHE_CONFIG, errors: [], declared: false };
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { config: DEFAULT_CACHE_CONFIG, errors: [`${path}: expected a JSON object`], declared: false };
    }
    const block = (raw as Record<string, unknown>).cache;
    return { ...normalizeCacheConfig(block), declared: block !== undefined };
  } catch (error) {
    return { config: DEFAULT_CACHE_CONFIG, errors: [`${path}: ${(error as Error).message}`], declared: false };
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

// ── Cost of a decision ───────────────────────────────────────────────────────

/** Catalog prices per token, plus whether the next request would read a cache. */
export type CacheFacts = {
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  /** True when the next request would read this target's entry, not write it. */
  warm?: boolean;
};

/** Per-token prices a decision compares. `Infinity` means the catalog is silent. */
export type Prices = { input: number; read: number; write: number };

const finite = (value: number): boolean => Number.isFinite(value);

function ratioPrice(declared: number | undefined, ratio: number, input: number): number {
  return typeof declared === "number" && finite(declared) && declared > 0 ? declared : ratio * input;
}

/**
 * Prices for one target.
 *
 * A catalog that reports no cache prices is common; the configured ratios are
 * then applied to the input price, which is the relationship the major
 * providers actually bill. An unpriced target is `Infinity` everywhere, so it
 * loses every comparison instead of winning one by accident.
 */
export function pricesOf(facts: CacheFacts | undefined, config: CacheConfig): Prices {
  const input = facts?.cost?.input;
  if (typeof input !== "number" || !finite(input)) {
    return { input: Number.POSITIVE_INFINITY, read: Number.POSITIVE_INFINITY, write: Number.POSITIVE_INFINITY };
  }
  return {
    input,
    read: ratioPrice(facts?.cost?.cacheRead, config.readRatio, input),
    write: ratioPrice(facts?.cost?.cacheWrite, config.writeRatio, input),
  };
}

/** One request on a target that has to write the prefix first. */
export function coldPrice(prices: Prices): number {
  return prices.write;
}

/** One request on a target that reads the prefix from cache. */
export function warmPrice(prices: Prices): number {
  return prices.read;
}

export type Verdict = {
  /** Whether the candidate is cheaper over the horizon than staying put. */
  switch: boolean;
  /** Turns until the switch repays its cache write; `Infinity` when never. */
  breakEvenTurns: number;
  /** Prompt cost of staying on the current target for the whole horizon. */
  stayCost: number;
  /** Prompt cost of moving now and staying on the candidate afterwards. */
  moveCost: number;
};

export type Candidate = { prices: Prices; warm: boolean };

/**
 * Compare staying on the current target with moving to a candidate.
 *
 * `stayCost = H·warm(t)` when the prefix is warm there, and
 * `cold(t) + (H−1)·warm(t)` when it is not: a cold current target pays its own
 * write either way, which is why the comparison then degenerates to price.
 * `moveCost = cold(u) + (H−1)·warm(u)`.
 *
 * The request's own new tokens are not counted. They favour whichever target is
 * cheaper per token, so leaving them out can only make a switch look *worse*
 * than it is — the verdict stays conservative without guessing a delta.
 */
export function switchVerdict(current: Candidate, candidate: Prices, horizon: number): Verdict {
  const stayCost = current.warm
    ? horizon * warmPrice(current.prices)
    : coldPrice(current.prices) + (horizon - 1) * warmPrice(current.prices);
  const moveCost = coldPrice(candidate) + (horizon - 1) * warmPrice(candidate);
  if (!finite(candidate.write) || !finite(candidate.read)) {
    return { switch: false, breakEvenTurns: Number.POSITIVE_INFINITY, stayCost, moveCost };
  }
  if (!finite(current.prices.read)) {
    // The current target has no known price, so any priced candidate is better.
    return { switch: true, breakEvenTurns: 0, stayCost, moveCost };
  }
  // N = write(u) / (read(t) − read(u)); a cold current target already paid its
  // own write, so only the difference in write prices counts.
  const paid = current.warm ? 0 : current.prices.write;
  const saved = current.prices.read - candidate.read;
  const breakEvenTurns = saved > 0
    ? (candidate.write - paid) / saved
    : Number.POSITIVE_INFINITY;
  return { switch: moveCost < stayCost, breakEvenTurns, stayCost, moveCost };
}

/** What one more request costs on a target, used to order cold candidates. */
function orderCost(facts: CacheFacts | undefined, config: CacheConfig): number {
  return coldPrice(pricesOf(facts, config));
}

/** Ascending cost, declaration order for ties, unpriced last. */
function byCost<T>(
  items: readonly { item: T; index: number }[],
  facts: (target: T) => CacheFacts | undefined,
  config: CacheConfig,
): T[] {
  return [...items]
    .map((entry) => ({ ...entry, cost: orderCost(facts(entry.item), config) }))
    .sort((a, b) => (a.cost === b.cost ? a.index - b.index : a.cost - b.cost))
    .map((entry) => entry.item);
}

/**
 * Order a chain by expected cost, keeping a warm target unless moving pays.
 *
 * With nothing warm the order is plain price order, so a `cache` route on a
 * fresh conversation behaves exactly like `cheapest`. With a warm target the
 * chain starts there unless a candidate repays its cache write inside the
 * horizon (see {@link switchVerdict}); the rest of the chain is then ordered by
 * price so a fallback is still the cheapest of what is left.
 */
export function rankByCache<T>(
  chain: readonly T[],
  facts: (target: T) => CacheFacts | undefined,
  config: CacheConfig,
): T[] {
  if (chain.length < 2) return [...chain];
  const indexed = chain.map((item, index) => ({ item, index }));
  const isPricedWarm = (item: T): boolean =>
    facts(item)?.warm === true && finite(pricesOf(facts(item), config).read);
  const warm = indexed.filter((entry) => isPricedWarm(entry.item));
  const kept = byCost(warm, facts, config)[0];
  if (kept === undefined) return byCost(indexed, facts, config);
  const keptEntry = indexed.find((entry) => entry.item === kept)!;

  const current: Candidate = { prices: pricesOf(facts(kept), config), warm: true };
  let best: { index: number; moveCost: number } | undefined;
  for (const entry of indexed) {
    if (entry.index === keptEntry.index) continue;
    const verdict = switchVerdict(current, pricesOf(facts(entry.item), config), config.horizon);
    if (!verdict.switch) continue;
    if (!best || verdict.moveCost < best.moveCost) best = { index: entry.index, moveCost: verdict.moveCost };
  }
  const head = best === undefined ? keptEntry : indexed.find((entry) => entry.index === best.index)!;
  return [head.item, ...byCost(indexed.filter((entry) => entry.index !== head.index), facts, config)];
}
