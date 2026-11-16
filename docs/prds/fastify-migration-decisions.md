# Fastify migration — Phase 0 decisions

> Companion to [fastify-web-server.md](fastify-web-server.md). Phase 0 of that PRD
> ("characterize and select stack"). This document is the frozen decision record
> the later phases implement against: pinned versions, the M1–M15
> replacement/removal inventory, the old/new behaviour table, and the exception
> ledger. Update it in place when a decision changes; do not silently diverge.

| Field | Value |
| --- | --- |
| **Status** | phase 0 — decisions recorded, spikes green |
| **Owner** | Faiz |
| **Verified against** | installed tree under `web/` (exact versions below); Node v22.23.2 |
| **Acceptance** | [fastify-web-server.md](fastify-web-server.md) §12 (AC1–AC10) |

## 1. Pinned stack

Installed with `npm install --save-exact` into `web/package.json` (the package
that owns the servers). Exact versions, not carets: this stack is the migration
target and the PRD asks for pinned versions selected during feasibility.

| Package | Version | Role | Engine / peer |
| --- | --- | --- | --- |
| `fastify` | 5.12.8 | both HTTP hosts, routing, hooks, body, errors, lifecycle | node ≥20 |
| `@fastify/static` | 10.1.11 | built client assets + SPA/fallback on both hosts | peer `fastify ^5` |
| `@fastify/cookie` | 11.1.5 | cookie parse + set/clear (M7) | peer `fastify ^5` |
| `@fastify/helmet` | 13.2.0 | security headers (M8) | peer `fastify ^5` |
| `@fastify/jwt` | 10.2.8 | JWT decorators (HTTP paths); bundles `fast-jwt ^6.3.4` | peer `fastify ^5` |
| `fast-jwt` | 6.3.6 | HTTP-independent codec seam for `WebAuthService` (M9) | node ≥20 |
| `@fastify/sse` | 0.6.1 | SSE transport + lifecycle on both hosts (M10) | node ≥20.20.2, peer `fastify ^5` |
| `@fastify/rate-limit` | 11.2.2 | M15 equivalence evaluation | peer `fastify ^5` |
| `@fastify/send` | 4.2.1 | range/content-disposition/MIME helpers (M12) | node ≥20 |
| `find-my-way` | 9.10.1 | live dynamic matcher behind the kernel facade (M3) | node ≥20 |

`@fastify/jwt` and `fast-jwt` share the same underlying `fast-jwt` codec, so
there is one implementation even when the HTTP decorator is also registered
(PRD §6.4).

**Not added:** `@fastify/send` is a direct dependency because the Files
descriptor path may call it directly; `find-my-way` and `fast-jwt` are direct
because the kernel and the auth codec use them without Fastify. No package was
added that the inventory does not justify.

## 2. Runtime and install topology

- Repository floor stays `node >=22.6.0` (`package.json` engines); development
  runtime is v22.23.2. No selected package raises the floor above 22.6.
- **Main host** is launched as `process.execPath --experimental-strip-types
  server.ts` from `web/` (`lib/web-ui.ts`), so server modules resolve their
  dependencies from `web/node_modules`. All new deps therefore live in
  `web/package.json` + `web/package-lock.json`.
- **Graph host** is a detached child spawned as `process.execPath
  --experimental-strip-types <runtime>/…/server-main.ts`; its imports also
  resolve under `web/` (the graph lib lives in `web/plugins/subagent-graph/lib`).
- Root `extensions/*` and `tests/*` import graph **domain** modules
  (`lib/projection.ts`, `lib/integration.ts`, …) and the kernel/auth modules,
  but not `lib/server.ts` or fastify. Node resolves each imported module's
  dependencies from that module's own directory, so the web deps are reachable
  from root tests without adding them to the root manifest. The root
  `package-lock.json` is therefore untouched **unless** a later phase imports a
  new dependency directly from root.
- Test tooling: finite HTTP goes through Fastify `inject()`; socket-level
  checks (SSE flush/pressure/abort, forced close, port-0) stay as real-listener
  tests. The existing suites use real `fetch()` against a port-0 listener and are
  kept for the socket/streaming cases (PRD §12).

## 3. M1–M15 replacement and removal inventory

Location column is the current implementation; "Retained" is what stays
application-owned per PRD §3.

| ID | Today (location) | Replacement | Retained | Protecting test | Phase |
| --- | --- | --- | --- | --- | --- |
| M1 | `web/core/server/main.ts` `createServer`/`handleRequest`; `web/plugins/subagent-graph/lib/server.ts` `#listen`/`#handle` | Fastify factories (`createWebApp`, graph app), `listen`, hooks, `close` | startup identity, env→options mapping, graph singleton/metadata, port fallback | `main.test.ts`, `tests/subagent-graph-runtime.test.ts` | 1 |
| M2 | `routes.ts` `API_ROUTES`/`matchRoute`/`handleApi`; `auth.ts` `handleRoute`; graph `#api`/`#requireMethod` | native Fastify routes, `request.params`, prefixes, route `config`, JSON schemas | handlers calling session/plugin/graph services | `main.test.ts`, `auth.test.ts`, `tests/web-plugin-*.test.ts` | 2 |
| M3 | `kernel/routes.ts` `matchSegments`/`splitRequestPath`/`normalisePath` scanning | `find-my-way` runtime matcher behind the kernel facade (`ctx.routes.*`) | grants, namespace ownership, diagnostics, revocation, invocation budget | `tests/web-plugin-routes.test.ts` | 2 |
| M4 | `http.ts` `sendJson`; auth `sendJson`; graph `sendJson`/`sendText`; raw `writeHead` | `reply.code/header/type/send`, redirects, central error + not-found hooks | status/envelope/cache policy | `main.test.ts`, graph runtime | 2 |
| M5 | `http.ts` `readJsonBody`; auth `readSmallJson`; graph `readBody`/`#readEnvelope` | Fastify JSON parser + per-route `bodyLimit`; scoped `parseAs` adapter where the old contract parsed without Content-Type | empty-body/error mapping; no second stream reader | `files.test.ts`, graph runtime | 2 |
| M6 | per-handler field/type checks in `routes.ts`, auth, graph | full JSON Schemas (body/params/query/headers) + Ajv config | cross-field/domain invariants, known-session/plugin checks, action ordering | `main.test.ts`, `plugin-action.test.ts` | 2 |
| M7 | `auth.ts` `parseCookies`/`cookie()`; graph `parseCookies` + `Set-Cookie` | `@fastify/cookie` parse + `setCookie`/`clearCookie` | names/paths/expiry, credential precedence, Secure policy, graph bootstrap store | `auth.test.ts`, graph runtime | 3 |
| M8 | `main.ts` three header setters; graph `securityHeaders` | `@fastify/helmet`, configured per host/route | CSP/trust policy, special cache headers | `main.test.ts`, graph runtime | 3 |
| M9 | `web/core/auth/jwt.ts` hand-rolled HS256 | `fast-jwt` codec seam (one implementation, HS256-only, keyed by purpose) | purpose keys, required claims, revocation, rotation/grace, error mapping | `web/core/auth/*.test.ts`, `tests/web-auth.test.ts` | 3 |
| M10 | `event-stream.ts` (agent + directory); `bridge.ts` attach; graph `#openEvents`/`#ping`/`#broadcast` | `@fastify/sse` transport (`sse:'manual'`, `keepAlive`, `close`, `onClose`) | event projection, snapshots, coalescing, drop/backlog policy, bridge healing, graph debounce | `event-stream.test.ts`, `tests/web-bridge-*.test.ts`, graph runtime | 4 |
| M11 | `main.ts` `serveStatic`/`MIME_TYPES`/`resolveStaticPath`; graph `#serveStatic` fallback | `@fastify/static` + allowed-path hooks | build-ID HTML stamping, primary SPA fallback, graph restricted types + CSP | `main.test.ts`, graph runtime | 4 |
| M12 | `files.ts` `parseRange`/disposition/`stream.pipe(res)` | Fastify stream reply + `@fastify/send` range/content-disposition helpers | descriptor acquisition (`O_NOFOLLOW`), root/symlink/size policy, `file.before-read` veto, forced-attachment rules | `files.test.ts`, `files-stream.test.ts` | 4 |
| M13 | `main.ts` `closeAllConnections`; `auth.ts` connection map; graph `#closing` | Fastify `preClose`/`onClose`, `close`, `closeAllConnections` option, stream cleanup | bounded teardown, child cleanup, graph singleton release, watchers | `web-shutdown-budget.test.ts`, graph runtime | 1/4 |
| M14 | ad-hoc boot/`console` lines, no request ids | Fastify `requestId` + structured logger, redacting hooks | redaction, existing process/startup messages, plugin audit | `main.test.ts` | 1 |
| M15 | `LoginThrottle` (`throttle.ts`) counters/windows/eviction | `@fastify/rate-limit` where equivalent | failure-only accounting, pre-hash admission, success refund/reset, lock duration, global backstop | `web/core/auth/*.test.ts` | 3 |

## 4. Old/new behaviour decisions

Library-native differences may be adopted only through this table plus a
regression test (PRD §9 "Compatibility rule"). Default is **retain**.

| Area | Today | Fastify default | Decision |
| --- | --- | --- | --- |
| HEAD on primary GET routes | `handleRequest` answers 405 for non-GET | auto-HEAD for every GET | **disable** auto-HEAD on the primary host (`exposeHeadRoutes: false`); graph keeps GET+HEAD where its static contract needs it |
| Known path, wrong method | 405 via table scan | 404 (no route) | **retain 405**, generated from the same route declarations / router lookup + allowed-method iteration for plugins |
| Unknown `/api/*` | 404 JSON after auth | 404 HTML/JSON not-found handler | **retain 404 JSON**, and never an SPA shell for API misses |
| Body limit (general) | 60,000,000 B manual | `bodyLimit` default 1 MiB | set `bodyLimit: 60_000_000` for the general scope; **4,096** for auth routes; `maxSnapshotBytes` for graph producers |
| Oversize body | old code threw → endpoint 400/500 | 413 `FST_ERR_CTP_BODY_TOO_LARGE` | **mapped back**: the auth scope's error handler answers 400 for login/refresh/status and keeps logout's clear-cookies + 200, so no endpoint gains a global 413 (PRD §6.3) |
| Auth body limit | 4,096 B accumulated manually | route `bodyLimit` enforced by Fastify as bytes arrive | adopted; the over-limit answer is mapped to the historical per-endpoint outcome above |
| Cookie parse/serialize | handwritten `parseCookies` + string concatenation | `@fastify/cookie` `request.cookies` / `reply.setCookie` / `reply.clearCookie` | **adopted**; names, paths, `Max-Age`, `HttpOnly`, `SameSite=Strict`, Secure detection retained. Duplicate-cookie precedence differs (library is last-wins, the old parser was first-wins); recorded, low impact |
| Content-Type on body parse | general/auth parse JSON ignoring Content-Type | Fastify only parses matching Content-Type | scoped `parseAs`/`addContentTypeParser` adapter to keep the "parse JSON regardless" contract where it existed; graph producer routes require JSON |
| Empty body | `{}` (general/auth); graph throws | parser error / `{}` | preserve `{}` via scoped parser; test both |
| Trailing slash | exact match, no redirect | `ignoreTrailingSlash` off; `/x/` ≠ `/x` | keep off; test `/x` vs `/x/` explicitly |
| `Cache-Control: no-store` JSON | every JSON reply | none | policy helper sets cache per status family (JSON `no-store`; SSE `no-cache, no-transform`) |
| SSE content-type | `text/event-stream` (graph: `; charset=utf-8`) | plugin writes `text/event-stream` | keep plugin value; graph charset difference is cosmetic and documented |
| SSE heartbeat | JSON `data: {"type":"heartbeat"}` every 30 s | plugin writes `: heartbeat` comment | **disable plugin heartbeat**, emit our JSON data heartbeat (wire preserved) |
| SSE Accept negotiation | always streams | `manual` attaches unconditionally; `only` can 406 | use `sse: 'manual'` so every client that worked before still streams |
| SSE `retry: 2000` | standalone preamble frame | part of the first message | emit `{ retry: 2000, data }` on graph connect; document the combined frame |
| Static ETag/Last-Modified/redirects | none | `@fastify/static` sends them | **retained** with `etag:false`, `lastModified:false`, `redirect:false`, `acceptRanges:false`; built assets remain full 200 with `no-cache` (not Files downloads) |
| Static index/listing | explicit root→index.html, no listing | index on, listing off | primary: explicit root index plus extensionless SPA fallback, `index:false`; graph: root index (root then dist), no directory indexes under asset prefixes; no listing; dotfiles denied |
| Static MIME | hand-maintained maps | maintained MIME database | **adopted** library MIME values, including JavaScript `application/javascript; charset=utf-8` rather than `text/javascript`; WASM/fonts/opaque viewer assets are regression-tested |
| Static containment/noncanonical paths | graph realpath containment; primary lexical containment; graph WHATWG URL normalization could turn encoded dot segments into an index request | library rejects noncanonical paths before serving | **adopted stricter rejection**, mapped to 404: encoded traversal is never an alternate index URL; both hosts reject out-of-root symlinks and dotfiles. Graph allowed layouts/types remain policy callbacks |
| Plugin route precedence | first-registration-wins | `find-my-way` specificity (static > param) | **adopted specificity** in the kernel matcher; regression-tested in `tests/web-plugin-routes.test.ts`; not "identical" |
| Proxy trust | `PI_WEB_TRUST_PROXY` → custom last-hop key | Fastify `trustProxy` | small tested policy adapter for the throttling key / forwarded host / proto (PRD §6.4) |
| JWT codec | hand-rolled HS256 in `jwt.ts` | `fast-jwt` signer/verifier, HS256-only, `checkTyp`, `cache:false` | **adopted**; the claim policy stays in `jwt.ts` (issuer/audience/use/kid, required claim types, `exp`/`iat` with leeway). The wire format is byte-identical — interop is pinned both ways in `tests/web-auth.test.ts` |
| JWT clock/expiry | `now` + `leewaySeconds` passed per call; expired iff `exp + leeway ≤ now` | the library binds `clockTimestamp` at construction | **decision**: one verifier per call carries the injected clock, with `ignoreExpiration`/`ignoreNotBefore` so the injected clock and the exact 1-second expiry boundary are unchanged, and `cache:false` so a stale clock decision cannot leak |
| Shutdown / stream cleanup (M13) | `closeAllConnections()` plus ad-hoc socket bookkeeping | Fastify `preClose`/`onClose`, `close`, `forceCloseConnections`, stream teardown | **decision**: `forceCloseConnections: true`, plus one bounded `runTeardown` step that calls `app.close()`, plus the app's `onClose` hook (`WebAppOptions.onClose` → `AuthHttp.close()`) which destroys the tracked event streams deterministically *before* Fastify force-closes the remaining sockets; the synchronous `exit` guard kills leftover children. No `preClose` hook is used — nothing needs a pre-close phase. Pinned by the close-cuts-an-open-stream test |

Files M12 compatibility: invalid/multiple/unsatisfiable ranges retain full 200;
zero-byte requests now safely return empty 200 and Unicode download names gain
RFC 6266/5987 encoding. Both changes are regression-tested (see §6).

## 5. SSE stability review — `@fastify/sse` 0.6.1

The PRD flags this package as pre-1.0 and requiring an explicit stability,
wire, and lifecycle review. Findings from the installed source (`index.js`):

- **Framing is byte-compatible for data events.** `formatSSEMessage` emits
  `data: <line>\n` per line plus a blank line, i.e. `data: {…}\n\n` — identical
  to `event-stream.ts` today. Plain objects are `JSON.stringify`-ed, matching
  the current serializer; objects are not re-wrapped as named events.
- **Lifecycle works for out-of-band producers.** With `sse: 'manual'` the
  plugin attaches `reply.sse` unconditionally; `keepAlive()` stops the
  auto-close on handler resolution and `close()` ends the raw response once
  headers are committed. `onClose()` fires from `reply.raw` `close`/`error`, so
  timers and subscriptions are released exactly once.
- **Backpressure is honoured.** `writeToStream` resolves on `write()` or
  `drain`, and throws `FST_ERR_SSE_CONNECTION_CLOSED` after close. The
  application pressure policy (512 KiB drop threshold, 16 MiB close, 150 ms
  coalescing) stays ours and reads `reply.raw.writableLength`; the plugin does
  not add an unbounded queue.
- **Heartbeat is a comment**, not a data event. We disable it
  (`{ kind:'manual', heartbeat:false }`) and keep the JSON `heartbeat` event.
- **Cache-Control** is set to `no-cache` by the plugin but `reply.getHeaders()`
  is transferred afterwards, so an explicit `reply.header('cache-control',
  'no-cache, no-transform')` wins.
- **Accept negotiation**: `'only'` can answer 406; `'manual'` never does, which
  preserves the historical "always stream" behaviour for `fetch()` (`*/*`),
  EventSource, and missing Accept.
- **Risk accepted**: 0.x version may change its API on a minor. Mitigation: the
  dependency is declared directly, exact-pinned, and the SSE routes are the only
  call sites; a version bump is a reviewed change against this section. If a
  required behaviour cannot be preserved, the PRD's fallback is another
  maintained compatible transport, not a custom SSE framework.

## 6. Files: descriptor safety and ranges (M12)

- `files.ts` today opens with `O_RDONLY | O_NOFOLLOW`, stats the **handle**, and
  streams from the open `fd` with `autoClose:false`, closing the handle exactly
  once on stream `close`, response `close`, or error. That descriptor ownership
  is non-negotiable.
- **Cleanup trigger (spike-proven).** With `autoClose:false` a stream that ends
  normally emits `end` but **not** `close`; the response `close` event is the
  reliable single cleanup trigger, with the stream `close`/`error` covering the
  abort path. The adapter therefore closes the handle once, guarded by a flag,
  from both `reply.raw` `close` and the stream's `close`/`error`. Under Fastify,
  a mid-body client abort destroys the payload stream and closes `reply.raw`, so
  both listeners fire and the first wins.
- A helper that takes a path and reopens it (e.g. `@fastify/send`'s default path
  mode) reintroduces the symlink/TOCTOU window. The plan keeps descriptor
  ownership in `files.ts`: `FileHandle.createReadStream()` feeds a
  framework-neutral `PluginRouteStream` sent through Fastify. `@fastify/send`
  does not expose its range helpers as public APIs, so the direct, exact-pinned
  utilities are `range-parser@1.3.0` and `content-disposition@3.0.0`, not private
  send internals. The shared `mimeTypeFor` allowlist remains rendering/security
  policy (unknown content must be an attachment), not an unrestricted MIME
  guess. `files-stream.test.ts` covers full/partial/suffix/open ranges,
  invalid/multiple/unsatisfiable fallback, content length, Unicode disposition,
  forced attachments, zero-byte files, path replacement after acquisition and
  repeated aborts/descriptor counts.
- Invalid-`Range` fallback stays 200, not a library 416. A small policy guard
  rejects multiple ranges/units/whitespace the old reader rejected. Oversized
  suffix ranges clip to the full file even though `range-parser` rejects them.
- Zero-byte files return an empty 200, even with Range. This deliberately fixes
  the old `end: -1` stream construction error/leak; no descriptor is reopened.
  Unicode filenames now use RFC 6266/5987 encoding through `content-disposition`;
  ASCII names and the existing control/quote stripping and length cap remain.
- Results arriving after the handler budget or client disconnect are destroyed
  and released by the route registry, not silently discarded with an open fd.
  `request.signal` provides cooperative cancellation; response completion,
  abort and source error all settle the stream's idempotent `close` callback.

## 7. M15 throttle equivalence

`LoginThrottle` is not a fixed-window request counter:

- accounting is **failure-only** (a success clears the client record);
- the attempt is charged **before** the password is checked and refunded on
  success (`success()` pops the global entry), so concurrent guesses cannot slip
  under a post-check counter;
- a per-client rolling window locks a client for `lockMs`; a separate **global
  backstop** pauses all logins;
- bounded memory via `MAX_TRACKED_CLIENTS` eviction.

`@fastify/rate-limit` is a per-request/window limiter with pluggable stores. It
does **not** model pre-hash charging + success refund or the failure-only
window directly. Decision: keep `LoginThrottle` as the login policy and evaluate
`@fastify/rate-limit` only for a possible **global login backstop** where its
semantics match; do not replace failure accounting with a post-password counter,
and do not add a redundant limiter. This is the PRD's explicit equivalence
investigation, and its current verdict is "retain, with a tested global-limited
alternative if it is truly equivalent".

## 8. Exception ledger (seeded)

Every exception names location, the behaviour that cannot be delegated, the
evaluated library/API and its mismatch, the minimal retained code, owner,
protecting test, and removal condition.

| # | Location | Retained behaviour | Library evaluated (mismatch) | Minimal code | Test | Removal condition |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | `web/core/server/files.ts` (Files owner) | authorized `O_NOFOLLOW` descriptor ownership; symlink/root/size policy; forced attachment for HTML/SVG/unknown | `@fastify/send` default path mode reopens the path (TOCTOU) | descriptor/policy adapter; Fastify owns streaming, `range-parser` owns range arithmetic, `content-disposition` owns encoding | `files-stream.test.ts` | a maintained descriptor-aware helper preserving these guarantees |
| E2 | `web/core/server/legacy-plugin-transport.ts` (plugin-host owner) | existing external plugins that write to the real Node response before returning `{ handled:true }` | Fastify cannot infer already-committed external raw ownership or replace committed bytes with a 502 | single deprecated raw adapter; hijack on ownership, terminate partial output after failure; first-party Files no longer uses it | `plugin-stream.test.ts`, `tests/web-plugin-routes.test.ts` | remove when external raw transport API support is retired; new first-party handlers must return body/stream results |
| E3 | kernel route facade (`kernel/routes.ts`) | grants, namespace, diagnostics, budget facade even though the matcher is `find-my-way` | `find-my-way` has no capability/ownership model | thin facade over `on`/`off`/`findRoute` | `tests/web-plugin-routes.test.ts` | never (policy is domain) |
| E4 | `web/core/auth/throttle.ts` | failure-only rolling accounting + pre-hash charging | `@fastify/rate-limit` fixed-window post-check mismatch | keep `LoginThrottle` | `web/core/auth/*.test.ts` | a maintained limiter with equivalent hooks |

## 9. Spike results

Recorded by `web/core/server/fastify-spike.test.ts` (run with the web test
command). The spike only imports the selected stack; it does not touch the
running server.

- native JSON body + `bodyLimit` 413 + empty-body `{}` behavior;
- `onRequest` auth runs **before** body parsing (unauthorized request never
  consumes/echoes the body);
- live `find-my-way` `on`/`off`/`find` + allowed-method detection while a
  listener is up. Note: `findRoute` matches registered **patterns**, not concrete
  paths, so allowed-method iteration probes each method with `find(method, path)`
  — still "allowed-method iteration", per the PRD;
- `@fastify/sse` `manual` route: preamble/framing, JSON data events, `onClose`
  cleanup, `close()` on revocation while the listener stays up;
- descriptor-safe range stream over a real socket (206 + `Content-Range`, abort
  destroys the payload and closes `reply.raw`, descriptor closed once), and
  bounded close with a live SSE connection (`forceCloseConnections: true`
  required, matching the current `closeAllConnections()` teardown).

See the test file for the assertions; the results are the Phase 0 exit gate.

## 10. Phase status

- **Phase 0 — done** (commit `b06e6bb`): stack pinned, decisions recorded,
  spikes green.
- **Phase 1 — done**: both hosts now build a Fastify app without listening.
  `web/core/server/app.ts` (pi-web) and `web/plugins/subagent-graph/lib/app.ts`
  (graph) each configure cookie, helmet with the host's explicit header policy,
  sanitized JSON error/not-found handlers, `forceCloseConnections` and no-op
  root content type parsers. `startWebServer` owns `listen`/`close` for pi-web
  (port 0, bind-failure rejection, build watcher, bounded teardown, same
  `WebServerHandle`); the graph runtime owns its `listen`/port-fallback/`close`
  with `forceCloseConnections` replacing the old idle/close/guard bookkeeping.
  Phase 1 introduced a bounded `/*` delegate for incremental route conversion;
  M11 removed it from both factories after the native/static routes landed.
  Factory/lifecycle coverage: `web/core/server/app.test.ts` plus the existing
  graph runtime/process suites (34 tests).
- **Phase 2 — in progress**: the kernel's handwritten `matchSegments` matcher is
  replaced by a `find-my-way` facade (`web/core/plugin-contracts/kernel/routes.ts`),
  one library router per plugin so namespaces stay isolated (precedence is now
  library specificity, regression-tested). The `/api` access gate moved out of
  the dispatcher into the app's `onRequest` hook (`authorize` in
  `web/core/server/app.ts`, wired from `main.ts`), so an unauthenticated caller
  is refused before parsing or validation; the same hook writes the three
  security headers onto the raw response so a hijacked reply keeps them. The
  plugin HTTP entry point is now a native route (`registerPluginRoutes`,
  `scope.all('/api/p/*')`) with a scoped lenient parser preserving the plugin
  body contract (JSON regardless of Content-Type, `{}` empty, `undefined`
  malformed). The core API is now a native route table (`registerCoreRoutes` in
  `web/core/server/routes.ts`): real Fastify paths with `:params`, a generated
  per-path dispatcher that answers 405 for a known path with an unsupported
  method (so known-path 405 versus unknown-path 404 survives without a second
  matcher), and a scoped lenient body parser preserving the handwritten body
  contract. The regex `API_ROUTES`/`matchRoute`/`handleApi` table, the
  `readJsonBody` reader and the plugin-manager HTTP adapters are deleted.
  M11 removed this host's remaining static delegate.
- **Phase 2b (graph) — API routes native**: the graph host's loopback
  Host/Origin gate moved out of the dispatcher into the app factory's
  `onRequest` hook (`guard` in `web/plugins/subagent-graph/lib/app.ts`, wired
  from `server.ts`), matching the primary host, and the graph API is a native
  route table (`#registerApiRoutes`): `/api/health`, `/api/sessions`,
  `/api/session`, `/api/artifact` and the three producer POSTs. Authentication
  runs in each route's `onRequest` hook, so it is still decided before any body
  is read; method mismatches keep their 405, unknown `/api/*` keeps its 404 via
  the dispatcher, and the request-activity stamp moved into `#guard` so a
  heartbeating producer still prevents the idle shutdown. The handlers keep the
  runtime's raw writers and `#readEnvelope`. M11 registered `/api/events`
  and `/bootstrap` natively as well, then deleted `#handle`/`#api` and the
  factory delegate; the SSE transport itself still needs M10.
- **Phase 3 — done**: cookies go through `@fastify/cookie` (the gate reads
  `request.cookies`, the routes call `reply.setCookie`/`clearCookie`) and the
  four auth endpoints are native Fastify routes with a scoped 4,096-byte body
  limit. The JWT codec (`web/core/auth/jwt.ts`) is the `fast-jwt` seam
  (HS256-only, `checkTyp`, cache off, injected clock), with the old/new
  wire-format interop pinned in `tests/web-auth.test.ts`. The
  `PI_WEB_TRUST_PROXY` / Secure-detection contract is the small tested policy
  adapter in `auth.ts` (§4): the forwarded host/proto and the throttling key are
  derived from the raw headers this module already owns, so no Fastify
  `trustProxy` / `request.ip` path is needed (nothing reads it). M15's throttle
  verdict is recorded in §7.
- **Phase 4 — partial**: M12 is complete. First-party Files returns the
  framework-neutral stream result; Fastify owns transfer/completion and the
  descriptor adapter owns policy/acquisition/release. Range arithmetic and
  disposition encoding use maintained direct dependencies (§6). The only raw
  plugin escape hatch is the deprecated external-plugin adapter E2, with
  real-socket tests for early writes, handled ownership, failures/timeouts and
  disconnect. Late streamed results after budget/disconnect are also released.
  M13 has the app close callback and shutdown regression from `cc10cb1`.
  M11 is complete: `@fastify/static` serves both roots; the primary shell's
  onSend transform stamps build identity and fixes Content-Length, while the
  scoped not-found policy owns extensionless SPA fallback. Graph prefixes,
  root/dist index precedence, placeholder/CSP and type/containment rules are
  retained without manual streaming or MIME tables. Pure shared policy lives
  in `lib/built-asset-policy.ts` so the standalone graph host never imports
  the primary runtime. Static behavior is covered by `static.test.ts`, the
  main/rebuild tests and the real-socket graph runtime suite. Only M10's four
  SSE transports remain unfinished in the Phase 4 split.
