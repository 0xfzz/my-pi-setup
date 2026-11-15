// What a routing policy actually costs over a whole session.
//
// The cost model is the one `docs/prds/cache-aware-routing.md` derives: a warm
// target bills its prefix at the cache-read price, a cold one bills the whole
// prefix at the cache-write price (~12.5x), and the request's own new tokens are
// billed at the input price either way. This is the pessimistic model — a cold
// target writes the whole prefix rather than sharing a shorter entry — because
// the guard is against a regression, not a benchmark.
//
// Two facts this pins, one of them less flattering than the PRD assumed:
//
//   1. A cache-blind policy cannot beat one that counts the cache, in any
//      scenario.
//   2. Rotation is only catastrophic when it outruns the TTL. Alternating two
//      targets that are each revisited inside their TTL keeps *both* entries
//      warm and costs almost nothing extra; rotating across more targets than
//      the TTL can cover makes every request cold, which is the ~12x case.

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CACHE_CONFIG, pricesOf, rankByCache } from "../../lib/provider/cache-routing.ts";

const CONFIG = DEFAULT_CACHE_CONFIG;
const TURNS = 20;
const PREFIX = 20_000;
const GROWTH = 1_000;

type Policy = "cache" | "cheapest" | "round-robin";

/** Input price per target at one turn. */
type PricesAt = (turn: number) => readonly number[];

type Simulation = {
  /** How many targets the chain has. */
  targets: number;
  /** Turns an entry survives without being used; `Infinity` never expires. */
  ttlTurns?: number;
};

/**
 * Total prompt cost of one policy over a session.
 *
 * A target is warm when it was written within `ttlTurns` turns; otherwise the
 * request pays a full write, which is what an expired entry costs.
 */
function simulate(policy: Policy, pricesAt: PricesAt, simulation: Simulation): number {
  const { targets, ttlTurns = Number.POSITIVE_INFINITY } = simulation;
  const chain = Array.from({ length: targets }, (_, index) => index);
  const writtenAt = new Map<number, number>();
  let total = 0;
  let prefix = PREFIX;
  for (let turn = 1; turn <= TURNS; turn++) {
    prefix += GROWTH;
    const prices = pricesAt(turn);
    const warm = (target: number): boolean => {
      const at = writtenAt.get(target);
      return at !== undefined && turn - at <= ttlTurns;
    };
    const chosen = pick(policy, turn, chain, prices, warm);
    const rates = pricesOf({ cost: { input: prices[chosen]!, output: 0 } }, CONFIG);
    // A warm target reads the prefix; a cold one writes all of it. Either way
    // the tokens added this turn are billed at the input price.
    total += (warm(chosen) ? prefix * rates.read : prefix * rates.write) + GROWTH * rates.input;
    writtenAt.set(chosen, turn);
  }
  return total;
}

function pick(
  policy: Policy,
  turn: number,
  chain: readonly number[],
  prices: readonly number[],
  warm: (target: number) => boolean,
): number {
  if (policy === "round-robin") return chain[(turn - 1) % chain.length]!;
  if (policy === "cheapest") {
    return chain.reduce((best, target) => (prices[target]! < prices[best]! ? target : best));
  }
  const facts = (target: number) => ({ cost: { input: prices[target]!, output: 0 }, warm: warm(target) });
  return rankByCache(chain, facts, CONFIG)[0]!;
}

const staticPrices = (prices: readonly number[]): PricesAt => () => prices;
/** The second target becomes `after` at `turn`. */
const flipAt = (turn: number, before: readonly number[], after: readonly number[]): PricesAt =>
  (current) => (current < turn ? before : after);

test("chasing a small price cut across a big prefix costs more than staying warm", () => {
  // `b` drops from 2x to 0.9x at turn 10: `cheapest` pays a full write of a
  // ~30k prefix to save 10% on the remaining eleven turns.
  const prices = flipAt(10, [1, 2], [1, 0.9]);
  const cache = simulate("cache", prices, { targets: 2 });
  const cheapest = simulate("cheapest", prices, { targets: 2 });
  assert.ok(cache < cheapest, `cache ${cache} should beat cheapest ${cheapest}`);
  assert.ok(cheapest / cache > 1.05, "the loss is material, not a rounding difference");
});

test("a large price cut is taken: the cache method matches cheapest rather than clinging to warmth", () => {
  const prices = flipAt(10, [1, 2], [1, 0.1]);
  const cache = simulate("cache", prices, { targets: 2 });
  const cheapest = simulate("cheapest", prices, { targets: 2 });
  assert.ok(cache <= cheapest, `cache ${cache} must not lose to cheapest ${cheapest}`);
  assert.ok(cache / cheapest < 1.01, "both switch, so their totals agree");
});

test("rotation that outruns the TTL is the expensive way to run a conversation", () => {
  // Five accounts, each revisited every five turns, with an entry that survives
  // two: every request is cold, so the whole prefix is written each time.
  const prices = staticPrices([1, 1, 1, 1, 1]);
  const cache = simulate("cache", prices, { targets: 5, ttlTurns: 2 });
  const roundRobin = simulate("round-robin", prices, { targets: 5, ttlTurns: 2 });
  assert.ok(roundRobin / cache >= 5, `round-robin ${roundRobin} vs cache ${cache} should be at least 5x`);
});

test("alternating two targets inside their TTL is nearly free, which is why affinity is opt-in", () => {
  // The honest counter-example to the 12.5x story: both entries stay warm, so
  // rotation costs almost nothing. `cacheAffinity` is therefore opt-in for
  // round-robin rather than forced on it.
  const prices = staticPrices([1, 1.1]);
  const cache = simulate("cache", prices, { targets: 2 });
  const roundRobin = simulate("round-robin", prices, { targets: 2 });
  assert.ok(roundRobin / cache < 1.5, `rotation ${roundRobin} vs cache ${cache} stays close`);
});

test("with a one-turn TTL every request is cold, so cache and price order coincide", () => {
  const prices = staticPrices([1, 2]);
  assert.equal(
    simulate("cache", prices, { targets: 2, ttlTurns: 1 }),
    simulate("cheapest", prices, { targets: 2, ttlTurns: 1 }),
    "no warmth, so no cache premium to avoid",
  );
});

test("no scenario lets a cache-blind policy beat the cache-aware one", () => {
  const scenarios: Array<{ name: string; prices: PricesAt; simulation: Simulation }> = [
    { name: "flat", prices: staticPrices([1, 1]), simulation: { targets: 2 } },
    { name: "small flip", prices: flipAt(10, [1, 2], [1, 0.9]), simulation: { targets: 2 } },
    { name: "large flip", prices: flipAt(10, [1, 2], [1, 0.1]), simulation: { targets: 2 } },
    { name: "cheap target first", prices: staticPrices([0.5, 2]), simulation: { targets: 2 } },
    { name: "short ttl", prices: staticPrices([1, 1.1]), simulation: { targets: 2, ttlTurns: 2 } },
    { name: "five targets, short ttl", prices: staticPrices([1, 1, 1, 1, 1]), simulation: { targets: 5, ttlTurns: 2 } },
  ];
  for (const scenario of scenarios) {
    const cache = simulate("cache", scenario.prices, scenario.simulation);
    for (const policy of ["cheapest", "round-robin"] as const) {
      const other = simulate(policy, scenario.prices, scenario.simulation);
      assert.ok(cache <= other + 1e-9, `${scenario.name}: cache ${cache} vs ${policy} ${other}`);
    }
  }
});
