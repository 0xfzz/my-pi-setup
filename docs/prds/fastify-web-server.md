# PRD: Replace handwritten web HTTP infrastructure with Fastify

> Part of [pi-workflow-extensions](../../README.md). Move both web HTTP hosts and all replaceable HTTP plumbing onto Fastify and its maintained ecosystem, not just a framework wrapper around the existing dispatchers.

| Field | Value |
| --- | --- |
| **Status** | draft — implementation requirements, not current runtime behavior |
| **Owner** | Faiz |
| **Detail for** | [Pi Web](../pi-web.md), [Subagent graph](../subagent-graph.md) |
| **Scope** | Both HTTP servers under `web/`; core/plugin routing; auth transport and JWT codec; bodies, validation, cookies, security headers, SSE, static/files transport, lifecycle, dependency manifests, and tests |
| **Target** | Supported Fastify v5 and compatible maintained plugins; npm reported `fastify@5.12.8` when researched |
| **Verified against** | Current source and upstream documentation; acceptance criteria below describe work still to be implemented |
| **Related** | [Minimal pi-web](minimal-pi-web.md), [plugin platform](pi-web-plugin-platform.md), [web plugin architecture](../web-plugin-architecture.md) |

- **What it is** — a comprehensive replacement of generic handwritten HTTP infrastructure with the Fastify stack.
- **Why it exists** — stop maintaining routing, parsers, serializers, cookies, and streaming mechanisms already supplied by maintained libraries.
- **How it is enforced** — a replacement/removal inventory, contract tests, socket tests, and repository verification gates.
- **What it refuses** — legacy catch-all dispatchers, indefinitely deferred transport rewrites, and silent security regressions.
- **What it cannot do** — replace application policy, session ownership, filesystem authorization, or trusted-plugin isolation with framework defaults.

## 1. Product decision and success definition

Use **Fastify**, not H3. Rewrite the HTTP infrastructure rather than adapt the old server wholesale. Fastify should own the listener, route registration, hooks, body consumption, validation integration, replies, error lifecycle, and shutdown. Maintained ecosystem packages should own generic cookies, security headers, JWT encoding/verification, static delivery, and SSE transport.

**All handwritten routing is in scope**, including the standalone subagent-graph host and the plugin kernel's segment matcher. Generic HTTP mechanisms may not remain merely because wrapping them is easier. Application decisions remain ours: which credential is valid, which session owns a bridge, which plugin may register routes, which file may be read, and which events may be dropped.

Success means:

1. Both hosts run on Fastify; no production handwritten HTTP dispatcher remains under `web/`.
2. Every replaceable mechanism in §3 has been replaced and its redundant implementation removed.
3. Every retained custom component is a small, documented policy/compatibility seam with a test proving why a maintained implementation cannot replace it safely.
4. Browser, TUI bridge, plugin, and graph workflows continue to work without a coordinated client rewrite.

This is a maintainability and reliability project. It does not promise faster requests, a different API, a new UI, or cross-runtime portability.

## 2. Scope and boundaries

### Included

- `web/server.ts` and `web/core/server/`: composition, main host, every core/auth/admin route, plugin HTTP entry points, SSE, and file transport.
- `web/core/plugin-contracts/kernel/routes.ts`: remove handwritten request matching; preserve capability/lifecycle/budget policy and framework-neutral public contracts.
- `web/core/auth/`: replace generic JWT mechanics; evaluate generic throttling against maintained alternatives while preserving auth state semantics.
- `web/plugins/files/server/index.ts`: migrate first-party downloads away from raw-response ownership.
- `web/plugins/subagent-graph/lib/server.ts`: listener, routing, cookies, producer bodies, static delivery, SSE, headers, errors, and HTTP teardown.
- Root and web manifests/lockfiles, affected tests, and operator/architecture documentation.

The graph host is **required**, not a deferred follow-up. It stays a separate loopback service with its own credentials and lifecycle; this project does not merge its API or auth with pi-web.

### Not included

- Rewriting session execution, Pi commands, bridge ownership, plugin business logic, graph lease/revision state, or persistence.
- Replacing SSE with WebSockets, introducing cross-origin access, or changing frontend schemas for convenience.
- Replacing password hashing/HKDF/randomness supplied by `node:crypto` with another homegrown implementation.
- Generic plugin sandboxing, unrelated UI work, a new build system, or broad repository cleanup.

“Not included” does not exempt the HTTP adapters around these domains from migration.

## 3. Mandatory replacement and removal inventory

Every row must have implementation evidence or a narrowly approved exception before release. An exception cannot simply say “preserve existing implementation.”

| ID | Handwritten implementation today | Required replacement | What must remain application-owned |
| --- | --- | --- | --- |
| M1 | `main.ts` listener and `handleRequest`; graph `createServer` and `#handle` | Fastify factories, `listen`, hooks, route modules, `close` | Startup identity, options/env mapping, graph singleton and metadata |
| M2 | `routes.ts` `API_ROUTES`, regex captures, `matchRoute`, `handleApi`; auth/admin method dispatch; graph `#api`/`#requireMethod` | Native Fastify routes, params, prefixes, route metadata, schema validation | Handlers calling session/plugin/graph services |
| M3 | Kernel `matchSegments`, request splitting, per-entry route scanning | Maintained Fastify router technology (`find-my-way`) behind the kernel route facade; details in §5 | Registration grants, namespace ownership, route diagnostics, revocation, invocation budget |
| M4 | `http.ts` JSON serialization; duplicate auth/graph `sendJson`/`sendText` and `writeHead` | `reply.code`, `reply.header`, `reply.type`, `reply.send`, redirects, central error/not-found hooks | Existing status/envelope/cache policy |
| M5 | `readJsonBody`, auth `readSmallJson`, graph `readBody`/`#readEnvelope` byte accumulation | Fastify body reader, route `bodyLimit`, built-in JSON parser or scoped `parseAs` compatibility parser | Empty-body and endpoint error mappings; no second stream reader |
| M6 | Repeated HTTP field/type/length validation in handlers | Fastify full JSON Schemas for body, params, query, and headers where equivalent | Cross-field/domain invariants, known-session/plugin checks, action confirmation/audit ordering |
| M7 | Auth/graph `parseCookies`, cookie string concatenation and clearing | `@fastify/cookie` parsing and set/clear APIs | Cookie names/paths/expiry, credential precedence, Secure policy, graph bootstrap session store |
| M8 | Repeated security header setters | `@fastify/helmet`, configured explicitly per host/route | Existing CSP/trust policy and special cache headers |
| M9 | `web/core/auth/jwt.ts` handcrafted compact-JWT parsing, HMAC signing, verification | `@fastify/jwt` / its maintained `fast-jwt` codec; one codec, not parallel implementations | Purpose-separated keys, required claims, revocation, rotation/grace state, error mapping |
| M10 | Repeated SSE headers, framing, heartbeat loops, connection close/error plumbing in event-stream/bridge/graph | Maintained `@fastify/sse` transport and lifecycle APIs, shared configuration | Event projection, snapshots, coalescing, drop/backlog policy, bridge registration healing, graph notification debounce |
| M11 | Main/graph static URL-to-file handling, MIME maps, manual asset streaming | `@fastify/static` / `@fastify/send`, configured roots, MIME/cache options, allowed-path policy | Build-ID HTML stamping, graph fallback page/CSP, SPA-vs-API fallback decisions |
| M12 | Files `parseRange`, download header assembly, `stream.pipe(res)`, manual response completion | Fastify stream replies plus maintained file/range/content-disposition utilities; static/send helpers where safe | Authorized descriptor acquisition, root/symlink/size policy, hook veto, forced attachment rules |
| M13 | HTTP shutdown/connection bookkeeping duplicated across hosts | Fastify `preClose`/`onClose`, `close`, configured forced connection closure, stream-plugin cleanup | Bounded process teardown, child cleanup, graph singleton release, watchers |
| M14 | Custom request diagnostics where a framework facility exists | Fastify request IDs and configured structured logging/error hooks | Safe redaction, existing process/startup messages, plugin action audit |
| M15 | `LoginThrottle` generic counters/windows/eviction | Evaluate `@fastify/rate-limit` and its store/manual APIs; replace equivalent mechanisms, document non-equivalent policy | Failure-only accounting, pre-hash admission, success refund/reset, separate global backstop |

M1–M14 are mandatory migration work; M12 may retain only the minimal descriptor-safe adapter explained in §8. M15 is an explicit equivalence investigation, not permission to weaken lockout or add a redundant limiter. Do not add unused plugins just to satisfy an inventory row.

## 4. Framework, versions, and dependency ownership

Use a supported Fastify v5 release and compatible plugin majors. Research baselines: Fastify `5.12.8`, `@fastify/static` `10.1.11`, `@fastify/cookie` `11.1.5`, `@fastify/helmet` `13.2.0`, `@fastify/jwt` `10.2.8`, `@fastify/sse` `0.6.1`, `@fastify/rate-limit` `11.2.2`, and `find-my-way` `9.10.1`. These are discovery results, not a tested dependency set.

- Pin the versions selected during feasibility and verify their compatibility tables, exports, types, Node requirements, and tests. Official ownership does not make every plugin equally mature: the researched SSE package is pre-1.0 and needs an explicit stability/wire/lifecycle review.
- Verify the repository's declared minimum Node `22.6.0` and the development runtime; no silent runtime-floor increase. Use APIs from the selected version, not unpinned `latest` documentation.
- Map actual imports from both launch paths: `web/` installs and root extensions/tests that import graph/auth/kernel modules. Declare direct dependencies in each independently supported package as necessary; update **both lockfiles when affected**. Do not depend on accidental nested installs, hoisting, or undeclared transitive imports.
- If using `find-my-way` or `fast-jwt` directly, declare it directly. Keep Fastify types out of browser/shared/plugin public contracts; internal runtime implementations may depend on a maintained router or codec.
- Keep the existing esbuild/TypeScript/tsx/direct-strip-types workflows. Test root-only and web setup assumptions explicitly.
- No Express/connect middleware bridge, H3/srvx dependency, or `serverFactory` retaining the old dispatchers as the final architecture.

## 5. Routing architecture — including dynamic plugins

```text
web/server.ts                         existing plugin composition root
  -> createWebApp(options)             Fastify app factory, no listener/signal hooks
       -> cookie + security plugins
       -> early API authentication hook
       -> native auth/core/admin route modules + schemas
       -> stable plugin namespace routes
            -> live library-backed plugin matcher
            -> capability/session-root/budget policy
            -> framework-neutral result -> Fastify reply
       -> SSE plugin + event producers
       -> static plugin + narrow stamped-shell fallback
       -> error/not-found/method compatibility policy
  -> startWebServer(options)           listen, watcher hooks, same public handle

standalone graph runtime
  -> separate Fastify factory         same HTTP mechanisms, separate host/auth/state
  -> singleton/metadata/lease owner    unchanged domain lifecycle
```

The factory names are proposed. Constructing an app does not listen or install competing signal handlers. `ready()` may initialize framework plugins; domain/background resources must have explicit lifecycle ownership.

### 5.1 Core and graph routes

Register actual Fastify routes. Remove regex dispatch tables and URL switches; do not relocate them into a Fastify catch-all. Use `request.params`, parsed bodies, route configuration, and built-in prefixing. Generate any method-compatibility registration from the **same route declarations**, not a duplicate route table.

Fastify's defaults differ from the current server: automatic HEAD routes, method misses normally becoming 404, body/content-type rules, parameter length, trailing slashes, and plugin encapsulation. Set these intentionally and test them. Primary-host GET routes must not acquire HEAD side effects; disable automatic HEAD exposure there. Graph static GET/HEAD behavior is independently preserved.

Preserve core known-path 405 versus unknown-path 404 using supported router lookups or generated method fallbacks. Do not implement a second handwritten matcher for this. Generate `Allow` only where the contract requires it. Error/method fallback routes must reject before parsing an irrelevant body.

### 5.2 Dynamic plugin routes: replace the matcher, retain the capability facade

Fastify does not support ordinary route registration/removal after readiness. Plugins currently register, unregister, disable, reload, and quarantine routes while the listener stays up. A startup-only Fastify route snapshot is not sufficient.

Required design:

1. Retain `ctx.routes.get/post/...`, `register`/unregister, `removeOwner`, `list`, and invocation-budget semantics as framework-neutral APIs.
2. Replace the kernel's handwritten segment matching with an explicitly declared **`find-my-way`** runtime matcher, the maintained routing technology used by Fastify. Its public add/remove/find APIs support live registration; do not mutate Fastify private internals.
3. Register stable Fastify entry routes for the bare plugin mount and descendant paths. They perform namespace auth, obtain the raw scoped pathname without double-decoding Fastify's already-decoded wildcard, and use the library matcher to resolve the active handler.
4. Keep ownership/grant checks before registration and current-liveness checks before invocation. Lifecycle changes update the matcher and diagnostics atomically; failed activation rolls back its routes. No server restart and no loss of unrelated SSE connections.
5. Use library lookups for wrong-method detection. Retain only allowed-method iteration, not per-pattern matching.
6. Preserve existing normalization where supported (including plugin mount roots/trailing slashes). Characterize overlapping static/param routes, equivalent parameter shapes, duplicate registration, parameter names, and percent encoding. The old matcher is first-registration-wins; `find-my-way` has specificity precedence. Record and approve any intentional precedence/ambiguity change; do not claim they are identical.

This stable namespace gateway is permitted because **its matcher is replaced**. A gateway still calling `matchSegments` is not completion. If an all-native-Fastify generation-swap design is chosen instead, it needs a reviewed replacement design proving immediate disable, atomic failure rollback, bounded generation cleanup, and unchanged connection lifetimes before implementation; it may not become an excuse to keep custom routing.

## 6. Request lifecycle, schemas, errors, and auth

### 6.1 Authentication before parsing or validation

For pi-web, preserve exact `/api` or `/api/` namespace classification; `/apiary` is not API. Keep static/login-screen assets and health public. The four recognized auth paths retain their existing public entry behavior and method errors; unknown `/api/auth/*` paths remain protected.

Use an early `onRequest` auth hook that applies to protected valid routes, method fallbacks, and not-found handling **before body parsing or schema validation**. Verify encapsulation and not-found behavior rather than assuming prefix registration protects every miss. Unauthenticated callers must not get parsing/schema details or an SPA shell instead of an auth response.

Replace `createAuthHttp` raw request/response dispatch with native Fastify auth routes/hooks. The auth service still owns enabled/disabled/invalid modes, password verification, token families, expiry, and revocation. Cookie parsing precedes hooks that consume cookies. Browser credentials never become a bridge token. Authenticate and enforce graph host/origin/producer/browser rules independently in the graph app.

### 6.2 Bodies and structural validation

Fastify consumes request bodies exactly once and enforces limits as bytes arrive, including chunked bodies. General pi-web limit remains **60,000,000 bytes**; auth routes remain **4,096 bytes**; graph producer routes use the configured `maxSnapshotBytes`. Never preserve a manual accumulation loop behind a hook or parser.

Use full JSON Schemas for HTTP shape/type/required/length/enum/range checks that can be expressed declaratively. Keep cross-field/application checks in pure validators. Preserve action validation/confirmation/audit ordering and validate `unknown` before invoking domain operations. Do not compile untrusted plugin-supplied schemas or strip extension-owned fields through restrictive response schemas.

Explicitly configure Ajv coercion/default insertion/additional-property behavior so validation does not silently mutate requests or drop supported fields. Use `attachValidation` or scoped schema error mapping if needed to preserve established endpoint error ordering. Output schemas must cover every intended response field before using them for serialization.

Characterize empty bodies, JSON primitives/arrays, missing or misleading Content-Type, DELETE bodies, duplicate query keys, invalid JSON, prototype-related keys, and oversize failures. Main/auth handlers historically parse JSON without consulting Content-Type; graph producer handlers require JSON. A small scoped `parseAs: 'string'`/`'buffer'` adapter and the framework's JSON parser are allowed to preserve those contracts; Fastify still owns accumulation, length checks, and caps. Preserve `{}`/undefined/parse-failure behavior where required, or document a reviewed change. Do not add multipart or URL-encoded support by accident.

### 6.3 Replies and errors

Use Fastify replies for JSON, HTML, redirects, and streams. Remove duplicate `sendJson`/`sendText` helpers and handwritten status/header/body emission. A policy helper may set response/cache options but must not become another transport implementation.

Use scoped `setErrorHandler`, `setNotFoundHandler`, schema error mapping, and documented framework-error handling. Preserve meaningful status/code/envelope contracts, including auth 401/403/429/503 and plugin 502 outcomes. Map body-limit/parser failures explicitly: replacing historical endpoint-specific 400/500 outcomes with global 413 is a behavior change requiring a documented decision.

Unhandled failures remain sanitized `500 { "error": "internal error" }`; no stack, password, cookie, bearer/bridge/producer token, or bootstrap query token leaks. Errors after stream headers are committed close the stream through its transport API, never attempt a second JSON response.

### 6.4 Cookies, JWT, headers, and proxy policy

- Use `@fastify/cookie`; preserve `pi_web_at`/`pi_web_rt`, graph cookies, paths, HttpOnly/SameSite, expiry, Secure detection, duplicate-cookie behavior, and multiple `Set-Cookie` headers. Cookie parsing/serialization differences need tests; no separate handcrafted cookie parser survives by default.
- Replace JWT mechanics with the `@fastify/jwt` stack. Prefer a `fast-jwt` codec seam for HTTP-independent `WebAuthService`; use one underlying implementation if HTTP decorators are also registered. Require **HS256 only**, existing key derivation and `kid`, issuer/audience, `typ`, purpose/use, required claim types, token-length cap, and injected clock/leeway behavior. Expiry alone is not authorization: always check live revocation/refresh-family state. Cached verification must never bypass password changes or logout.
- Test old-token/new-verifier and new-token/old-verifier compatibility, including refresh tokens, before cutover. No auth-store migration, rotated secret, or forced logout merely to adopt a library.
- Configure `@fastify/helmet` to reproduce each host's actual policy. Primary responses retain `nosniff`, `no-referrer`, and `X-Frame-Options: DENY`; graph retains its additional origin-isolation headers and HTML CSP. Do not enable default CSP/HSTS/COEP or change localhost/viewer behavior accidentally. Verify errors, static replies, and SSE, not just JSON success.
- Map `PI_WEB_TRUST_PROXY` through Fastify's supported trust configuration where equivalent. Existing last-hop throttling keys, forwarded-host/proto selection, HTTPS-Origin Secure detection, and `PI_WEB_ALLOWED_ORIGINS`/CSRF rules are not necessarily identical to Fastify defaults. Keep only a small tested policy adapter for such differences, not the old raw auth gate.
- Evaluate `@fastify/rate-limit` for M15. A per-request fixed window does not automatically replace failure-only rolling accounting, pre-hash charging, success refund, global backstop, and lock duration. Replace equivalent counters/configuration; retain only irreducible policy when a tested mismatch exists. Do not simply copy a post-password “count failures” example that permits concurrent guesses to bypass admission.

## 7. SSE: migrate the mechanism, preserve the event model

Migrate **all** SSE transports: agent stream, session-directory stream, TUI bridge attach, and standalone graph events. Use the tested `@fastify/sse` release for framing, headers, connection lifetime, heartbeat, send/backpressure integration, and cleanup. Do not retain entire `event-stream.ts`/bridge/graph transports under `reply.hijack()` as the final implementation.

Keep event production separate from the SSE writer. Preserve:

- Existing JSON data events, preambles, ordering, connection/startup errors, snapshots, reconnect/mid-turn replay, session replacement, and bridge ownership.
- Main streams' 30-second heartbeat, 150-ms tool-progress coalescing, droppable threshold **512 KiB**, and close/reconnect above **16 MiB** backlog. These are application pressure decisions, not automatically supplied by a plugin's stream backpressure.
- Bridge heartbeat ownership-healing and graph notification debounce, `retry: 2000`, client/buffer caps, and configured ping interval. Do not conflate a heartbeat that carries domain work with generic transport keepalive.
- `text/event-stream`, applicable cache policy, and `X-Accel-Buffering: no`; immediate flush before a slow session startup. No compression/buffering or framework handler timeout that kills healthy streams.
- Immediate cancellation on logout/revocation, disconnect, session replacement, and shutdown; timers/subscriptions released once, including late-resolving startup work.

Review Accept negotiation and serialization against the pinned SSE version. Browser EventSource, bridge clients, missing Accept, and fetch's `*/*` must work; use supported manual/SSE-only mode as appropriate. Objects must not be double-JSON-encoded or converted into named events the client never listens for. A plugin's auto-close on handler resolution must not close live subscriptions.

Do not replace bounded Node buffering with an unbounded promise chain, async-iterator queue, or per-client backlog. Account for bytes in all buffering layers. If the researched plugin cannot satisfy required behavior, select another maintained compatible transport in feasibility and record why; a custom SSE framework is not an acceptable fallback without explicit scope approval.

## 8. Static delivery, downloads, and legacy plugin transport

### 8.1 Public built assets

Use `@fastify/static` for both built asset roots, with directory listing off and explicit MIME/cache/dotfile/index/redirect/HEAD policy. Disable or configure ETags, Last-Modified, redirects, and immutable caching if they would change the existing contract. Do not glob once at boot if rebuilds create assets that must become visible immediately.

Keep a narrow HTML transformation for build-ID stamping and the primary extensionless SPA fallback. Unknown assets remain 404; no API miss returns HTML. Graph keeps its restricted asset types, CSP, fallback index, and static HEAD support. Static roots never include source trees, project files, auth config, or runtime metadata.

Use the plugin's containment mechanism and allowed-path hooks; remove redundant URL-to-static-path/MIME/streaming code once equivalent protection is proven. Do not remove audited path validation when the library does not cover the same condition.

### 8.2 Session-scoped Files downloads

Fastify and maintained utilities own generic file response semantics, stream transfer, range parsing, MIME lookup, filename encoding, and completion. The application still resolves the session root and applies `file.before-read`, traversal/backslash/percent/NUL checks, symlink restrictions, size caps, and attachment-for-HTML/SVG/unknown-content rules.

**Descriptor safety is non-negotiable:** a pre-validated pathname passed to a helper that reopens it may reintroduce a symlink/TOCTOU escape. Prove the selected file utility can preserve authorized `O_NOFOLLOW` descriptor ownership. Otherwise send the already-open descriptor stream through Fastify and use maintained range/content-disposition utilities; retain only the small policy/descriptor adapter, not the old HTTP implementation. Keep descriptor close/destroy behavior on abort/error/normal completion.

Characterize full 200, partial 206, suffix/open ranges, invalid/multiple/unsatisfiable ranges, zero-byte files, exact bytes/content length, disposition, and private/no-store. Current invalid-Range fallback versus library 416 defaults must be explicitly reconciled. Do not silently remove media seeking or weaken containment to delete more code.

### 8.3 Plugin streaming result and compatibility

First-party Files must move from `transport.request/response` and `{ handled: true }` to a **framework-neutral optional stream/result contract** adapted into Fastify replies. No plugin public contract accepts a `FastifyReply` or imports Fastify types. Keep existing JSON status/body/headers and invocation-budget behavior.

Preserve old plugins through a **single bounded legacy raw-transport adapter** using the real `request.raw`/`reply.raw` and documented `reply.hijack()` ownership. It is the only permitted general raw response escape hatch. Prove timing for plugins that write before returning, return `handled: true`, throw/time out, or disconnect; no auto-send, double response, missing security headers, or leaked stream. Never manufacture a fake Node response.

This exception protects an existing external contract; it is not a place to leave first-party handwritten HTTP code. Document its API/deprecation boundary and test both legacy and new paths.

## 9. Route and behavior inventory to characterize

### Primary host

| Routes | Methods / behavior |
| --- | --- |
| `/api/health` | GET; public, service/boot/build identity |
| `/api/auth/status`, `/api/auth/{login,refresh,logout}` | GET status; POST mutations; existing method/error/cookie contracts |
| `/api/plugins`, `/api/plugins/action` | GET registry; POST action validation, confirmation, audit, relay |
| `/api/plugin-manager`, `/api/plugin-manager/:id/:command` | GET report; POST lifecycle/capability command; preserve command syntax |
| `/api/bridge/:id/{attach,events,detach}` | GET SSE attach; POST events/detach; bridge credentials |
| `/api/directories`, `/api/sessions`, `/api/sessions/events`, `/api/sessions/:id` | GET picker/list/SSE; DELETE session |
| `/api/agent/new`, `/api/agent/:id` | POST creation; GET state/POST command |
| `/api/agent/:id/{events,history,commands,tree,models,branch}` | GET, including SSE |
| `/api/agent/:id/{pi_api,model,thinking}`, `/api/changelog` | POST agent operations; GET changelog |
| `/api/p/:pluginId` and descendants | Dynamic plugin methods, root/param routing, 404/405/502/lifecycle |
| Static root/assets/extensionless paths | Public GET; build identity and SPA rules |

### Standalone graph host

| Routes | Methods / behavior |
| --- | --- |
| `/bootstrap` | Existing token validation, browser cookie issuance, redirect and method behavior |
| `/api/health` | GET, producer or browser auth (unlike public pi-web health) |
| `/api/{sessions,session,artifact,events}` | GET, browser auth; events is SSE |
| `/api/producer/{publish,heartbeat,unregister}` | POST, producer auth, bounded JSON envelopes |
| Static assets and fallback index | GET/HEAD; host/origin checks, MIME allowlist and CSP |

Preserve service identity, query duplicate/first-value semantics (`URLSearchParams` where required), literal-vs-param precedence, plugin-manager command restrictions, and graph's own auth/method ordering. Do not automatically apply pi-web's public-health exception to graph.

Test trailing/repeated slashes, case, long IDs, malformed `%`, encoded separators, nested escapes, dot segments, encoded API/bridge prefixes, HEAD/OPTIONS, missing hosts, and wrong ports. Fastify decodes params/wildcards; never decode twice or trust decoded values as filesystem paths. Request classification/auth and handler resolution must agree. Bad-URL handling may precede hooks; sanitize framework-level errors without pretending the normal lifecycle ran.

**Compatibility rule:** retain supported contract behavior by default. Library-native differences (e.g. malformed-path JSON 400, structural-route precedence, stricter parser rejection) may be adopted only through an explicit old/new decision table and regression tests. Do not preserve a whole custom mechanism merely to retain incidental quirks, and do not silently change user-visible behavior to make the migration easier.

## 10. Startup, shutdown, observability, and delivery

Preserve `StartWebServerOptions`, `WebServerHandle { port, host, close() }`, injected auth/static roots, env defaults, port `0`, listen-error rejection, process identity, `PI_WEB_SERVER_PROCESS`, build watchers, and fixtures. Preserve graph preferred-port fallback, singleton lock, private token/metadata permissions, idle/producer expiry, instance identity, and cleanup ordering.

Use Fastify lifecycle hooks for resource acquisition/release, forced active-connection shutdown where required, and no competing signal handlers. Close live SSE before awaiting a hook that could otherwise wait forever; repeated close and failed startup must release resources. Existing bounded process teardown, orderly plugin shutdown, and synchronous child cleanup remain application-owned.

Use Fastify logging/request IDs if request diagnostics are enabled; preserve current operational messages and redact URLs/headers/bodies containing credentials, especially graph bootstrap tokens. Framework logs do not replace plugin action audit. No new external telemetry dependency.

## 11. Implementation plan and exit gates

Each phase is a separately verified, coherent commit boundary. This document authorizes a PRD, not runtime changes; implementation follows approval.

| Phase | Deliverable | Exit gate |
| --- | --- | --- |
| 0. Characterize and select stack | Full M1–M15 inventory, pinned compatibility/Node matrix, old/new behavior decisions, SSE and descriptor/range spikes, dynamic-matcher proof, throttle equivalence report | Demonstrate native JSON/auth, live route add/remove, SSE/revocation, safe range download/abort, and bounded close; record blockers before broad rewrite |
| 1. Fastify foundations | Both app factories, dependencies, hooks, errors, body parsers, cookie/Helmet configuration, lifecycle | Launch/port-0/bind-failure/close tests; no framework-policy drift |
| 2. Native routing and schemas | Rewrite all core/auth/admin/graph routes; replace kernel matcher; migrate HTTP structural validation | No legacy dispatchers/segment matcher; dynamic lifecycle and method/auth matrix pass |
| 3. Auth mechanisms | Library cookies/JWT, native auth HTTP hooks, trust adapter, equivalent limiter replacements | Existing/new auth and old/new-token interoperability tests; no secret/store migration |
| 4. Streaming and files | Plugin-backed SSE everywhere, static plugin on both hosts, safe streamed Files result, isolated external-plugin compatibility adapter | Real-socket ordering/flush/pressure/revocation, media range, abort/FD, rebuild, and graph tests pass |
| 5. Removal and release | Delete superseded helpers/dependencies, finish inventory/exception ledger, update operator notes | Full gates, browser/TUI/standalone checks, clean committed tree; no incomplete mandatory row |

Temporary wrappers are permitted only between commits while migrating. They do not satisfy completion, and no phase is a release until all mandatory rows are done. Keep behavior-change commits separate from refactoring. Avoid directory deletion while the pi watcher is running; retire files in place and follow repository instructions for directories.

## 12. Acceptance criteria and verification

| ID | Criterion | Required evidence |
| --- | --- | --- |
| AC1 | Both hosts use Fastify and no handwritten HTTP router remains | Source review: no production `createServer` dispatcher, `handleApi` regex loop, graph path switch, or kernel `matchSegments`; native route declarations plus maintained dynamic matcher |
| AC2 | Generic HTTP mechanisms are actually replaced | Completed M1–M15 ledger naming replacement APIs, deleted symbols/files, and tests; justified narrow exceptions only |
| AC3 | Auth/trust/security are unchanged or explicitly reviewed | `web/core/server/auth.test.ts`, root `tests/web-auth.test.ts`, old/new JWT interop; cookie/CSRF/proxy/HEAD/miss/parser/normalization regressions; graph independent auth/host tests |
| AC4 | Bodies/schemas/errors preserve the supported API | Route-family matrix using `app.inject()`: limits/chunked cases, empty/content-type/invalid bodies, mutation/coercion, 404/405, action ordering, complete response fields |
| AC5 | Plugin route lifecycle remains dynamic and safe | `tests/web-plugin-routes.test.ts`, manager/host suites; root/params/overlaps, live register/unregister/reload/disable/quarantine, failed activation rollback, 502 budgets, new/legacy streamed responses |
| AC6 | SSE migration preserves wire and bounded resource use | Event-stream/directory/bridge tests plus root `tests/web-bridge-*.test.ts`; real sockets for early flush, disconnect, slow readers, queue limits, reconnect, revocation, and close |
| AC7 | Static/Files delivery stays safe and functional | `files.test.ts`, `files-stream.test.ts`, viewer e2e; traversal/symlink/race/size/attachment/Range/zero-byte/abort-FD tests; build stamping/reload and graph static CSP/HEAD |
| AC8 | Graph migration is complete, not deferred | `tests/subagent-graph-runtime.test.ts`, `tests/subagent-graph-process.test.ts`; bootstrap, producer publish/lease/stale-revision/heartbeat/unregister, SSE caps, singleton/port fallback/idle shutdown |
| AC9 | Runtime and dependency setup work independently | Minimum/development Node, root/web installs, tsx and direct strip-types launch, `/web start/reload/stop/status`, graph detached launch; bind-failure and repeated-close tests |
| AC10 | End-to-end workflows and repository gates pass | Browser login/refresh/logout, prompt/abort/reconnect, plugin actions, Files preview/download, build reload, TUI bridge and graph UI; commands below; clean git status and scoped commits |

Use Fastify `inject()` for finite HTTP tests, not a new homegrown request harness. Injection does not establish actual socket trust, streaming flush/backpressure, client abort behavior, or forced shutdown; keep socket/process tests for those. Deterministic unit tests cover scheduling/pressure/domain policy without sleeps. Inspect the actual browser result when claiming end-to-end success.

Before each completed implementation commit and the final documentation commit:

```sh
npm run tidy
# When implementation adds/moves/removes code files or exports:
npm run lint:dead
# Implementation release acceptance, separate from tidy:
npm --prefix web run test:e2e
```

`tidy` runs typecheck, smell lint, root tests, and web checks/build/tests. There are no accepted baseline failures: the former native regular/fullscreen TUI clipping baseline was fixed in the test fixture (the `test(provider)` commit bound the real dialog methods), not waived. Record unrun/blocked browser prerequisites honestly; they are not green acceptance.

### Release evidence

Recorded on 2026-11-16 against the completed tree, Node v22.23.2:

| Criterion | Command | Result |
| --- | --- | --- |
| AC10 repository gate | `npm run tidy` | pass — root tests 0 failures, web `447/447`, typecheck and smell lint clean |
| AC2 dead code | `npm run lint:dead` | pass; `web/` is not yet a `knip` scope (see [smell-baseline](../smell-baseline.md)) |
| AC10 browser e2e | `npm --prefix web run test:e2e` | pass — `e2e.mjs` and `files-viewers.e2e.mjs` both "all checks passed" |
| AC9 direct strip-types launch | `cd web && PI_WEB_PORT=0 node --experimental-strip-types server.ts` | pass — bound an ephemeral port, `/api/health` 200, clean SIGTERM stop |
| AC9 tsx launch | `cd web && PI_WEB_PORT=0 ./node_modules/.bin/tsx server.ts` | pass — same health/stop outcome |
| AC9 Node floor | `node -v` | v22.23.2 (repository engine floor 22.6.0) |

AC9's "minimum Node" and clean-install-from-scratch checks were not exercised on this machine; only the development runtime above was. They remain open acceptance items, not waived ones.

The root test **total** is not deterministic: repeated `npm test` runs on the same tree reported between 1972 and 1998 tests, always with `fail 0` / `cancelled 0`. A file whose process is force-exited can under-report its subtests. Treat `fail 0` as the gate, not the total; the count variance is a runner observation, not a coverage guarantee.

### Removal audit and exception ledger

At release, inspect **all production source under `web/`**, not just touched files. Record every surviving occurrence of listener creation, URL/method routing, raw response writes, body consumption, cookie serialization, JWT signing, SSE framing/heartbeat, static MIME/path delivery, and Range parsing. Tests/fixtures, domain event serialization, and deliberate descriptor/raw-compatibility seams must be distinguished from generic HTTP mechanisms. Add architecture tests for forbidden legacy dispatchers and keep the audit readable rather than enforcing a blanket ban on `node:http` types or `JSON.stringify`.

Every exception names: location, behavior that cannot safely be delegated, evaluated library/API and mismatch, minimal retained code, owner, protecting test, and removal condition. Mandatory migration rows cannot be waved through with a vague compatibility label. The only predefined categories are domain policy, descriptor-safe file access, the external-plugin raw contract, and demonstrably non-equivalent lockout semantics. Any additional infrastructure exemption needs explicit approval.

## 13. Risks, rollout, and rollback

| Risk | Required mitigation |
| --- | --- |
| Merely replacing `createServer` leaves the old framework inside Fastify | M1–M15 removal ledger and AC1/AC2 block release |
| Fastify route immutability breaks plugin reload | Supported dynamic `find-my-way` facade; no private Fastify mutation or restart |
| Defaults change auth ordering, content types, HEAD, cookies, schema mutation, or status codes | Characterization matrix and explicit options/error adapters |
| Maintained plugin cannot preserve SSE pressure/lifetime or descriptor safety | Feasibility spikes and constrained alternative library/seam; no weakened invariant |
| Default Helmet policy breaks viewers or graph CSP | Explicit per-host settings and browser/static tests |
| JWT library flexibility admits other algorithms/claims or stale cached authorization | HS256 allowlist, required-claim/key/clock tests, live revocation checks |
| Dependencies work only with a developer's nested install | Root/web clean-install and runtime launch checks |
| Shutdown waits for streams or loses graph singleton/metadata ownership | Close streams before blocking teardown; process/lifecycle tests |

Release with existing commands, ports, data, cookies, and API contracts after all phases pass. Update [Pi Web](../pi-web.md), [Subagent graph](../subagent-graph.md), and relevant architecture notes to describe the real implementation and retained seams. No permanent dual dispatcher or framework-switch flag by default.

Rollback migration commits in reverse dependency order, including dependency/lockfile changes, rebuild, and restart `/web` and the graph host. Preserve auth/session/plugin/runtime data. Auth bypass, lost bridge ownership, stalled streams, file containment failure, broken downloads, or unbounded shutdown are immediate rollback triggers.

Before implementation, settle only the tested version/plugin set, explicit behavior differences, new optional plugin streaming result shape, and any narrowly justified exceptions. **Fastify as the target, both hosts, and removal of all replaceable handwritten routing/plumbing are requirements—not open scope decisions.**

## References

- [Fastify documentation and support policy](https://fastify.dev/docs/latest/)
- [Server options, lifecycle, router queries, testing injection](https://fastify.dev/docs/latest/Reference/Server/)
- [Routes, prefixes, params, HEAD, and schemas](https://fastify.dev/docs/latest/Reference/Routes/)
- [Content-Type parser and framework-owned body limits](https://fastify.dev/docs/latest/Reference/ContentTypeParser/)
- [Validation and serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)
- [Static files](https://github.com/fastify/fastify-static), [cookies](https://github.com/fastify/fastify-cookie), [Helmet](https://github.com/fastify/fastify-helmet)
- [JWT](https://github.com/fastify/fastify-jwt), [SSE](https://github.com/fastify/sse), [rate limiting](https://github.com/fastify/fastify-rate-limit)
- [find-my-way: dynamic registration/removal and precedence](https://github.com/delvedor/find-my-way)
- Package versions researched with `npm view <package> version --json`; selected implementation versions still require feasibility verification.
