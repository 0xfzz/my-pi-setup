# Vendored: Antigravity provider

Local copy of the Antigravity / Cloud Code Assist provider for Pi, so this
package no longer depends on the `pi-antigravity` npm package.

| | |
|---|---|
| Upstream | https://github.com/Rahularya01/pi-antigravity |
| Version | 0.11.0 |
| License | MIT — see [`LICENSE`](LICENSE) (Copyright (c) 2026 Rahul Arya) |
| Original manifest | [`UPSTREAM-package.json`](UPSTREAM-package.json) |

## Local changes

Only what is required to run as part of this package:

1. **Relative import specifiers use `.ts`.** All 29 files that imported
   `./x.js` / `../x.js` now import `./x.ts` / `../x.ts`. Upstream relies on
   `jiti` resolving `.js` to `.ts`; plain Node type-stripping does not, and this
   package is tested with `node --experimental-strip-types`. No import path,
   symbol, or module boundary was changed.
2. **No `undici` dependency.** `auth/oauth.ts` uses the runtime `fetch`
   (Node ≥ 22) instead of `import { fetch } from "undici"`, and
   `utils/http.ts` no longer constructs a custom `undici.Agent`. That file
   already skipped the custom Agent on Node ≥ 22, where `fetch` pools
   connections natively, so behaviour on supported Node versions is unchanged.
   No other file imported `undici`.
3. **`ProviderModelConfig` narrowed for Pi 1.3.** Upstream targeted Pi 0.86,
   where `ProviderModelConfig` was one chat-model interface. Pi 1.3 made it a
   union of chat, image, and classifier configs, so reading chat-only fields
   (`reasoning`, `contextWindow`, `maxTokens`, `thinkingLevelMap`) stopped
   type-checking. `types/provider-model.ts` aliases the union back to its chat
   member, and three catalog files import it from there. Types only.
4. **Implicit account failover can be disabled.** Upstream's stream calls
   `failoverToNextAccount` on a `429`, mutating the global `auth.json` active
   login. That is right for the single-provider model it was written for, but
   it would silently switch accounts behind a provider pinned to one account.
   `ANTIGRAVITY_NO_ACCOUNT_FAILOVER=1` skips that path and surfaces the quota
   error instead. Unset, behaviour is exactly upstream.

Everything else is upstream: wire format, endpoints, OAuth client, model
catalog, streaming, and account storage are untouched. When updating, re-copy
the source and re-apply the changes above; do not hand-merge.

## Not loaded as an extension

This directory is **not** registered in `package.json`'s `pi.extensions`, so its
`index.ts` (which registers the single-account `antigravity` provider and the
`/antigravity.*` commands) never runs. `extensions/antigravity-accounts.ts`
imports the modules it needs and registers one provider per account instead.
That keeps exactly one owner of the provider id and avoids registering an API
twice.

## Attribution

MIT requires the copyright notice and permission notice to be retained: see
[`LICENSE`](LICENSE). Upstream `README.md` is not vendored; refer to the
repository above for user documentation.
