# Fastify migration — Phase 0 decisions

> Companion to [fastify-web-server.md](fastify-web-server.md). Phase 0 of that PRD
> ("characterize and select stack"). This document is the frozen decision record
> the later phases implement against: pinned versions, the M1–M15
> replacement/removal inventory, the old/new behaviour table, and the exception
> ledger. Update it in place when a decision changes; do not silently diverge.

| Field | Value |
| --- | --- |
| **Status** | all phases complete (§10); removal audit enforced by test (§11) |
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
| `fast-jwt` | 6.3.6 | HTTP-independent codec seam for `WebAuthService` (M9) | node ≥20 |
| `@fastify/sse` | 0.6.1 | SSE transport + lifecycle on both hosts (M10) | node ≥20.20.2, peer `fastify ^5` |
| `find-my-way` | 9.10.1 | live dynamic matcher behind the kernel facade (M3) | node ≥20 |
| `range-parser` | 1.3.0 | Range header arithmetic for Files (M12, E1) | — |
| `content-disposition` | 3.0.0 | RFC 6266/5987 download-name encoding (M12, E1) | — |
| `ajv` | 8.20.0 | same engine as Fastify; shared schemas for independently callable command/pi_api validators (M6) | no runtime-floor increase |

`fast-jwt` is the only JWT codec. The `@fastify/jwt` decorator is not registered,
so there is one implementation (PRD §6.4).

**Removed by the post-migration audit** (declared but never imported):
`@fastify/jwt`, `@fastify/send`, `@fastify/rate-limit`. `@fastify/send` remains
only as `@fastify/static`'s own dependency. `range-parser` and
`content-disposition` are direct because `@fastify/send` does not export its
helpers (§6). Re-adding a package requires a real import site and a row here.

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
- Test tooling caveat: `fetch()` and `URL` apply WHATWG dot-segment
  normalization, so `%2e%2e` becomes `..` before the request is sent. A traversal
  probe written with `fetch` tests the client, not the server. Path-traversal
  assertions use a raw `node:http` request (`rawRequest` in
  `subagent-graph-runtime.test.ts`).
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
| M9 | `web/core/auth/jwt.ts` hand-rolled HS256 | `fast-jwt` codec seam (one implementation, HS256-only, keyed by purpose) | purpose keys, required claims, revocation, rotation/grace, error mapping | `web/core/server/auth.test.ts`, `tests/web-auth.test.ts` | 3 |
| M10 | deleted repeated headers/framing/raw close plumbing in agent/directory, bridge attach and graph events | shared `core/http/sse.ts`: `@fastify/sse` public `stream`, `sendHeaders`, `keepAlive`, `close`, `onClose`; library heartbeats for bridge/graph | event projection/snapshots, byte-bounded preludes/coalescing, drop/backlog policy, bridge healing, graph debounce/caps | `web/core/server/sse.test.ts`, `web/core/server/event-stream-policy.test.ts`, `tests/sse-pressure.test.ts`, existing stream/bridge/auth/graph suites + browser e2e | 4 complete |
| M11 | `main.ts` `serveStatic`/`MIME_TYPES`/`resolveStaticPath`; graph `#serveStatic` fallback | `@fastify/static` + allowed-path hooks | build-ID HTML stamping, primary SPA fallback, graph restricted types + CSP | `main.test.ts`, graph runtime | 4 |
| M12 | `files.ts` `parseRange`/disposition/`stream.pipe(res)` | Fastify stream reply + direct `range-parser` / `content-disposition` (§6) | descriptor acquisition (`O_NOFOLLOW`), root/symlink/size policy, `file.before-read` veto, forced-attachment rules | `files.test.ts`, `files-stream.test.ts` | 4 |
| M13 | `main.ts` `closeAllConnections`; `auth.ts` connection map; graph `#closing` | Fastify `preClose`/`onClose`, `close`, `closeAllConnections` option, stream cleanup | bounded teardown, child cleanup, graph singleton release, watchers | `web-shutdown-budget.test.ts`, graph runtime | 1/4 |
| M14 | ad-hoc boot/`console` lines, no request ids | Fastify request ids + structured logger with credential-safe request serialization | redaction, existing process/startup messages, plugin audit | `request-logging.test.ts` | 5 complete |
| M15 | `LoginThrottle` (`throttle.ts`) counters/windows/eviction | none adopted: `LoginThrottle` retained by verdict (§7) | failure-only accounting, pre-hash admission, success refund/reset, lock duration, global backstop | `tests/web-auth.test.ts` | 3 |

## 4. Old/new behaviour decisions

Library-native differences may be adopted only through this table plus a
regression test (PRD §9 "Compatibility rule"). Default is **retain**.

| Area | Today | Fastify default | Decision |
| --- | --- | --- | --- |
| HEAD on primary GET routes | `handleRequest` answers 405 for non-GET | auto-HEAD for every GET | **disable** auto-HEAD on the primary host (`exposeHeadRoutes: false`), so HEAD on primary API and static paths is 405, as before; graph keeps GET+HEAD where its static contract needs it |
| Known path, wrong method | 405 via table scan | 404 (no route) | **retain 405**, generated from the same route declarations / router lookup + allowed-method iteration for plugins |
| Unknown `/api/*` | 404 JSON after auth | 404 HTML/JSON not-found handler | **retain 404 JSON**, and never an SPA shell for API misses |
| Body limit (general) | 60,000,000 B manual | `bodyLimit` default 1 MiB | set `bodyLimit: 60_000_000` for the general scope; **4,096** for auth routes; `maxSnapshotBytes` for graph producers |
| Oversize body | most JSON handlers caught the reader error and answered 400 `request body too large`; a few answered 500 | 413 `FST_ERR_CTP_BODY_TOO_LARGE` | **primary general scope: 400 `{"error":"request body too large"}`, not logged as a server error** (the app error handler; the 500 was a regression caught by `app.test.ts`). Auth scope: 400 for login/refresh/status; logout clears cookies and answers 200 (PRD §6.3). Graph producers: 413, its own contract |
| Auth body limit | 4,096 B accumulated manually | route `bodyLimit` enforced by Fastify as bytes arrive | adopted; the over-limit answer is mapped to the historical per-endpoint outcome above |
| Cookie parse/serialize | handwritten `parseCookies` + string concatenation | `@fastify/cookie` `request.cookies` / `reply.setCookie` / `reply.clearCookie` | **adopted**; names, paths, `Max-Age`, `HttpOnly`, `SameSite=Strict`, Secure detection retained. Library parsing uses the first duplicate and URI-decodes values. The graph's former last-wins/raw-value parser is deliberately replaced; a runtime regression pins both duplicate orders and encoded values |
| Content-Type on body parse | general/auth parse JSON ignoring Content-Type | Fastify only parses matching Content-Type | scoped `parseAs`/`addContentTypeParser` adapter to keep the "parse JSON regardless" contract where it existed; graph producer routes require JSON |
| Empty body | `{}` (general/auth); graph throws | parser error / `{}` | preserve `{}` via scoped parser; test both |
| Schema mutation | handwritten checks do not coerce/default/strip | Ajv normally coerces/defaults/removes extras | **disabled explicitly on both hosts**: `coerceTypes:false`, `useDefaults:false`, `removeAdditional:false`, `ownProperties:true`, `allErrors:false`; unknown extension fields survive |
| Duplicate query values | WHATWG first value | query parser returns arrays | native router `querystringParser` uses WHATWG parsing with a first-value projection; handlers consume `request.query` |
| Shape error ordering | session/action/confirmation checks at endpoint-specific points | validation immediately rejects | `attachValidation` preserves those decision points; schema-validated protocol entry points use the same Ajv engine/schema rather than parallel field checkers |
| Invalid-input text | JSON.parse details and handwritten pi_api text | schema paths/keywords | **adopted** stable `Invalid JSON body` (existing endpoint status retained) and pi_api schema-path errors without input values; command/auth/graph status envelopes remain. Schema string lengths use Unicode code points; MCP add config is explicitly an object (arrays rejected as 400, not a downstream failure) |
| Method bodies | transitional all-method routes accumulated irrelevant bodies | per-method routes can reject early | native real methods plus generated complement `onRequest` fallbacks reject 405/401 before parsing or validation; no duplicated path matcher |
| Trailing slash | exact match, no redirect | `ignoreTrailingSlash` off; `/x/` ≠ `/x` | keep off. `/api/health/` is 404. `/api/sessions/` matches `/api/sessions/:id` with an empty id, and that is 404 too, not 405 (`request-schemas.test.ts`) |
| `Cache-Control: no-store` JSON | every JSON reply | none | policy helper sets cache per status family (JSON `no-store`; SSE `no-cache, no-transform`) |
| SSE content-type | `text/event-stream` (graph: `; charset=utf-8`) | plugin writes `text/event-stream` | keep plugin value; graph charset difference is cosmetic and documented |
| SSE heartbeat | agent/directory JSON heartbeat at 30 s; bridge `:hb`; graph `: ping` | plugin writes `: heartbeat` | agent/directory disable plugin heartbeat and keep JSON; bridge/graph **adopt library comments** at 30 s/configured graph interval (zero disables graph pings); ownership-healing/pressure guards remain domain work |
| SSE Accept negotiation | always streams | `manual` attaches unconditionally; `only` can 406 | use `sse: 'manual'` so every client that worked before still streams |
| SSE `retry: 2000` | standalone preamble frame | part of the first message | **adopted** combined initial `changed` data + retry field; no named/double-encoded data events |
| SSE immediate flush | an empty comment forces headers onto the wire | `sendHeaders()` commits but does not flush | flush the committed head before startup via `raw.flushHeaders()`; no synthetic data event or handwritten preamble |
| SSE pressure | raw-buffer-only checks before writes; prelude/coalescing storage uncapped; droppable traffic could bypass hard close | library formatting/Node pipe backpressure, not application byte caps | charge incoming UTF-8 frame bytes, formatter/byte-stream/socket buffers and producer reservations before admission, with conservative HTTP chunk reserve; hard close takes precedence over dropping. Oversized staged events close/reconnect rather than remain retained |
| Static ETag/Last-Modified/redirects | none | `@fastify/static` sends them | **retained** with `etag:false`, `lastModified:false`, `redirect:false`, `acceptRanges:false`; built assets remain full 200 with `no-cache` (not Files downloads) |
| Static index/listing | explicit root→index.html, no listing | index on, listing off | primary: explicit root index plus extensionless SPA fallback, `index:false`; graph: root index (root then dist), no directory indexes under asset prefixes; no listing; dotfiles denied |
| Static MIME | hand-maintained maps | maintained MIME database | **adopted** library MIME values, including JavaScript `application/javascript; charset=utf-8` rather than `text/javascript`; WASM/fonts/opaque viewer assets are regression-tested |
| Static containment/noncanonical paths | graph realpath containment; primary lexical containment; graph WHATWG URL normalization could turn encoded dot segments into an index request | library rejects noncanonical paths before serving | **adopted stricter rejection**, mapped to 404: encoded traversal is never an alternate index URL; both hosts reject out-of-root symlinks and dotfiles. Graph allowed layouts/types remain policy callbacks |
| Plugin route precedence | first-registration-wins | `find-my-way` specificity (static > param) | **adopted specificity** in the kernel matcher; regression-tested in `tests/web-plugin-routes.test.ts`; not "identical" |
| Proxy trust | `PI_WEB_TRUST_PROXY` → custom last-hop key | Fastify `trustProxy` from the same env, used only for the logged `request.ip` | auth decisions (throttle key, forwarded host/proto, Secure) stay in the `auth.ts` adapter, which reads raw headers under the same policy (PRD §6.4) |
| JWT codec | hand-rolled HS256 in `jwt.ts` | `fast-jwt` signer/verifier, HS256-only, `checkTyp`, `cache:false` | **adopted**; the claim policy stays in `jwt.ts` (issuer/audience/use/kid, required claim types, `exp`/`iat` with leeway). The wire format is byte-identical — interop is pinned both ways in `tests/web-auth.test.ts` |
| JWT clock/expiry | `now` + `leewaySeconds` passed per call; expired iff `exp + leeway ≤ now` | the library binds `clockTimestamp` at construction | **decision**: one verifier per call carries the injected clock, with `ignoreExpiration`/`ignoreNotBefore` so the injected clock and the exact 1-second expiry boundary are unchanged, and `cache:false` so a stale clock decision cannot leak |
| Shutdown / stream cleanup (M13) | `closeAllConnections()` plus ad-hoc socket bookkeeping | Fastify `preClose`/`onClose`, `close`, `forceCloseConnections`, stream teardown | **decision**: `forceCloseConnections: true`, plus one bounded `runTeardown` step that calls `app.close()`, plus the app's `onClose` hook (`WebAppOptions.onClose` → `AuthHttp.close()`) which releases residual response tracking *after* Fastify starts force-closing sockets; `forceCloseConnections`, not that callback, bounds socket shutdown; the synchronous `exit` guard kills leftover children. No `preClose` hook is used — nothing needs a pre-close phase. Pinned by the close-cuts-an-open-stream test |

Files M12 compatibility: invalid/multiple/unsatisfiable ranges retain full 200;
zero-byte requests now safely return empty 200 and Unicode download names gain
RFC 6266/5987 encoding. Both changes are regression-tested (see §6).

## 5. SSE stability review — `@fastify/sse` 0.6.1

The PRD flags this package as pre-1.0 and requiring an explicit stability,
wire, and lifecycle review. Findings from the installed source (`index.js`):

- **Framing is byte-compatible for data events.** `formatSSEMessage` emits
  `data: <line>\n` per line plus a blank line, i.e. `data: {…}\n\n` — identical
  to the former `event-stream.ts` writer. The adapter freezes a frame's JSON
  string on admission; the route serializer returns it unchanged, so library
  framing neither double-encodes objects nor invents named events.
- **Lifecycle works for out-of-band producers.** With `sse: 'manual'` the
  plugin attaches `reply.sse` unconditionally; `keepAlive()` stops the
  auto-close on handler resolution and `close()` ends the raw response once
  headers are committed. `onClose()` fires from `reply.raw` `close`/`error`, so
  timers and subscriptions are released exactly once.
- **Bounded backpressure uses the public `stream()` API**, documented by the
  package for piping to `reply.raw`. Calling async `send()` once per producer
  callback would accumulate promises/drain listeners, and this release's
  single-write drain wait listens for error/drain but not close. We avoid that
  path entirely. One formatter and a byte-mode PassThrough feed Node's bounded
  pipe chain. The byte stage matters: raw HTTP string queues can report UTF-16
  character lengths rather than UTF-8 byte lengths. Application admission counts
  immutable pending JSON, every pipeline layer, socket bytes and bounded
  producer prelude/coalescing reservations, with a conservative HTTP chunk
  reserve. There is no promise chain or unbounded iterator queue. Tests cover
  Unicode accounting, a genuinely unread client, graceful draining, abrupt
  close, and removal of pipe drain listeners.
- **Heartbeat is a comment**, not a data event. Agent/directory disable it
  (`{ kind:'manual', heartbeat:false }`) and retain the JSON `heartbeat` event.
  Bridge/graph use library heartbeat ownership. Their remaining periodic work
  is only bridge registry healing / graph byte-cap enforcement; graph debounce
  remains notification policy.
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
| E4 | `web/core/auth/throttle.ts` | failure-only rolling accounting + pre-hash charging | `@fastify/rate-limit` fixed-window post-check mismatch | keep `LoginThrottle` | `tests/web-auth.test.ts` | a maintained limiter with equivalent hooks |
| E5 | `web/core/http/sse.ts`, `lib/sse-pressure.ts` (web transport owner) | domain byte admission, coalescing/prelude reservations, immediate startup flush and hard abort of stalled clients | `@fastify/sse` 0.6.1 `stream()` handles framing/backpressure/lifecycle, but has no application byte budgets; `sendHeaders()` does not flush and `close()` is graceful | one bounded library formatter/UTF-8 pipe adapter; only raw flush/pressure abort, no raw SSE writes or independent connection listeners | `web/core/server/sse.test.ts`, `web/core/server/event-stream-policy.test.ts`, `tests/sse-pressure.test.ts`, auth/graph suites | use plugin flush/abort APIs when available; application caps/replay/healing remain domain policy |
| E6 | `web/core/server/auth.ts` connection index | immediate revocation/logout cuts every open response for a session | `@fastify/sse` owns channel lifetime but the auth service does not hold channels, and revocation is decided in `WebAuthService` | a `Map<sessionId, Set<ServerResponse>>` that only `destroy()`s; it never writes or frames a response | `auth.test.ts` (revocation cuts the stream) | expose channel handles to the auth service so revocation closes channels instead of raw responses |

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
  graph runtime/process suites.
- **Phase 2 — complete**: the kernel's handwritten `matchSegments` matcher is
  replaced by a `find-my-way` facade (`web/core/plugin-contracts/kernel/routes.ts`),
  one library router per plugin so namespaces stay isolated (precedence is now
  library specificity, regression-tested). The `/api` access gate moved out of
  the dispatcher into the app's `onRequest` hook (`authorize` in
  `web/core/server/app.ts`, wired from `main.ts`), so an unauthenticated caller
  is refused before parsing or validation. The gate now answers exclusively
  through Fastify replies; global Helmet owns the security policy. Only E2's
  legacy plugin adapter copies already-computed reply headers onto the real
  response before exposing it to an external plugin. The
  plugin HTTP entry point is now a native route (`registerPluginRoutes`,
  `scope.all('/api/p/*')`) with a scoped lenient parser preserving the plugin
  body contract (JSON regardless of Content-Type, `{}` empty, `undefined`
  malformed). The core API is now a native route table (`registerCoreRoutes` in
  `web/core/server/routes.ts`): real per-method Fastify paths with `:params`,
  generated method-complement refusal routes (405 before body consumption),
  and a scoped lenient parser preserving the JSON/empty/error contract while
  exposing parsed bodies to native schemas. The regex `API_ROUTES`/`matchRoute`/`handleApi` table, the
  `readJsonBody` reader and the plugin-manager HTTP adapters are deleted.
  M11 removed this host's remaining static delegate. Core/auth/graph declarations
  now carry full request schemas and explicit non-mutating Ajv settings.
  Shared schemas replace command attachment/field checks, pi_api structural
  checks and graph lease checks; independent callable protocol parsers use
  the same declared Ajv version. Domain snapshot projection, action ordering,
  credential selection and fallback policy remain application-owned.
  `request-schemas.test.ts`, `tests/http-schema-policy.test.ts` and graph
  chunked UTF-8/lease regressions protect this boundary.
- **Phase 2b (graph) — API routes native**: the graph host's loopback
  Host/Origin gate moved out of the dispatcher into the app factory's
  `onRequest` hook (`guard` in `web/plugins/subagent-graph/lib/app.ts`, wired
  from `server.ts`), matching the primary host, and the graph API is a native
  route table (`#registerApiRoutes`): `/api/health`, `/api/sessions`,
  `/api/session`, `/api/artifact` and the three producer POSTs. Authentication
  runs in each route's `onRequest` hook, so it is still decided before any body
  is read; method mismatches keep their 405, unknown `/api/*` keeps its 404 via
  the dispatcher, and the request-activity stamp moved into `#guard` so a
  heartbeating producer still prevents the idle shutdown. All finite routes use
  Fastify replies, bootstrap uses
  `setCookie`/`redirect`, and Helmet owns headers including gate/error replies.
  A scoped `parseAs: 'string'` parser preserves empty/invalid/non-object JSON
  errors while Fastify consumes and caps the body at `maxSnapshotBytes`.
  Auth, method and Content-Type checks run before parsing (401/405/415 before
  oversized input); graph oversize remains 413. M11 deleted `#handle`/`#api`
  and the factory delegate; M10 uses library-backed SSE for `/api/events`.
- **Phase 3 — complete**: cookies go through `@fastify/cookie` (the gate reads
  `request.cookies`, the routes call `reply.setCookie`/`clearCookie`) and the
  four auth endpoints are native Fastify routes with a scoped 4,096-byte body
  limit. The JWT codec (`web/core/auth/jwt.ts`) is the `fast-jwt` seam
  (HS256-only, `checkTyp`, cache off, injected clock), with the old/new
  wire-format interop pinned in `tests/web-auth.test.ts`. The
  `PI_WEB_TRUST_PROXY` / Secure-detection contract is the small tested policy
  adapter in `auth.ts` (§4): the forwarded host/proto and the throttling key are
  derived from the raw headers this module already owns, so the auth
  decisions need no Fastify `trustProxy`. The same env does set Fastify
  `trustProxy`, but only the request logger reads `request.ip` (§4). M15's throttle
  verdict is recorded in §7. The graph uses library bootstrap cookies and
  native authentication/Host/Origin replies. Primary `sendRawJson`, the last
  `http.ts` serializer and duplicated raw security setters are deleted; neither
  auth gate hijacks responses. Auth-family revocation retains only its domain
  index of open responses, not another HTTP transport.
- **Phase 4 — complete**: M12 is complete. First-party Files returns the
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
  main/rebuild tests and the real-socket graph runtime suite. M10 is complete:
  all four streams use the shared maintained transport, with existing JSON
  data/replay semantics, pressure limits, timers and late-startup cleanup
  covered by deterministic producer tests and real sockets. The shared HTTP
  zone cannot import either host runtime (enforced by `web-boundaries.test.ts`).
  `npm run tidy`, `npm run lint:dead` and both browser e2e suites pass.
- **Phase 5 — complete**: M14 uses Fastify request ids plus a shared
  `web/core/http/observability.ts` logger (`warn` level, credential-safe
  request serializer that drops the query string). Primary logging goes to
  stdout, the graph routes the same structured logs into its existing file
  sink; startup/process messages and the plugin action audit are unchanged.
  `request-logging.test.ts` pins request ids and that no query/header/body
  secret reaches a log line. Oversize JSON bodies on the primary host answer 400 `request body too large`
  and are not logged as server errors (`app.test.ts`). The unused plugin pins were
  removed from `web/package.json`. The removal audit below was run over **all**
  production source under `web/` and is enforced by
  `tests/web-legacy-dispatchers.test.ts`.

## 11. Removal audit (release)

Audited every production file under `web/` (tests, build output, e2e drivers
and the vendored `app/` assets excluded) for listener creation, URL/method
routing, raw response writes, body consumption, cookie serialization, JWT
signing, SSE framing/heartbeat, static MIME/path delivery and Range parsing.
Remaining occurrences and their classification:

| Location | What remains | Why it is not generic infrastructure |
| --- | --- | --- |
| `web/core/http/sse.ts` | `@fastify/sse` `stream()` adapter, `raw.flushHeaders()`/pipe/`destroy()`/`writableLength` | E5: byte-budget flush/abort the plugin does not expose; framing/heartbeat/close are the plugin's |
| `web/core/server/legacy-plugin-transport.ts` | header copy, `reply.hijack()`, `raw.destroy()` | E2: the single permitted external-plugin raw escape hatch |
| `web/core/server/plugin-routes.ts` | `reply.raw` as the legacy `transport` value and its close/abort listeners | E2 contract; first-party handlers return body/stream results |
| `web/core/server/auth.ts` | `node:http` types, `request.raw` policy reads, `reply.raw` revocation index | E4/E6: proxy/CSRF/Secure policy adapter and logout/revocation cutting open responses (destroy only, never writes) |
| `web/core/server/client-static.ts` | `onSend` shell read + build-ID stamp + `content-length` fix | M11: the one narrow HTML transform the PRD keeps |
| `web/core/server/files.ts` | descriptor `O_NOFOLLOW` open, `range-parser`, `content-disposition` | E1: descriptor safety/root policy; range/disposition are maintained utilities |
| `web/core/plugin-contracts/kernel/routes.ts` | `normalisePath` registration validation | M3: validates plugin-declared registration paths before feeding the maintained `find-my-way` matcher; it does not match requests |
| `web/plugins/subagent-graph/lib/server.ts` | `net.listen(path)` liveness probe | domain singleton fallback on non-Linux, not the HTTP listener |
| `web/plugins/subagent-graph/lib/server-main.ts` | `process.stdout`/log-file writes | process/startup messages (M14 preserves them) |

No legacy dispatcher symbol remains: `matchSegments`, `splitRequestPath`,
`API_ROUTES`, `handleApi`, `matchRoute`, `readJsonBody`, `readSmallJson`,
`sendRawJson`, `parseCookies`, `MIME_TYPES`, `resolveStaticPath`,
`closeAllConnections` and `.writeHead(` are absent from production source.
`reply.raw` is confined to the E2/E5/E6 files and `node:http` types to the
auth seam; both are asserted by `tests/web-legacy-dispatchers.test.ts`.

- **Release status**: M1–M15 are resolved (M15 retained by verdict, §7). No
  mandatory row is incomplete; the exception ledger names owner, protecting
  test and removal condition for each seam. Remaining work is ordinary
  maintenance as those removal conditions are met.
