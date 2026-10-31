# Account router

> Part of [pi-workflow-extensions](../README.md). Pool several accounts per provider and route per request.

Command: **`/router`**. Routes each request to any registered provider/model, and spreads one provider across several accounts. Works for **every** provider Pi knows about — built-in, `models.json`, or extension-owned — with no provider-specific code.

```text
/router                    # the route editor (TUI); the status report elsewhere
/router status             # routes, policies and pools as text
/router accounts [pool]    # per-account health
/router use <pool> <id>    # pin a pool to one account
/router reset [pool]       # clear failures, cooldowns and pins
/router reload             # re-read config files
```

Two independent layers, both optional:

- **Routes** — a virtual model `router/<name>` that dispatches to an ordered fallback chain of `provider/model` targets. Pick it in `/model` like any model.
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
            "strategy": "round-robin", "cooldownMs": 60000 },
    "or": { "provider": "openrouter", "strategy": "least-recently-used",
            "accounts": [{ "id": "personal", "apiKey": "$OPENROUTER_KEY_1" },
                         { "id": "work", "apiKey": "$OPENROUTER_KEY_2" }] }
  }
}
```

**Routing.** A target is `provider/modelId`; a model id may contain slashes (`openrouter/meta/llama-3`). A failed target moves to the end so the retry tries the next model. Tool continuations stay on the model that answered the turn, which keeps prompt caches and thinking signatures valid; set `"sticky": false` on a route to opt out. A target may pin a `thinking` level.

**Routing methods** (`method`, default `priority`) decide the order of the candidates:

| Method | Order |
| --- | --- |
| `priority` | Declaration order; the first usable target wins. |
| `round-robin` | Rotate the head on each user turn; the cursor rides in the router state. |
| `cheapest` | Ascending catalog price (input + output). A model the catalog cannot price sorts last, and equal prices keep declaration order. |
| `last-good` | The model that answered the previous turn goes first (last known good provider). |

**Triggers** (`when`, default `turn`) decide whether that ordering is applied again:

| Trigger | Behaviour |
| --- | --- |
| `turn` | Re-decide on every user request; continuations stay on the answering model; a retry advances past the failed target. |
| `failure` | Keep the answering model across user turns; only a retry moves on. |
| `quota` | Like `failure`, but a retry moves on only when the failure is a quota wall/`429`; anything else retries the same target. |
| `overflow` | Like `failure`, but a retry moves on only after a context overflow. |

Ordering happens before advancing, so a `cheapest` route cannot re-pick the model that just failed for being cheapest. A trigger's quota/overflow condition is judged from the failed request's own error message, which is the only place it is visible. `fastest` is deliberately absent: the extension only wraps pooled requests, so it cannot measure latency for a plain route target, and a method that guessed would be worse than none.

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
- A chain target may be pointed at a pool, so the pool's own strategy and account health stay in play behind the route.
- Existing routes are rewritten **in the file they came from**. A global route hidden by a project override is listed as shadowed, and deleting the override says the global route is active again.
- A route cannot lose its last target, and nothing is written until at least one model is chosen, so cancelling the picker leaves the config untouched.
- Saving reloads the routes and unregisters a deleted or renamed virtual model, so `/model` never lists a route that no longer exists. A config file that is not a JSON object is refused rather than overwritten, and `pools`, `provider` and unknown keys survive every edit.

The text command still works everywhere (`/router status`), so RPC and print mode keep a copyable report.

**Pools.** Strategies: `round-robin`, `least-recently-used`, `priority` (declaration order) and `sticky` (hold one account). Sources: `antigravity-accounts` reads the linked Google logins from the account store (no explicit `accounts` list needed — every linked login is used, and expired tokens are refreshed through the vendored provider), and `static` (the default) uses each account's own `apiKey` expression: a literal, `$ENV`/`${ENV}`, or a leading `!command`. `$$` and `$!` escape those prefixes. Secrets are resolved inside the request path and never printed by `/router`.

A quota/rate-limit failure (`429`, `resource_exhausted`, …) quarantines the account for at least `cooldownMs` (default `60000`), honoring longer provider reset hints such as `Please wait 54h10m43s`. Cooling accounts are never used, even when the entire pool is exhausted. After the deadline, the next request selecting that account first sends a tiny `Reply OK.` recovery probe to the **same model/account**, with no conversation or tools, reasoning off, a 16-token output cap and a 15-second timeout. A failed probe renews cooldown and moves on to another eligible account; a successful probe restores normal traffic and stops further tests until another quota failure. Probes are demand-driven, not background polling, and their usage is included in the resulting response. `maxConsecutiveFailures` (default `3`, `0` disables) retires accounts after other repeated failures; quota recovery remains possible beyond that budget. Health and pins persist in the branch and in `<agent-dir>/account-router-state.json` (`0600`, atomic), including the pending-probe flag, so a restart does not re-hammer a dead account.

Health is tracked for **any** provider, not just Antigravity: a pool is exposed as a shadow provider that replaces each request's credential with the selected account's, using the request-scoped API key Pi already treats as an override. One shadow provider is registered per API group of the base provider, because Pi dispatches an extension's `streamSimple` only for a matching `api`. A pool does not modify `auth.json`, does not touch the active login, and never rotates a token on disk.

A pool whose `provider` names an **account family** (`"provider": "antigravity"` with providers `antigravity-1`, `antigravity-2`, …) uses that family's catalog and dispatches through a member, so one route or pool config keeps working as accounts are linked or removed. Per-account providers hand the pool's per-request credential to the vendored stream, so the account the pool selected is the account billed.

Route targets and pools are additive to the existing `/provider` wizard: use `/provider` to define a custom endpoint, then a pool or route to share or fall back across it. Errors are reported, never silently ignored: `/router` lists config warnings and the last error, and a route with no usable target fails the request with the reason instead of picking something arbitrary.

Verification: `node --experimental-strip-types --import ./tests/isolate-env.mjs --test tests/account-pools.test.ts tests/account-sources.test.ts tests/model-routes.test.ts tests/router-config-write.test.ts tests/router-settings.test.ts tests/router-settings-popup.test.ts tests/account-router-runtime.test.ts` covers config validation and projects-over-global merging, every selection strategy, cooldowns, failure budgets, exhaustion, state persistence and permissions, corrupt-state recovery, static/`antigravity-accounts` credential resolution, token refresh and re-login errors, routes and fallback chains, **the four routing methods and the full trigger matrix**, the route writer (pools and unknown keys preserved, broken files refused, atomic writes), the editor popup (keys, refusals, narrow terminals), plus **real Pi sessions** proving that a pool rotates accounts across requests, that a `429` cools one account and the next request succeeds on another, that a route skips an unavailable provider, that `cheapest` outranks declaration order, that a `round-robin` route rotates across user turns, that `when: "failure"` keeps the answering model, that a deleted route is unregistered, and that `/router` reports status headlessly. Tests use fixture credentials and stub providers; no real inference or account is used.
