# Account router

> Part of [pi-workflow-extensions](../README.md). Pool several accounts per provider and route per request.

Command: **`/router`**. Routes each request to any registered provider/model, and spreads one provider across several accounts. Works for **every** provider Pi knows about — built-in, `models.json`, or extension-owned — with no provider-specific code.

```text
/router                    # the route editor (TUI popup, or the web's Router page)
/router status             # routes, policies and pools as text
/router accounts [pool]    # per-account health and prompt-cache warmth
/router why                # why the last requests went where they did
/router use <pool> <id>    # pin a pool to one account
/router reset [pool]       # clear failures, cooldowns and pins
/router reload             # re-read config files
```

Two independent layers, both optional:

- **Routes** — a virtual model `router/<name>` that dispatches to an ordered fallback chain of `provider/model` targets. Pick it in `/model` like any model. When `enabledModels` in `settings.json` is a curated list, the router adds `router/*` to it on session start (printing a `/reload` hint), so routes are not hidden from `/model` and Ctrl+P; an unset or empty list already shows everything.
- **Pools** — a set of accounts for one provider, rotated by strategy, so several Google logins (or several API keys) share one provider.

Config is read from the global `<agent-dir>/account-router.json` and then the project `.pi/account-router.json`; a project entry wins per route or pool name.

```json
{
  "routes": [
    { "name": "auto", "targets": ["antigravity/gemini-3-pro", "openai-codex/gpt-6-astra"],
      "method": "cheapest", "when": "quota" },
    { "name": "cheap", "targets": [{ "model": "antigravity/gemini-3.8-flash", "pool": "ag" }] }
  ],
  "pools": {
    "ag": { "provider": "antigravity", "source": "antigravity-accounts",
            "strategy": "round-robin", "cacheAffinity": "warm", "cooldownMs": 60000 },
    "or": { "provider": "openrouter", "strategy": "least-recently-used",
            "accounts": [{ "id": "personal", "apiKey": "$OPENROUTER_KEY_1" },
                         { "id": "work", "apiKey": "$OPENROUTER_KEY_2" }] }
  },
  "cache": { "horizon": 3, "minCacheableTokens": 1024,
             "ttlMs": { "anthropic": 300000, "*": 300000 } }
}
```

**Routing.** A target is `provider/modelId`; a model id may contain slashes (`openrouter/meta/llama-3`). A failed target moves to the end so the retry tries the next model. Tool continuations stay on the model that answered the turn, which keeps prompt caches and thinking signatures valid; set `"sticky": false` on a route to opt out. A target may pin a `thinking` level.

**Failover during an agent request does not depend on automatic retry being enabled.**
Pi's normal retry/backoff runs first. If it declines an error (for example an
invalid credential) or exhausts its retry budget, the router continues the
original request on a remaining usable target. Recovery tracks failures within
that request and stops when no remaining target can resolve; it never loops
through the same exhausted chain indefinitely. Cancelling a request never starts
fallback. The virtual `router/<name>` stays selected while the sidebar follows
the physical target. Raw failure entries remain in session history, but are
omitted from the backup model's context. Direct model-registry calls outside the
agent loop still rely on the caller's retry policy.

**Routing methods** (`method`, default `priority`) decide the order of the candidates:

| Method | Order |
| --- | --- |
| `priority` | Declaration order; the first usable target wins. |
| `round-robin` | Rotate the head on each user turn; the cursor rides in the router state. |
| `cheapest` | Ascending catalog price (input + output). A model the catalog cannot price sorts last, and equal prices keep declaration order. |
| `last-good` | The model that answered the previous turn goes first (last known good provider). |
| `cache` | Ascending *expected* cost: a target that still holds this conversation's prompt cache is kept unless a cheaper one repays its cache write inside `cache.horizon`. On a cold chain it is exactly `cheapest`. |

**Triggers** (`when`, default `turn`) decide whether that ordering is applied again:

| Trigger | Behaviour |
| --- | --- |
| `turn` | Re-decide on every user request; continuations stay on the answering model; a retry advances past the failed target. |
| `failure` | Keep the answering model across user turns; only a retry moves on. |
| `quota` | Like `failure`, but a retry moves on only when the failure is a quota wall/`429`; anything else retries the same target. |
| `overflow` | Like `failure`, but a retry moves on only after a context overflow. |

These trigger restrictions apply to final-boundary recovery too: `quota` does
not fall back for an authentication error, and `overflow` does not fall back for
a rate limit. Use `turn` or `failure` to advance for any provider error.

Ordering happens before advancing, so a `cheapest` route cannot re-pick the model that just failed for being cheapest. A trigger's quota/overflow condition is judged from the failed request's own error message, which is the only place it is visible. `fastest` is deliberately absent: the extension only wraps pooled requests, so it cannot measure latency for a plain route target, and a method that guessed would be worse than none.

## Editing routes

A route is a model, so it is edited where models are. There are three
surfaces over one route table, and none of them owns a copy of it.

**In the TUI**, bare `/router` opens a popup — the route list, then one route,
its chain, method, trigger, and the model picker for adding targets. It writes
through the same writer as everything else and never edits a file in place.

**In the web**, two surfaces over the same table:

- **The right sidebar** has a **Router** panel showing only the selected route:
  a hub on the left fans out through curved connections to model pills on the
  right. The latest chosen target and its connection use the web theme's accent,
  with inverse text and a moving dot along the selected branch. Colors follow
  the app's shared tokens in both light and dark mode. Each routing decision updates the diagram live
  without moving its nodes or resetting the viewport. The canvas fills the
  sidebar; drag to pan, scroll or use the small overlay controls to zoom, and
  **Fit** restores the whole diagram. Hover a node for its full model reference
  and cache detail. This is visualization only — no editor, warning list or
  config-action section. Select a physical model and the panel asks you to
  select a route instead of displaying an unrelated route. Open it from
  **More panels → Router**. Animation respects reduced-motion preferences.
- **The model picker's dialog** has a **Router** page beside **Models** and
  **Provider**, with the same table and the same writer, laid out as four
  screens:

| Screen | What it does |
| --- | --- |
| Routes | One row per route: its policy, its chain, and anything wrong with it. |
| Route | Name, method, re-decide trigger, and the chain — click a model to take it out. |
| Models | The catalogue as a tick list, with a filter box for a 100-model catalogue. Ticked models keep their place — a tick stays listed even when the filter excludes it, and past the dialog's 200-row cap. |
| Delete | The confirmation. A route is a file entry, so it is never removed on one click. |

A new route is created from the same form: **New route** names it (`route-1` and
on), the file it is written to, its method and trigger, then **Choose models**
ticks the chain. The name is validated at the field — reserved words like
`status` and a name already in the table are refused with the reason, on the
same screen, keeping what was typed.

Two details are deliberate. The editor rewrites a route **where it found it**,
so editing a global route does not silently create a project override. And the
file is only chosen while creating: moving a saved route between files is a
delete plus a save, and offering it as a field would let the editor write the
new file before removing the old entry.

## Cache-aware routing

A routing decision does not cost the model's price; it costs
`price × (is the prefix still cached there?)`. Providers bill a cache read at
about 10% of the input price and a cache write at about 125%, so re-sending a
60k-token conversation to a cold target is roughly **12× the warm cost**. Two
methods and one pool key exist because of that.

**What the router observes.** Every finished message already reports
`cacheRead`/`cacheWrite`, so no extra request is made. The router folds them into
a ledger per conversation and per `(account, model)` — a cache is scoped to the
account that wrote it, so two accounts of one provider are two entries. It also
learns the provider's TTL from what it sees: a hit proves the entry lived at
least that long, and a miss on an *unchanged* prefix proves it did not live
longer. The ledger rides in the virtual model's own session state, so a resumed
branch stays warm-aware.

**`method: "cache"`.** With a warm target `t` and a candidate `u`:

```text
stay = H · read(t)                    move = write(u) + (H − 1) · read(u)
```

The route moves only when `move < stay`. At the default `cache.horizon` of 3
turns that means a candidate has to be about **5× cheaper** (4.8× exactly) before
a warm target is abandoned: a 1.2× cheaper model needs 57 warm turns to repay one
write, a 2× one needs 11.5. With nothing warm the comparison degenerates to
price, so the method behaves like `cheapest` until a cache exists.

**`pools.<name>.cacheAffinity`.** `"warm"` keeps the account that holds the
cache; `"off"` rotates as configured. Unset follows the strategy's intent — warm
for `sticky`/`priority`, off for `round-robin`/`least-recently-used` — so a pool
that exists to spread quota keeps spreading until it opts in. A cooling or
failed account is dropped first: correctness beats cache.
`pools.<name>.rotateAfterRequests` bounds how long one account is held: after
that many consecutive requests the pool moves on once, so affinity cannot starve
the accounts it is not using.

| `cache` key | Default | Meaning |
| --- | --- | --- |
| `horizon` | `3` | Turns a switch must repay itself over. `1` never leaves a warm target. |
| `minCacheableTokens` | `1024` | Below this prompt size the provider would not cache it, so cache logic is off. |
| `ttlMs.<provider>` / `"*"` | `300000` | TTL prior; an observed miss lowers it. |
| `readRatio` / `writeRatio` | `0.1` / `1.25` | Used only when the catalog reports no cache prices. |

`cache` is one document, not a per-name map: a project file that omits it does
not reset the global one.

**Warnings.** `/router status` and the editor flag a policy that fights the
cache, because the cost is invisible in a request:

| Config | Warning |
| --- | --- |
| `method: "round-robin"` + `when: "turn"` | rotates the head every turn; each turn re-writes the prompt cache (≈12× prompt cost) |
| `method: "cheapest"` + 2 or more targets | a price gap under ~5× costs more in cache re-writes than it saves; consider `method: "cache"` |

**Visibility.** The web editor shows a target's warmth in the model list, from
the same ledger `/router status` reads. `/router status` prints warmth per target and per account
(`warm 58k · 2m left · 94% hit`, `cold · last 6m ago`, `no cache` when the
provider reports none), and `/router why` explains the last 32 decisions,
including the cache-driven *non*-switch that would otherwise be invisible:

```text
2m ago · auto · user · → primary/main-model · stayed: cache warm (warm 58k · 3m left · 94% hit)
```

**The editor.** Bare `/router` in the TUI opens the routes themselves:

```text
╭ Router routes ───────────────────────────── Esc close ╮
│ workspace  /home/you/project                         │
│ config     .pi/account-router.json                   │
│ pools      ag                                        │
│                                                      │
│ ROUTES                                               │
│ › router/auto  cheapest · on quota  2 models · project│
│     antigravity/gemini-3-pro → openai/gpt-6          │
│   + add a route…                                     │
╰──────────────────────────────────────────────────────╯
```

- `a` adds a route: a name (a free one is suggested, names are validated before the next screen), then where it is saved — this workspace's `.pi/account-router.json` or the agent-dir one — then the model picker.
- `Enter` opens a route: add models from the live catalog (or type `provider/model` for a model the catalog does not know), reorder or remove targets, cycle the method with `m` and the trigger with `w`, set a target's thinking level and account pool, rename it, delete it.
- The model picker lists **the same models `/models` lists** — those whose provider has working credentials, not every registered one — and shows the same facts beside each (context, output limit, thinking, images). A target the catalog offers but the runtime cannot authenticate would fail its first request, so it is not offered. The router's own routes and pool shadow providers are the only things hidden: a route targeting a route would loop, and a pool is set on the target instead so its strategy and health still apply. The picker draws in the same popup frame as the rest of the editor (search, count, position in the title, one hint line), and degrades to plain rows only below the height where the frame cannot hold a single model.
- A chain target may be pointed at a pool, so the pool's own strategy and account health stay in play behind the route.
- Existing routes are rewritten **in the file they came from**. A global route hidden by a project override is listed as shadowed, and deleting the override says the global route is active again.
- A route cannot lose its last target, and nothing is written until at least one model is chosen, so cancelling the picker leaves the config untouched.
- Saving reloads the routes and unregisters a deleted or renamed virtual model, so `/model` never lists a route that no longer exists. A config file that is not a JSON object is refused rather than overwritten, and `pools`, `provider` and unknown keys survive every edit.

The text command still works everywhere (`/router status`), so RPC and print mode keep a copyable report.

**Sidebar.** The sidebar `account` section automatically supports **all configured pools**. If a single pool exists, it displays the pool's active account, position in the pool, and detailed health status. If multiple pools exist, the sidebar displays all configured pools (e.g. `Router Pools (3)`), sorting active in-flight or current model pools first and showing each pool's account, cursor count, and cooldown/probe status.

**Pools.** Strategies: `round-robin`, `least-recently-used`, `priority` (declaration order) and `sticky` (hold one account). Sources: `models-json` reads multi-account configurations (`provider-1`, `provider-2`), and `static` (the default) uses each account's own `apiKey` expression: a literal, `$ENV`/`${ENV}`, or a leading `!command`. `$$` and `$!` escape those prefixes. Secrets are resolved inside the request path and never printed by `/router`.

A quota/rate-limit/budget failure (`429`, `402`, `budget_exceeded`, `resource_exhausted`, `insufficient_quota`, …) quarantines the account for at least `cooldownMs` (default `60000`), honoring longer provider reset hints such as `Please wait 54h10m43s` or `resets in 22h 21m`. Cooling accounts are never used, even when the entire pool is exhausted. Authentication failures (`401`, `auth_error`, `invalid_token`) immediately retire the affected account without wasting retries. After the deadline, the next request selecting that account first sends a tiny `Reply OK.` recovery probe to the **same model/account**, with no conversation or tools, reasoning off, a 16-token output cap and a 15-second timeout. A failed probe renews cooldown and moves on to another eligible account; a successful probe restores normal traffic and stops further tests until another quota failure. Probes are demand-driven, not background polling, and their usage is included in the resulting response. `maxConsecutiveFailures` (default `3`, `0` disables) retires accounts after other repeated failures; quota recovery remains possible beyond that budget. Health and pins persist in the branch and in `<agent-dir>/account-router-state.json` (`0600`, atomic), including the pending-probe flag, so a restart does not re-hammer a dead account.

Health is tracked for **any** provider: a pool is exposed as a shadow provider that replaces each request's credential with the selected account's, using the request-scoped API key Pi already treats as an override. One shadow provider is registered per API group of the base provider, because Pi dispatches an extension's `streamSimple` only for a matching `api`. A pool does not modify `auth.json`, does not touch the active login, and never rotates a token on disk.

A pool whose `provider` names an **account family** (`"provider": "openrouter"` with providers `openrouter-1`, `openrouter-2`, …) uses that family's catalog and dispatches through a member, so one route or pool config keeps working as accounts are linked or removed. Per-account providers hand the pool's per-request credential to the provider's stream, so the account the pool selected is the account billed.

Route targets and pools are additive to the existing `/provider` wizard: use `/provider` to define a custom endpoint, then a pool or route to share or fall back across it. Errors are reported, never silently ignored: `/router` lists config warnings and the last error, and a route with no usable target fails the request with the reason instead of picking something arbitrary.

Verification: `node --experimental-strip-types --import ./tests/isolate-env.mjs --test tests/provider/account-pools.test.ts tests/provider/account-sources.test.ts tests/provider/model-routes.test.ts tests/provider/cache-routing.test.ts tests/provider/route-trace.test.ts tests/provider/router-config-write.test.ts tests/provider/router-settings.test.ts tests/provider/router-settings-popup.test.ts tests/account-router-runtime.test.ts` covers config validation and projects-over-global merging, every selection strategy, cooldowns, failure budgets, exhaustion, state persistence and permissions, corrupt-state recovery, static/`antigravity-accounts` credential resolution, token refresh and re-login errors, routes and fallback chains, **the five routing methods and the full trigger matrix**, the route writer (pools and unknown keys preserved, broken files refused, atomic writes), the editor popup (keys, refusals, narrow terminals), plus **real Pi sessions** proving that a pool rotates accounts across requests, that a `429` cools one account and the next request succeeds on another, that a route skips an unavailable provider, that actual provider failures fall back with retries disabled or exhausted, that recovery preserves raw history and live sidebar state, that cancellation and narrow triggers do not switch models, that exhausted chains terminate and new prompts have a fresh recovery budget, that `cheapest` outranks declaration order, that a `round-robin` route rotates across user turns, that `when: "failure"` keeps the answering model, that a deleted route is unregistered, that `/router` reports status headlessly, that a cache route keeps a warm target until a cheaper one repays its write, that `cacheAffinity` holds an account across prompts until the TTL lapses (and that a quota wall still moves at once), and that `/router why` explains a cache non-switch and a failed fallback. Tests use fixture credentials and stub providers; no real inference or account is used.
