# PRD: Cache-aware routing for the account router

> Part of [pi-workflow-extensions](../../README.md). Makes `/router` choose a
> target and an account by *what the next request will actually cost*, which for
> a long conversation is decided mostly by whether the prompt cache is still warm
> on the side that wrote it.

| Field | Value |
| --- | --- |
| **Status** | implemented — see §9 for the commits |
| **Date** | 2026-11-15 |
| **Owner** | Faiz |
| **Branch** | `feat/porting-router-extension-to-web` |
| **Parent** | [Accounts and router](../accounts.md) (route table, pools, methods, triggers) |
| **Related** | [Token efficiency](../token-efficiency.md) (prefix rules, breakpoints), `lib/cache-anchor.ts`, `lib/cache-stats.ts`, `lib/payload-fingerprint.ts` |
| **Scope** | `extensions/account-router.ts`, `lib/provider/{cache-routing,model-routes,account-pools,router-settings}.ts`, `lib/ui/router-settings.ts`, `docs/{accounts,token-efficiency}.md`, tests |
| **Supersedes** | nothing; adds a method and a pool policy, keeps every existing default |

## 1. State of the world

| # | Finding | Evidence |
| --- | --- | --- |
| F1 | The router is cache-blind. No routing decision anywhere reads `cacheRead`/`cacheWrite`; the only cache code is `addUsage`, which *sums* the two fields of a recovery probe into the request's usage. | `extensions/account-router.ts:276-283` |
| F2 | `method: "round-robin"` + `when: "turn"` rotates the head on **every user turn** by design, which re-sends the whole conversation to a target whose cache is cold. | `lib/provider/model-routes.ts` `routeDecision`, `orderTargets`; `docs/accounts.md` method table |
| F3 | `method: "cheapest"` re-orders by catalog price on every user request, so a target that is 5% cheaper and cache-cold wins over the warm one it just replaced. | `orderTargets` `cheapest` case; `targetPrice` |
| F4 | Pool stickiness is scoped to **one agent run**: `agent_start` clears `runAccount`, so the next prompt may pick a different account and pay a full cache write. The comment above it says rotation "happens between user prompts" — which is exactly when the cache is still warm. | `extensions/account-router.ts:222-231`, `:954-955` |
| F5 | The router already observes every successful response, for pooled *and* plain targets: `message_end` carries the physical `provider`, `model` and the full `usage`. Nothing reads the cache fields. | `extensions/account-router.ts:960`; the scripted usage shape in `tests/account-router-runtime.test.ts` |
| F6 | The cache identity the router would need is already available: a pooled request reports the **account id** as its provider, a plain target reports its own provider. Both are matched back to a target by `targetMatches`. | `extensions/account-router.ts:637`, `:312` (`physical.provider = accountId`) |
| F7 | Whether a miss was *our* fault or the prefix's is already computable: `fingerprint`/`diverge` report changed fields and the shared item prefix, and `cache-trace` already uses them per request. | `lib/payload-fingerprint.ts`; `extensions/cache-trace.ts` |
| F8 | The catalog carries cache prices (`cost.cacheRead`, `cost.cacheWrite`), so the comparison needs no new data source. | `pi-ai/dist/providers/model-schema.d.ts:37-48` |
| F9 | `route()` returns no `state`, so `request.state` is always `undefined` today: the per-branch state channel is unused and free to hold cache bookkeeping. | `ModelRoute` in `pi-coding-agent/dist/core/virtual-models.d.ts`; `extensions/account-router.ts:819-853` |
| F10 | The repo already has a cache-health surface (sidebar + web "Cache") that reports hit rate **globally**. It cannot attribute a miss to the router's own choice. | `lib/cache-stats.ts`, `extensions/cache-stats.ts` |

## 2. Problem

A provider cache is scoped to the account and model that wrote it, and to an
exact prefix. Re-sending a 60k-token conversation to a *cold* target costs, at
the ratios `lib/cache-stats.ts` already documents (read ≈ 10% of input price,
write ≈ 125%):

| Request | Prompt cost on 60k tokens, $3/M input | Relative |
| --- | --- | --- |
| warm (cache read) | 60k × $0.30/M = **$0.018** | 1× |
| cold first request (cache write) | 60k × $3.75/M = **$0.225** | **12.5×** |
| provider with no caching at all | 60k × $3.00/M = **$0.180** | 10× |

So the cost of a routing decision is not the model's price. It is
`price × (is the prefix still cached there?)`, and today the router answers that
question by accident:

1. **Rotation is a 12.5× multiplier** on the prompt half of every request it
   touches (F2, F4). A 20-turn session that rotates on each turn pays $4.50 for
   its prompt where staying warm pays $0.36.
2. **Price-chasing can cost more than it saves** (F3). A target that is 1.2×
   cheaper needs 60+ warm turns to repay one cache write; one that is 5× cheaper
   repays it in about 3. The router cannot tell the two apart.
3. **Nobody can see it** (F10). The sidebar says "42% hit"; it cannot say "the
   router moved you to `openai/gpt-6` on turn 3 and that cost $0.21".

None of this is a bug in the existing methods: they are documented to do exactly
this. It is a missing dimension — price and rotation are both *stateless*
policies, and the dominant cost term is stateful.

## 3. Goals

- **G1 — Cache is a first-class routing input.** Target *and* account selection
  consider whether the prefix is still warm there, using only data the router
  already receives.
- **G2 — Cost, not price.** Decisions compare expected cost of the next request
  (and the ones after it) including cache read/write prices, not catalog price
  alone.
- **G3 — Hysteresis by default.** A warm target is not abandoned for a cheaper
  cold one unless the saving repays the cache write within a configurable
  horizon. Default horizon: 3 turns, i.e. the candidate must be ~5× cheaper.
- **G4 — Opt-in, never a surprise.** Every existing config routes exactly as it
  does today. New behaviour arrives as `method: "cache"` and
  `pools.<name>.cacheAffinity`.
- **G5 — Explainable.** `/router status` shows warmth per target and account;
  `/router why` shows why the last request went where it did.
- **G6 — Cheap.** No extra requests, no provider API calls, no new config file.

## 4. Non-goals (v1)

- **Managing `cache_control` markers.** That is `lib/cache-anchor.ts`'s job and
  it already plans all four. The router reads the *result* (reported usage) and
  must not touch the payload.
- **Cache pre-warming.** Sending a throwaway request to make a target warm costs
  money to save money; refused for the same reason `fastest` is refused.
- **Cross-session warmth.** Another session has another prefix; only the learned
  TTL is shared globally.
- **Changing `cheapest`, `round-robin` or `last-good` semantics.** They gain
  warnings, not new behaviour.
- **Choosing a model outside the configured chain.** The router ranks what the
  route lists; it never invents a target.
- **Predicting provider TTLs exactly.** Defaults are priors; the ledger corrects
  them from observed hits and misses.

## 5. The model

### 5.1 Cache identity

A cache entry is scoped to `(account or org, model, prefix)`. The router keys on
the pair it already sees in every response:

```ts
type CacheIdentity = { provider: string; modelId: string }; // `${provider}/${modelId}`
```

`provider` is the **reported** provider, so a pooled request keys on the account
(`antigravity-2/gemini-3-pro`) and a plain target on its own provider
(`openai/gpt-6`). Two accounts of one provider are two cache identities — which
is the whole point of F4.

### 5.2 Warmth ledger

Per branch, per cache identity. Updated only by a *successful* response
(`stopReason` not `error`/`aborted`, the rule `cache-stats.ts` already applies):

```ts
type Warmth = {
  lastAt: number;            // last observed request
  lastHitAt?: number;        // last request that read > 0 cached tokens
  lastWriteAt?: number;      // last request that wrote > 0
  prefixTokens: number;      // input + cacheRead + cacheWrite of that request
  readTokens: number;
  reportsCache: boolean;     // false once a repeat prefix reports 0/0 (F10's "provider reports no cache")
  ttlFloorMs?: number;       // a hit at +X proves TTL ≥ X
  ttlCeilMs?: number;        // a miss on an *unchanged* prefix at +Y proves TTL ≤ Y
  misses: number;            // consecutive misses on an unchanged prefix
};
```

`isWarm` = `now − (lastHitAt ?? lastWriteAt) < min(ttl, ttlCeilMs ?? ttl)` with
`reportsCache` true. `ttlCeilMs` is the only reliable expiry signal and comes
from `diverge(previous, current)`: **a miss whose `changedFields` is empty and
whose `sharedItems` equals the previous item count is proof the entry expired**,
not that the prefix changed.

Storage: **`ModelRoute.state`** (per branch, JSON, restored with the branch).
That is where warmth belongs — it is a property of one conversation's prefix —
and it sidesteps the branch/disk split that `persist()` currently gets wrong for
account health. The learned TTL table is the only global record, one small file
next to the state file.

### 5.3 Cost of a decision

For target `u` with prefix `P`, delta `d` (new tokens this request), and prices
per token:

```text
cold(u)     = P·writePrice(u) + d·inputPrice(u)     // one request, then warm
warm(u)     = P·readPrice(u)  + d·inputPrice(u)
stay(t,H)   = H · warm(t)                            // H = turns in the horizon
move(t,u,H) = cold(u) + (H−1) · warm(u)
switch      ⇔  move(t,u,H) < stay(t,H)
```

`d` cancels out of the comparison when prices are equal, which is why the rule
reduces to a price-gap threshold:

```text
N = (writePrice(u) − readPrice(u)) / (readPrice(t) − readPrice(u))
with read = 0.1·input and write = 1.25·input:
N = 11.5·input(u) / (input(t) − input(u))
```

| Gap `input(t)/input(u)` | Break-even turns `N` | Verdict at `H = 3` |
| --- | --- | --- |
| 1.2× | 57.5 | stay |
| 2× | 11.5 | stay |
| 4× | 3.8 | stay (borderline) |
| 4.8× | 3.0 | break-even |
| 10× | 1.3 | switch |

Solving the same inequality for `H` gives the rule of thumb in G3: a three-turn
horizon only moves off a warm target when the candidate is about **5× cheaper**
(4.8× exactly). Anything under that gap stays, which is the behaviour a
`cheapest` route cannot express. `lib/provider/cache-routing.ts` implements this
exact form; the price-gap figures above are what `switchVerdict` returns.

When the current target is **cold** the write premium is already paid or already
lost, so the comparison degenerates to price — `method: "cache"` on a cold chain
must behave exactly like `cheapest`. That keeps the method honest: it only
changes a decision when a warm entry exists.

### 5.4 Guards

| Guard | Rule |
| --- | --- |
| Small prefix | `prefixTokens < minCacheableTokens` (default 1024) → cache logic off, plain price order. A short session must not pay a premium for a cache the provider would not store anyway. |
| No cache reported | `reportsCache === false` → `writePrice := inputPrice`: switching is free in cache terms and price wins. |
| Mid-turn | Continuations never re-decide (`routeDecision` already returns `head: "previous"`). No change. |
| Failure | A failed or cooling target is still dropped immediately. Correctness beats cache; a 429 also reports no usage, so it must not update the ledger. |
| Overflow / compaction | Both mean the prefix no longer exists → clear the branch ledger for that route. |
| Probe | The recovery probe already sets `cacheRetention: "none"`; it must not write a ledger entry. |
| Unknown price | A model the catalog cannot price sorts last, as today. |

## 6. Requirements

### R1 — Observe (no behaviour change)

Subscribe to `message_end`, resolve `(provider, modelId)` to route targets with
the existing `targetMatches`, and fold `usage` into the branch ledger via a pure
`observe(prev, sample, at)`. Pooled requests are observed through the same path,
so pooled and plain targets need no separate code. Also fold the ledger from
`ctx.sessionManager` on `session_start`/`session_tree` so a resumed branch is
warm-aware immediately.

**Accept.** Two identical-prefix requests produce one ledger entry with
`readTokens > 0` on the second, and `/router status` prints it. No routing
decision changes.

### R2 — Cost model (pure)

New `lib/provider/cache-routing.ts`: `cacheKey`, `emptyWarmth`, `observe`,
`isWarm`, `warmPrice`, `coldPrice`, `switchVerdict`, `rankByCache`,
`describeWarmth`. Pure, no Pi imports, no clock of its own (`now` injected).

**Accept.** Unit tests pin the break-even table of §5.3 exactly, including the
`reportsCache: false`, small-prefix and unknown-price guards.

### R3 — `method: "cache"`

Add `"cache"` to `RouteMethod`, `ROUTE_METHODS`, `METHOD_LABELS`,
`METHOD_HINTS`; `orderTargets` gains a case that ranks by `rankByCache` (warm
first, then by effective cost, ties in declaration order). `TargetFacts` grows
the cache fields it needs; `model-routes.ts` stays pure.

**Accept.** With a warm `primary` (10× more expensive) and a cold `secondary`:
`H = 1` keeps `primary`; `H = 3` moves to `secondary` (break-even is 1.3 turns);
when `primary`'s entry has expired both orders agree with `cheapest`.

### R4 — Cache-aware pool affinity

`selectAccount` gains an optional `warm?: (accountId: string) => boolean`. When
set, a warm account is preferred over a cold one *before* the strategy's own
ordering, so `round-robin`/`least-recently-used` rotate only when the cache is
cold or the warm account is unusable. `acquire` supplies it from the ledger.

Config: `pools.<name>.cacheAffinity?: "off" | "warm"` — default `"off"` for
`round-robin`/`least-recently-used` (their point is spreading), `"warm"` for
`sticky`/`priority` (where sticking is already intended and the cache makes it
cheaper). Opt-in for the rest, because it changes how fast a pool spends quota.

**Accept.** With `cacheAffinity: "warm"`, three successive prompts under a 5m TTL
use one account; after the TTL elapses the pool rotates; a quota wall rotates
immediately regardless.

### R5 — Deliberate rotation (opt-in)

`pools.<name>.rotateAfterRequests?: number` — stay warm for at most N requests,
then rotate once despite warmth, to spread quota. Documented as a cache sacrifice
with the arithmetic of §5.3. Default off.

**Accept.** `rotateAfterRequests: 5` rotates on the 6th request and the ledger
shows the write.

### R6 — Warnings for cache-hostile policies

`routeIssues` (pure) gains cache findings, shown in `/router status` and the
editor:

| Config | Warning |
| --- | --- |
| `method: "round-robin"` + `when: "turn"` | `rotates the head every turn; each turn re-writes the prompt cache (≈12× prompt cost)` |
| `method: "cheapest"` + 2+ targets | `a price gap under ~5× costs more in cache re-writes than it saves; consider method: "cache"` |

**Accept.** Both appear for the config that triggers them and for nothing else;
a `round-robin` route with `when: "failure"` warns about nothing.

### R7 — `/router why`

Keep a bounded (32) ring buffer of the last decisions:
`{ at, route, reason, chosen, chain, warm, rejected: [{ target, why }] }`.
`/router why` prints it; the editor shows the last line in its header.

**Accept.** A fallback shows the failed target, its error class and the chosen
one; a cache-driven *non*-switch shows `stayed: cache warm on primary (2m left)`
— the decision that would otherwise be invisible.

### R8 — Docs and parity

`docs/accounts.md` gains the method row, the pool keys and the warning table;
`docs/token-efficiency.md` gains the routing rule next to the existing "a pool
keeps its account for a whole agent run" bullet, which this PRD supersedes with a
TTL-scoped rule. Web parity: the `account-router` opt-out text in
`web/plugins/index.ts` ("no persistent view") becomes stale once `/router why`
exists — either the view ships or the text is corrected.

## 7. Config surface

```json
{
  "routes": [
    { "name": "auto", "method": "cache",
      "targets": ["antigravity/gemini-3-pro", "openai-codex/gpt-6-astra"] }
  ],
  "pools": {
    "or": { "provider": "openrouter", "strategy": "round-robin",
            "cacheAffinity": "warm", "rotateAfterRequests": 20,
            "accounts": [{ "id": "personal", "apiKey": "$OPENROUTER_KEY_1" }] }
  },
  "cache": {
    "horizon": 3,
    "minCacheableTokens": 1024,
    "ttlMs": { "anthropic": 300000, "*": 300000 }
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `cache.horizon` | `3` | Turns a switch must repay itself over. `1` = never switch a warm target. |
| `cache.minCacheableTokens` | `1024` | Below this, cache logic is off. |
| `cache.ttlMs.<provider>` / `"*"` | `300000` | Prior TTL; the ledger's `ttlCeilMs` overrides it downward. |
| `cache.writeRatio` / `readRatio` | `1.25` / `0.1` | Used only when the catalog reports `cacheWrite`/`cacheRead` as 0. |
| `pools.<n>.cacheAffinity` | strategy-dependent | `"warm"` or `"off"`. |
| `pools.<n>.rotateAfterRequests` | off | Deliberate rotation despite warmth. |

Validation lives in the existing normalizers (`normalizePool`, and a `cache`
reader beside `readRouteTable`), so a typo becomes a `configErrors` line instead
of a silent default. `cache` is a top-level key like `routes`/`pools` and must
survive `saveRoute`'s read-modify-write.

## 8. Surfaces

`/router status` gains one column per target and per account:

```text
router/auto: cache · on failure
  antigravity/gemini-3-pro     warm 58k · 2m left · 94% hit
  openai-codex/gpt-6-astra     cold · last 6m ago
Pools:
  or → openrouter (round-robin, 2/2 usable, cacheAffinity warm)
    personal   warm 58k · 1m left
    work       cold · never used
```

`/router why` and the editor header show the last decision (R7). The sidebar's
Cache section is unchanged; `cache-stats` already reports hit rate, and this PRD
adds *attribution*, not another meter.

## 9. Delivery

Each phase is one commit, gate-green (`npm run tidy`), reversible on its own.

| # | Commit | Contents | Landed as |
| --- | --- | --- | --- |
| P0 | `feat(router): observe prompt-cache usage per target` | ledger + `observe`/`isWarm` + status column + tests. No decision change. | `2fa208c` |
| P1 | `feat(router): cache-aware routing method` | cost model + `method: "cache"` + break-even tests. | `94aee79` |
| P2 | `feat(router): cache-aware pool affinity` | `selectAccount` warm option, `cacheAffinity`, `rotateAfterRequests`. | `e9bc0f0` |
| P3 | `feat(router): warn about cache-hostile policies` | `routeIssues` findings + editor rows. | `a729127` |
| P4 | `feat(router): /router why` | decision ring buffer + command. | `717ee11` |
| P5 | `docs: cache-aware routing` | `accounts.md`, `token-efficiency.md`, opt-out text. | this commit |

Delivered as specified, with two corrections found while implementing:

- **The break-even algebra** in §5.3 ignored the candidate's own read in the
  first turn. The crossing is `(write(u) − read(u)) / (read(t) − read(u))`, which
  is 11.5 rather than 12.5 times the price gap; the table now shows the values
  `switchVerdict` returns. The "~5× cheaper at a 3-turn horizon" rule of thumb is
  unchanged (4.8× exactly).
- **A pooled request reports the pool's provider, not the account** (F6 was
  optimistic): `physical.provider` is the account id only when a provider is
  registered under it. Warmth is therefore attributed to the account that
  answered through the stream's own in-flight slot, which the message then
  consumes. A plain target keys on its reported provider, as described.

P0 and P1 are useful alone. P2 is the one with a quota-spend trade-off and ships
last among the behaviour changes so it can be measured on its own.

## 10. Tests

**Unit (new `tests/provider/cache-routing.test.ts`).** The break-even table of
§5.3 as one parameterised case per row; `observe` folding (hit, miss,
write-only, error, aborted, probe); `reportsCache` turning off;
`minCacheableTokens` bypass; `ttlCeilMs` learned from a miss on an unchanged
prefix and *not* learned when `diverge` reports a changed field; `rankByCache`
ties.

**Unit (existing suites).** `orderTargets` `cache` case and `selectAccount` warm
preference in `tests/provider/account-pools.test.ts`; `routeIssues` warnings in
`tests/provider/router-settings.test.ts`.

**Integration (`tests/account-router-runtime.test.ts`).** Extend the scripted
provider to report `cacheRead`/`cacheWrite` from a per-key warm flag, then pin:
round-robin pool + `cacheAffinity: "warm"` keeps one account across prompts;
after the TTL it rotates; a quota wall still rotates at once; `method: "cache"`
keeps a warm expensive target; compaction clears the ledger; a resumed branch
still knows its warmth (this one also guards the storage choice).

**Economics (`tests/provider/cache-economics.test.ts`).** A deterministic 20-turn
simulation over the cost model asserting cache-aware total ≤ cheapest total in
every scenario, and round-robin+turn ≥ 5× cache-aware. This is the guard against
a future "optimisation" that quietly reintroduces the 12.5×.

**Non-regression.** Every existing router test keeps passing unmodified; the
default `method` stays `priority`; a config with no `cache` block routes exactly
as today.

**Not covered.** Real provider TTLs and real cache prices — the model is only as
good as `ttlMs` and the catalog's cache prices, and no test can prove a vendor's
current behaviour.

## 11. Risks

| Risk | Mitigation |
| --- | --- |
| Ledger drift: warmth believed warm, provider says cold. | The next miss corrects it (`ttlCeilMs`, `misses`); a wrong belief costs at most one cold request, and `cacheAffinity` is opt-in. |
| The state blob grows with every target and account seen. | Cap at 32 entries per branch, evicting the coldest; it is a few KB. |
| A provider that reports cache tokens inconsistently flips the ledger. | `reportsCache` requires two consecutive identical-prefix observations before warmth is trusted; a single 0/0 turns cache logic off rather than on. |
| Affinity starves one account and burns its quota. | Off by default for `round-robin`/`lru`; `rotateAfterRequests` bounds it; failures still rotate immediately. |
| The comparison misleads on unknown prices. | Unknown price sorts last and `describeWarmth` prints `–` rather than a fabricated saving. |

## 12. Open questions

- **Q1 — Horizon default.** `3` is derived from a ~5× price gap, which fits a
  premium→cheap fallback chain. Should it instead default to the route's own
  measured mean turns-remaining? Needs data from real sessions first.
- **Q2 — Warmth scope.** Per branch is proposed because a branch is a prefix. Is
  per *project* ever right? Two sessions on one repo share nothing, so no.
- **Q3 — Compaction.** Clearing the whole ledger is safe but pessimistic; a
  post-compaction summary may keep a short shared prefix. Measure before
  optimising.
- **Q4 — Should `method: "cache"` become the default for routes the editor
  creates**, while existing configs keep `priority`? Leans yes once P1 has data.
- **Q5 — Web surface.** Does `/router why` belong in the web plugin (F10's
  attribution) or is the TUI enough for v1?
