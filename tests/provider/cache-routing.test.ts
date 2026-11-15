import assert from "node:assert/strict";
import test from "node:test";

import { fingerprint } from "../../lib/payload-fingerprint.ts";
import {
  cacheIdentityOf, cacheKey, DEFAULT_CACHE_CONFIG, describeWarmth, duration, emptyLedger, isWarm,
  MAX_LEDGER_ENTRIES, normalizeCacheConfig, normalizeLedger, observe, prefixUnchanged, pricesOf,
  promptTokens, rankByCache, switchVerdict, ttlFor, withWarmth, type Warmth,
} from "../../lib/provider/cache-routing.ts";

const TTL = 300_000;
const warm = (overrides: Partial<Warmth> = {}): Warmth => ({
  lastAt: 1_000,
  lastWriteAt: 1_000,
  prefixTokens: 60_000,
  readTokens: 0,
  reportsCache: true,
  misses: 0,
  ...overrides,
});

// ── Identity ─────────────────────────────────────────────────────────────────

test("a pooled request keys its cache on the account, not the pool", () => {
  // The account is the cache owner; two accounts of one provider are two entries.
  assert.equal(cacheIdentityOf({ role: "assistant", provider: "antigravity-2", model: "gemini-3-pro", usage: { cacheRead: 10 } }),
    "antigravity-2/gemini-3-pro");
  assert.equal(cacheKey("openai", "gpt-6"), "openai/gpt-6");
});

test("messages that carry no cache evidence are not observed", () => {
  const usage = { input: 100, cacheRead: 0, cacheWrite: 0 };
  assert.equal(cacheIdentityOf({ role: "user", provider: "a", model: "b", usage }), undefined, "not an assistant message");
  assert.equal(cacheIdentityOf({ role: "assistant", stopReason: "error", provider: "a", model: "b", usage }), undefined, "a failure proves nothing");
  assert.equal(cacheIdentityOf({ role: "assistant", stopReason: "aborted", provider: "a", model: "b", usage }), undefined, "an abort proves nothing");
  assert.equal(cacheIdentityOf({ role: "assistant", provider: "", model: "b", usage }), undefined, "no provider");
  assert.equal(cacheIdentityOf({ role: "assistant", provider: "a", model: "b" }), undefined, "no usage");
  assert.equal(cacheIdentityOf({ role: "assistant", provider: "a", model: "b", usage: { input: 0 } }), undefined, "no prompt tokens");
  assert.equal(cacheIdentityOf({ role: "assistant", provider: "a", model: "b", usage }), "a/b");
});

test("prompt tokens are the three disjoint parts, never a negative or a NaN", () => {
  assert.equal(promptTokens(undefined), 0);
  assert.equal(promptTokens({ input: 10, cacheRead: 5, cacheWrite: 2 }), 17);
  assert.equal(promptTokens({ input: -10, cacheRead: Number.NaN }), 0);
});

// ── Prefix comparison ────────────────────────────────────────────────────────

const payload = (messages: string[], extra: Record<string, unknown> = {}) => ({ model: "m", messages: messages.map((text) => ({ role: "user", content: text })), ...extra });

test("an appended conversation is an unchanged prefix", () => {
  const first = fingerprint(payload(["one"]));
  const second = fingerprint(payload(["one", "two"]));
  assert.equal(prefixUnchanged(first, second), true);
});

test("a changed top-level field or a rewritten message is not an unchanged prefix", () => {
  const first = fingerprint(payload(["one"]));
  assert.equal(prefixUnchanged(first, fingerprint(payload(["one", "two"], { tools: ["x"] }))), false, "a changed field invalidates the cache");
  assert.equal(prefixUnchanged(first, fingerprint(payload(["rewritten"]))), false, "a rewritten message invalidates it");
  assert.equal(prefixUnchanged(undefined, first), false, "no previous request, nothing proven");
});

// ── observe ──────────────────────────────────────────────────────────────────

test("a first request records a write, not a hit", () => {
  const entry = observe(undefined, { at: 1_000, usage: { input: 0, cacheRead: 0, cacheWrite: 60_000 }, prefixUnchanged: false })!;
  assert.equal(entry.prefixTokens, 60_000);
  assert.equal(entry.readTokens, 0);
  assert.equal(entry.lastWriteAt, 1_000);
  assert.equal(entry.lastHitAt, undefined);
  assert.equal(entry.reportsCache, true, "a write is evidence of caching");
});

test("a hit records the read, its rate, and a TTL floor measured from the write", () => {
  const written = warm({ lastAt: 1_000, lastWriteAt: 1_000 });
  const entry = observe(written, { at: 61_000, usage: { input: 0, cacheRead: 60_000 }, prefixUnchanged: true })!;
  assert.equal(entry.readTokens, 60_000);
  assert.equal(entry.lastHitAt, 61_000);
  assert.equal(entry.ttlFloorMs, 60_000, "the entry survived at least 60s");
  assert.equal(entry.misses, 0);
});

test("a miss on an unchanged prefix proves expiry and records the ceiling", () => {
  const written = warm({ lastAt: 1_000, lastWriteAt: 1_000 });
  const entry = observe(written, { at: 400_000, usage: { input: 60_000 }, prefixUnchanged: true })!;
  assert.equal(entry.ttlCeilMs, 399_000, "the entry did not survive 399s");
  assert.equal(entry.misses, 1);
});

test("a miss after the prefix changed proves nothing about the TTL", () => {
  const written = warm({ lastAt: 1_000, lastWriteAt: 1_000 });
  const entry = observe(written, { at: 400_000, usage: { input: 60_000 }, prefixUnchanged: false })!;
  assert.equal(entry.ttlCeilMs, undefined);
  assert.equal(entry.misses, 0, "not a cache miss, a different request");
});

test("a provider that reports no cache tokens on an unchanged prefix is marked as such", () => {
  const previous = warm({ lastAt: 1_000, lastWriteAt: 1_000 });
  const entry = observe(previous, { at: 2_000, usage: { input: 60_000 }, prefixUnchanged: true })!;
  assert.equal(entry.reportsCache, false);
  assert.equal(isWarm(entry, { now: 2_000, ttlMs: TTL }), false, "a provider without a cache is never warm");
});

test("usage with no prompt tokens leaves the entry alone", () => {
  assert.equal(observe(undefined, { at: 1_000, usage: { input: 0 }, prefixUnchanged: false }), undefined);
  assert.equal(observe(undefined, { at: 1_000, usage: undefined, prefixUnchanged: false }), undefined);
});

test("consecutive misses accumulate; a hit resets them", () => {
  const first = observe(warm(), { at: 2_000, usage: { input: 60_000 }, prefixUnchanged: true })!;
  const second = observe(first, { at: 3_000, usage: { input: 60_000 }, prefixUnchanged: true })!;
  assert.equal(second.misses, 2);
  const hit = observe(second, { at: 4_000, usage: { cacheRead: 60_000 }, prefixUnchanged: true })!;
  assert.equal(hit.misses, 0);
});

// ── isWarm ───────────────────────────────────────────────────────────────────

test("warmth expires at the prior TTL and earlier at a proven ceiling", () => {
  const entry = warm({ lastAt: 1_000, lastWriteAt: 1_000 });
  assert.equal(isWarm(entry, { now: 1_000 + TTL - 1, ttlMs: TTL }), true);
  assert.equal(isWarm(entry, { now: 1_000 + TTL, ttlMs: TTL }), false, "expired exactly at the TTL");
  assert.equal(isWarm({ ...entry, ttlCeilMs: 60_000 }, { now: 1_000 + 61_000, ttlMs: TTL }), false, "a proven ceiling wins");
});

test("a prefix too small to cache is cold however recently it was written", () => {
  const entry = warm({ prefixTokens: 200 });
  assert.equal(isWarm(entry, { now: 1_000, ttlMs: TTL }), false);
  assert.equal(isWarm(entry, { now: 1_000, ttlMs: TTL, minCacheableTokens: 100 }), true);
});

test("an entry that never hit and never wrote is not warm", () => {
  assert.equal(isWarm(undefined, { now: 1_000, ttlMs: TTL }), false);
  assert.equal(isWarm({ lastAt: 1_000, prefixTokens: 60_000, readTokens: 0, reportsCache: true, misses: 1 }, { now: 1_000, ttlMs: TTL }), false);
});

// ── describeWarmth ───────────────────────────────────────────────────────────

test("warmth reads as remaining time and hit rate", () => {
  const entry = warm({ lastAt: 1_000, lastWriteAt: 1_000, lastHitAt: 1_000, readTokens: 56_400 });
  assert.equal(describeWarmth(entry, { now: 1_000 + 60_000, ttlMs: TTL }), "warm 60k · 4m left · 94% hit");
});

test("a cold entry says how long ago it was used, and no data is a dash", () => {
  const entry = warm({ lastAt: 1_000, lastWriteAt: 1_000 });
  assert.equal(describeWarmth(entry, { now: 1_000 + 360_000, ttlMs: TTL }), "cold · last 6m ago");
  assert.equal(describeWarmth(undefined, { now: 0, ttlMs: TTL }), "–");
  assert.equal(describeWarmth({ ...entry, reportsCache: false }, { now: 2_000, ttlMs: TTL }), "no cache");
});

test("durations stay compact at every scale", () => {
  assert.equal(duration(0), "0s");
  assert.equal(duration(45_000), "45s");
  assert.equal(duration(12 * 60_000), "12m");
  assert.equal(duration(3 * 3_600_000), "3h");
  assert.equal(duration(-5_000), "0s");
});

// ── Ledger ───────────────────────────────────────────────────────────────────

test("the ledger keeps the newest entries and evicts the coldest", () => {
  let ledger = emptyLedger();
  for (let index = 0; index < MAX_LEDGER_ENTRIES + 4; index++) {
    ledger = withWarmth(ledger, `p${index}/m`, warm({ lastAt: index }));
  }
  const keys = Object.keys(ledger.entries);
  assert.equal(keys.length, MAX_LEDGER_ENTRIES);
  assert.equal(ledger.entries["p0/m"], undefined, "the oldest was evicted");
  assert.ok(ledger.entries[`p${MAX_LEDGER_ENTRIES + 3}/m`], "the newest survived");
});

test("a restored ledger drops malformed entries and keeps the rest", () => {
  const restored = normalizeLedger({
    version: 1,
    entries: {
      "a/b": { lastAt: 5, prefixTokens: 100, readTokens: 50, reportsCache: true, misses: 0, ttlCeilMs: 9 },
      "c/d": { prefixTokens: 100 },
      "e/f": "nonsense",
    },
  });
  assert.deepEqual(Object.keys(restored.entries), ["a/b"]);
  assert.equal(restored.entries["a/b"]!.ttlCeilMs, 9);
  assert.deepEqual(normalizeLedger(undefined).entries, {});
  assert.deepEqual(normalizeLedger({ version: 2 }).entries, {}, "an unknown version is discarded, not guessed");
});

// ── Config ───────────────────────────────────────────────────────────────────

test("the cache block defaults, validates and falls back per key", () => {
  assert.deepEqual(normalizeCacheConfig(undefined), { config: DEFAULT_CACHE_CONFIG, errors: [] });
  const { config, errors } = normalizeCacheConfig({ horizon: 0, minCacheableTokens: 64, ttlMs: { anthropic: 60_000, "*": 1_000, bad: -1 } });
  assert.equal(config.horizon, DEFAULT_CACHE_CONFIG.horizon, "a non-positive horizon is refused");
  assert.equal(config.minCacheableTokens, 64);
  assert.equal(ttlFor(config, "anthropic"), 60_000, "an exact provider wins");
  assert.equal(ttlFor(config, "openai"), 1_000, "then the glob");
  assert.deepEqual(errors.sort(), [
    'cache.horizon must be a positive number',
    'cache.ttlMs["bad"] must be a positive number',
  ]);
});

test("a cache block that is not an object is reported, not silently ignored", () => {
  const { config, errors } = normalizeCacheConfig([1, 2]);
  assert.deepEqual(config, DEFAULT_CACHE_CONFIG);
  assert.deepEqual(errors, ['"cache" must be an object']);
});

// ── Cost of a decision ───────────────────────────────────────────────────────

const CACHE = { ...DEFAULT_CACHE_CONFIG, horizon: 3 };
/** A target priced at `input` per token, with no cache prices of its own. */
const priced = (input: number, warm = false) => ({ cost: { input, output: 0 }, warm });
const rates = (input: number) => pricesOf(priced(input), CACHE);

test("prices fall back to the configured ratios when the catalog is silent", () => {
  assert.deepEqual(rates(1), { input: 1, read: 0.1, write: 1.25 });
  // A catalog that does report cache prices wins over the ratio.
  assert.deepEqual(
    pricesOf({ cost: { input: 1, output: 0, cacheRead: 0.3, cacheWrite: 2 } }, CACHE),
    { input: 1, read: 0.3, write: 2 },
  );
  // An unpriced target loses every comparison rather than winning by accident.
  assert.equal(pricesOf(undefined, CACHE).read, Number.POSITIVE_INFINITY);
  assert.equal(pricesOf({ cost: { input: Number.NaN, output: 0 } }, CACHE).write, Number.POSITIVE_INFINITY);
});

test("the break-even table of the PRD holds: a warm target is kept under ~5x", () => {
  // Each row is a price gap between the warm current target and a cold candidate.
  const rows: Array<{ gap: number; switchAt3: boolean; switchAt1: boolean }> = [
    { gap: 1.2, switchAt3: false, switchAt1: false },
    { gap: 2, switchAt3: false, switchAt1: false },
    { gap: 4, switchAt3: false, switchAt1: false },
    { gap: 5.2, switchAt3: true, switchAt1: false },
    { gap: 10, switchAt3: true, switchAt1: false },
  ];
  for (const row of rows) {
    const current = { prices: rates(row.gap), warm: true };
    assert.equal(switchVerdict(current, rates(1), 3).switch, row.switchAt3, `gap ${row.gap} at H=3`);
    assert.equal(switchVerdict(current, rates(1), 1).switch, row.switchAt1, `gap ${row.gap} at H=1`);
  }
});

test("break-even turns are write(u) / (read(t) − read(u))", () => {
  const current = { prices: rates(10), warm: true };
  const verdict = switchVerdict(current, rates(1), 3);
  assert.equal(verdict.breakEvenTurns, 1.25 / (1 - 0.1));
  assert.equal(verdict.switch, true, "1.4 turns repays well inside a 3-turn horizon");
  assert.equal(switchVerdict(current, rates(1), 1).switch, false, "a single turn never repays a write");
});

test("a cold current target compares like price, because it pays its own write anyway", () => {
  const current = { prices: rates(2), warm: false };
  assert.equal(switchVerdict(current, rates(1), 3).switch, true, "the cheaper target wins");
  assert.equal(switchVerdict(current, rates(3), 3).switch, false, "the dearer one does not");
  // Equal prices: no reason to move.
  assert.equal(switchVerdict({ prices: rates(1), warm: false }, rates(1), 3).switch, false);
});

test("an unpriced current target is abandoned for any priced one; an unpriced candidate is never taken", () => {
  const unknown = pricesOf(undefined, CACHE);
  assert.equal(switchVerdict({ prices: unknown, warm: true }, rates(1), 1).switch, true);
  assert.equal(switchVerdict({ prices: rates(1), warm: true }, unknown, 99).switch, false);
});

test("rankByCache keeps a warm target when nothing repays the move", () => {
  const facts = (target: string) => target === "warm" ? priced(4, true) : priced(1);
  assert.deepEqual(rankByCache(["warm", "cold"], facts, CACHE), ["warm", "cold"], "a 4x gap does not repay 1.25 writes in 3 turns");
  assert.deepEqual(rankByCache(["warm", "cold"], facts, { ...CACHE, horizon: 20 }), ["cold", "warm"], "a long horizon does");
});

test("rankByCache is plain price order when nothing is warm", () => {
  const facts = (target: string) => priced(Number(target));
  assert.deepEqual(rankByCache(["4", "1", "2"], facts, CACHE), ["1", "2", "4"]);
  assert.deepEqual(rankByCache(["2", "1", "1"], facts, CACHE), ["1", "1", "2"], "ties keep declaration order");
});

test("rankByCache puts the cheapest warm target first and unpriced targets last", () => {
  const facts = (target: string) => {
    if (target === "unpriced") return undefined;
    if (target === "warm-dear") return priced(5, true);
    if (target === "warm-cheap") return priced(2, true);
    return priced(9);
  };
  const ranked = rankByCache(["unpriced", "warm-dear", "cold", "warm-cheap"], facts, { ...CACHE, horizon: 1 });
  assert.equal(ranked[0], "warm-cheap", "the cheapest warm entry is the one to keep");
  assert.equal(ranked.at(-1), "unpriced", "an unpriced target never wins");
  assert.deepEqual(ranked.slice(1, -1), ["warm-dear", "cold"], "the tail is price order, so a fallback is the cheapest left");
});

test("rankByCache leaves a one-target chain alone", () => {
  assert.deepEqual(rankByCache(["only"], () => priced(1), CACHE), ["only"]);
});
