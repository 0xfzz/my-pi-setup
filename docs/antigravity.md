# Antigravity accounts as providers

> Part of [pi-workflow-extensions](../README.md). One provider per linked Google account, with the vendored provider.

Command: **`/antigravity`**. Registers **one provider per linked Google account**, so several Antigravity logins appear as separate models in Pi's own `/model` picker — no account-switching extension, no single shared `antigravity` provider.

```text
/antigravity                 # list accounts and their provider ids
/antigravity login           # link another Google account
/antigravity remove <id>     # unlink an account (others renumber)
/antigravity refresh         # refresh access tokens now
/antigravity help            # usage
```

**Why one provider per account.** A single provider can only hold one credential, so switching accounts used to mean a manual switch that the model picker could not express. With `antigravity-1`, `antigravity-2`, … each account is an ordinary Pi model target: pick it in `/model`, name it in a route, or let a pool rotate it. Numbering is **stable link order** (ties broken by account id), so ids only change when an account is actually added or removed — and removal renumbers, because the numbers are positional slots, not identities. `/antigravity` always lists the current mapping.

An account with no refresh token cannot be used, so it does not occupy a slot. A malformed, empty or missing store is reported as zero accounts, never as an error at startup. Each provider exposes the same model catalog; only the credential differs.

**Credentials are never shared.** Every request refreshes its own account's token (persisting the new one behind a mode `0600` atomic write) and passes only that account's credential to the stream. A token is never read from, or written to, another account's slot, and nothing is printed by `/antigravity` except account labels and provider ids.

**No silent account switching.** Upstream `pi-antigravity` fails a `429` over to the next linked account, which rewrites the global active login. That contradicts a provider pinned to one account, so this extension sets `ANTIGRAVITY_NO_ACCOUNT_FAILOVER=1`: a quota wall surfaces as a quota error on the account you chose instead of quietly changing accounts. Use a pool if you actually want rotation.

**No npm dependency.** The provider is vendored under `vendor/antigravity/` — see [`VENDORED.md`](../vendor/antigravity/VENDORED.md) for the exact delta from upstream and the re-vendoring steps. It is not loaded as an extension itself, so there is exactly one owner of the provider ids.

Verification: `node --experimental-strip-types --import ./tests/isolate-env.mjs --test tests/antigravity-accounts.test.ts` covers provider-id mapping, stable ordering, malformed/empty stores, per-slot credential isolation, project derivation, token freshness skew, and **real Pi sessions** proving each linked account registers as its own provider with chat models and configured auth, that no bare `antigravity` provider exists, and that an unlinked install registers nothing and still loads. Tests use fixture credentials; no real inference or account is used.
