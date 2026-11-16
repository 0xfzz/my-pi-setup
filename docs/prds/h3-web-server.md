# PRD: Migrate the pi-web HTTP host to H3

> Part of [pi-workflow-extensions](../../README.md). Replace pi-web's handwritten HTTP dispatch with H3 while preserving the browser, TUI bridge, and plugin contracts.

| Field | Value |
| --- | --- |
| **Status** | draft — proposal only; no runtime changes in this document |
| **Owner** | Faiz |
| **Detail for** | [Pi Web](../pi-web.md) |
| **Scope** | `web/server.ts`, `web/core/server/`, `web/package.json`, `web/package-lock.json`, and HTTP compatibility tests |
| **Target** | H3 v2 on Node.js; npm reported `h3@2.0.8` as `latest` when researched |
| **Verified against** | Current source and upstream documentation; implementation acceptance suites are specified below, not evidence of an implemented migration |
| **Related** | [Minimal pi-web](minimal-pi-web.md), [plugin platform](pi-web-plugin-platform.md), [web plugin architecture](../web-plugin-architecture.md) |

- **What it is** — an HTTP framework migration, not a new backend or API version.
- **Why it exists** — remove custom routing and response plumbing without disturbing session ownership.
- **How it is enforced** — route characterization tests, real-socket streaming tests, and the existing repository gates.
- **What it refuses** — auth bypasses, plugin API breakage, and a catch-all wrapper presented as a completed migration.
- **What it cannot do** — make the Node-dependent plugin transport portable or sandbox trusted plugins.

## 1. Problem and outcome

The primary web server uses `node:http.createServer` directly. `main.ts` parses URLs, sets security headers, applies auth, dispatches APIs, serves assets, and maps failures. `routes.ts` implements its own ordered string/regex matcher, parameter decoding, and method checks. `http.ts` supplies JSON serialization and body accumulation.

This works, but every HTTP concern remains repository-owned. Moving those responsibilities to H3 should make routes and middleware easier to compose and test. It must not trade proven authentication, streaming, or file safety for framework defaults.

**Desired outcome:** H3 owns primary-server routing, middleware composition, and ordinary response generation. Session logic and the plugin kernel remain framework-independent. Existing clients continue to use the same URLs and payloads without a coordinated release.

This is a maintainability project. Faster requests, fewer lines, and cross-runtime deployment are not promised outcomes.

## 2. Current implementation and scope boundary

| Surface | Current implementation | Migration treatment |
| --- | --- | --- |
| Composition | `web/server.ts` registers plugins and registry-change broadcasts before `main()` | Preserve composition order and the core/plugin import boundary |
| Listener and static shell | `web/core/server/main.ts` | Replace handwritten request dispatch with an H3 app; retain the public start/close interface |
| Core API | `web/core/server/routes.ts` | Replace `API_ROUTES` regex dispatch with explicit H3 routes |
| HTTP helpers | `web/core/server/http.ts` | Migrate ordinary handlers to H3 responses and a bounded JSON reader; retain helpers still needed by Node adapters |
| Auth | `web/core/server/auth.ts`, `web/core/auth/` | Preserve policy and service; initially adapt the existing Node HTTP gate |
| Browser SSE | `web/core/server/event-stream.ts` | Preserve the existing transport through a narrow Node adapter |
| TUI bridge SSE | `web/core/server/bridge.ts` | Preserve attach, command delivery, ownership, and detach behavior |
| Plugin backend dispatch | `web/core/server/plugin-routes.ts` | H3 owns the `/api/p/*` entry point; the kernel still owns dynamic plugin route resolution |
| Files plugin | `web/plugins/files/server/index.ts`, `web/core/server/files.ts` | Preserve raw transport, stream ownership, Range behavior, and path policy |
| Build synchronization and teardown | `client-build.ts`, `shutdown.ts`, `main.ts` | Preserve build notifications, orderly plugin shutdown, and process cleanup |

### Separate HTTP server under `web/`

`web/plugins/subagent-graph/lib/server.ts` also uses `createServer`. It is a separate runtime with its own singleton lock, producer/bootstrap tokens, host checks, ports, timeouts, SSE clients, and shutdown lifecycle.

**Proposed release boundary:** migrate the primary pi-web server first; do not migrate the standalone graph runtime in this release. Its graph surface within pi-web must continue to work. A later graph-host migration needs its own compatibility inventory and dependency-resolution review because root extensions also load that runtime. This PRD does not claim to remove every `node:http` use under `web/`.

### Non-goals

- New UI, routes, session commands, or authentication mechanisms.
- Replacing SSE with WebSockets or changing stream event schemas.
- Replacing the plugin kernel router with H3, or exposing H3 types to plugin contracts.
- Rewriting session lifecycle, storage, file policy, or the Pi API facade.
- Nuxt, Nitro, a new build system, serverless hosting, or Bun/Deno support.
- Unrelated cleanup of large modules or changes to the standalone graph server.

## 3. Framework and dependency decision

The supplied [guide](https://h3.dev/guide) explicitly documents **H3 v2**. Use `new H3()`, its method routes, and v2 request/response APIs. Do not copy v1 `createApp`/`event.node` examples into this migration.

- Add a pinned, verified H3 v2 release to **`web/package.json`** and update its lockfile. `2.0.8` is the research baseline, not a promise that a future `latest` is interchangeable.
- The researched package declares Node `>=20.19.0`; this repository declares `>=22.6.0`. Verify H3 and its locked transitive dependencies on the repository's minimum Node version and its current development version before choosing the final pin. No silent Node-version increase.
- Prefer H3's documented `serve(app, options)` listener, powered by srvx. Confirm readiness, bound-port reporting, real Node transport access, and forced shutdown in the feasibility step.
- If direct srvx imports are necessary, declare srvx as a direct web dependency rather than relying on a transitive import. Record the selected APIs and versions in the implementation notes.
- If the preferred listener cannot preserve lifecycle or transport ownership, document a supported Node-listener adapter as a fallback before proceeding. A small `node:http` listener shim is acceptable; a retained handwritten dispatcher is not.
- Do not add H3 to root dependencies unless an actual root-runtime import requires it. Verify both `tsx server.ts` and the direct `node --experimental-strip-types` launch used by `/web`.

## 4. Proposed architecture

```text
web/server.ts                    existing composition root
  -> createWebApp(options)       H3 application factory, no listener or signal hooks
       -> global security/error policy
       -> API auth boundary
       -> explicit core H3 routes
       -> plugin namespace adapter -> kernel route registry
       -> static/SPA handler
       -> explicit API 404 / method responses
  -> startWebServer(options)     listener + watcher lifecycle, same handle
```

`createWebApp` is a proposed name, not an existing export. Keep it in a focused server module. Inject the auth service, static root, and required adapters; do not register plugins or start timers merely by constructing the app. Listener/build-watcher setup stays in `startWebServer`.

### 4.1 Request policy and ordering

1. Apply the existing security headers to every application response, including errors and raw streams.
2. Classify the API namespace as **exactly `/api` or a path starting `/api/`**; `/apiary` is not API.
3. Keep `/api/health` public. Handle the four recognized auth paths before the protected API gate, including their method errors. Unknown `/api/auth/*` paths must still pass through the normal gate.
4. Authenticate every other API request **before dispatch**, including plugin paths, unknown paths, and unsupported methods. A routing miss must not bypass auth or reveal a protected route's method table.
5. Dispatch core routes or the plugin namespace. Never fall through from an API miss to the SPA shell.
6. Serve public static assets and extensionless SPA paths only for the currently permitted method.

Use a namespace-level guard rather than individually remembering auth on every route. Confirm H3 middleware matching covers bare `/api` as well as descendants. A nested app or wildcard must not strip information the auth gate uses to recognize bridge routes.

### 4.2 Native responses and a bounded compatibility island

Ordinary core JSON handlers become H3 handlers returning JSON-compatible values or explicit `Response` objects, with preserved statuses and headers. Keep domain calls such as `sendCommand`, `startSession`, and plugin action validation outside transport utilities.

The initial release deliberately retains Node-specific code for:

- The auth HTTP gate's peer/socket policy and response-revocation tracking.
- Browser event streams and TUI bridge attach streams.
- Plugin requests exposing `PluginRouteTransport`, including Files downloads.

Use the documented v2 Node adapter facilities and real runtime Node request/response handles. Do not manufacture fake `ServerResponse` objects or cast a Web `Request` into `IncomingMessage`. Each raw-response route must explicitly transfer response ownership so H3 does not serialize an additional value, end an open SSE response, or overwrite stream headers. Prove that handoff against the pinned version; do not assume returning `undefined` means “already handled.”

Only one layer may consume a body. The auth middleware may inspect credentials and track the response, but must not eagerly read bodies destined for a core handler or plugin adapter. Do not buffer or clone streams in generic response middleware.

**Completion boundary:** the legacy core `matchRoute`/`API_ROUTES` dispatcher and `main.ts` request dispatcher are gone. A single `fromNodeHandler(handleRequest)` catch-all is an intermediate checkpoint only. Retained Node code is limited to named compatibility adapters; a full SSE rewrite is not required for release.

## 5. Functional requirements

### R1. Route and method compatibility

Characterize the full current table before replacing it. At minimum, cover these families:

| Routes | Methods / special behavior |
| --- | --- |
| `/api/health` | GET; retain `ok`, service identity, boot ID, and build ID |
| `/api/auth/status`, `/api/auth/{login,refresh,logout}` | GET status; POST mutations; preserve auth-specific `Allow` headers |
| `/api/plugins`, `/api/plugins/action` | GET registry; POST validated action/audit/relay |
| `/api/plugin-manager`, `/api/plugin-manager/:id/:command` | GET report; POST lifecycle command |
| `/api/bridge/:id/{attach,events,detach}` | GET attach SSE; POST events/detach; bridge-token policy |
| `/api/directories`, `/api/sessions`, `/api/sessions/events`, `/api/sessions/:id` | GET picker/list/directory SSE; DELETE session |
| `/api/agent/new`, `/api/agent/:id` | POST creation; GET state and POST command |
| `/api/agent/:id/{events,history,commands,tree,models,branch}` | GET; events is SSE |
| `/api/agent/:id/{pi_api,model,thinking}` | POST |
| `/api/changelog` | GET |
| `/api/p/:pluginId/*` | Delegate to the live kernel registry; preserve its method set and lifecycle rules |

- Preserve query values and repeated-query behavior by retaining `URLSearchParams` semantics where used now.
- Literal `new` and suffix routes must not be swallowed by `:id`; `/api/sessions/events` must not become a session ID lookup.
- Preserve JSON 404 for unknown API paths and JSON 405 for known paths with unsupported methods, after auth.
- **HEAD is not newly enabled.** H3 automatically executes GET handlers for HEAD; explicitly preserve existing 405 behavior, including for SSE, so HEAD cannot resume a session or attach a stream. Preserve existing OPTIONS behavior; do not enable CORS by default.
- Test trailing slashes, case, percent-encoded IDs, and invalid command segments. H3 patterns must not silently broaden the plugin-manager command syntax beyond the current `[a-z-]+` route.

### R2. Authentication and trust policy

Keep the behavior pinned by `auth.test.ts`: disabled/enabled/invalid modes; public shell and health; cookie and bearer access; refresh rotation, grace behavior, and reuse revocation; login throttling; CSRF; bridge-token-only access when protection is enabled; and immediate closure of revoked browser streams.

Retain `pi_web_at` and `pi_web_rt`, HttpOnly/SameSite attributes, cookie paths, Secure detection, expiration, multiple `Set-Cookie` headers, `WWW-Authenticate`, and `Retry-After`. Keep `PI_WEB_TRUST_PROXY`, `PI_WEB_ALLOWED_ORIGINS`, and `PI_WEB_COOKIE_SECURE` semantics. Do not substitute H3 forwarded-header/IP helpers for the existing trusted-peer and hop-selection logic without a separately reviewed policy change.

### R3. Bodies, statuses, and errors

- Preserve the general **60,000,000-byte** body cap and auth **4,096-byte** cap, including enforcement while consuming chunked bodies. A `Content-Length` check alone is insufficient.
- Preserve the general reader's empty-body `{}` behavior and the auth reader's object-only validation. Characterize plugin dispatch separately: its swallowed parse failures and bodyless-method handling are observable today.
- Parse JSON as JSON; do not silently add URL-encoded or multipart support via H3 `readBody` defaults.
- Preserve endpoint-specific handling of malformed/oversized bodies. H3's body limiter normally raises 413; converting every existing route to 413 is a separate API change, not an automatic part of this migration.
- Keep JSON error envelopes and current meaningful error codes/messages. Unhandled failures remain `500 { "error": "internal error" }`, without debug stacks or secrets. After a stream has started, close it rather than attempting a second JSON response.
- Preserve JSON `Content-Type: application/json; charset=utf-8` and `Cache-Control: no-store` where currently supplied. Do not normalize intentional file/stream cache policies to the JSON default.

### R4. Security headers and URL handling

All application responses retain `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY`. H3 may discard prepared success headers on errors; explicitly test both returned error responses and thrown failures. Distinguish HTTP-parser rejections before the app from responses the app can control.

H3 v2 canonicalizes some percent escapes and rejects malformed path encoding before handlers. The existing regex dispatcher decodes captures itself. These are not identical contracts:

- Use one consistent path representation for API classification, auth, routing, and plugin dispatch; never decode a path again after matching it.
- Preserve supported session/plugin IDs with a single parameter-decoding policy. Do not use nested decoding to recover legacy encoded separators.
- Feasibility work must record old/new outcomes for malformed `%`, encoded `/` and `\\`, nested escapes, dot segments, repeated slashes, and encoded API/bridge prefixes.
- **Proposed intentional difference:** malformed path encoding returns a sanitized JSON 400 instead of legacy path-dependent 404/500 results. Other canonicalization differences must be listed and reviewed before cutover. No difference may turn a protected request into a public request or bypass file containment.

### R5. Realtime transport

Keep the existing wire events, connection preamble, ordering, reconnect/snapshot behavior, session replacement, and startup-error behavior. Preserve agent/directory stream 30-second heartbeats, 150-ms tool-update coalescing, droppable-frame pressure threshold of 512 KiB, and closure above the 16 MiB backlog limit. Preserve the bridge's own heartbeat and ownership-healing behavior; do not assume all streams have identical buffering rules.

SSE remains incremental with `text/event-stream`, `no-cache, no-transform`, and `X-Accel-Buffering: no`. It must not acquire a framework timeout, compression buffer, or response auto-end that breaks a healthy long-running connection. Disconnect, logout/revocation, session replacement, and shutdown each release timers and subscriptions exactly once.

### R6. Plugin and file compatibility

Keep `PluginRouteRequest`, `PluginRouteResponse`, `PluginRouteTransport`, capability checks, active-plugin gating, dynamic route removal, session-root resolution, invocation budgets, and 502 failure/timeout envelopes unchanged. `{ handled: true }` still means the host writes nothing further. Do not snapshot dynamic plugin routes into H3 at startup.

Files still streams through the real transport. Preserve 200/full and 206/range bytes, current invalid-Range fallback, content length/disposition, attachment-for-HTML/SVG/unknown content, private/no-store caching, traversal/symlink checks, size caps, hook vetoes, and descriptor cleanup after aborted downloads. H3 static helpers must not become an alternate route to project files.

### R7. Static shell and build identity

Retain current MIME types (including viewer WASM/font assets), `no-cache`, containment checks, unknown-asset 404s, and the extensionless SPA fallback. HTML remains raw trusted build output, not escaped text, and receives the current build stamp. Build watchers continue to publish build changes to open tabs. No API request may receive `index.html`.

### R8. Runtime lifecycle

Preserve `StartWebServerOptions` and `WebServerHandle { port, host, close() }`, injected auth/static roots, host/port env defaults, port `0`, listen-error rejection, process identity, `PI_WEB_SERVER_PROCESS`, `/web` health checks, and fixture behavior.

`close()` stops the build watcher, ends active SSE/download connections, and resolves without waiting for infinite streams. Failed startup must release newly acquired resources. Repeated close must be safe. Existing bounded teardown, orderly plugin-host shutdown, and synchronous child cleanup on process exit remain in place; do not add competing H3/srvx signal handlers.

## 6. Delivery plan and release gates

Each row is a coherent review boundary; separate behavior changes from structural refactoring and commit verified units before starting the next.

| Phase | Deliverable | Exit gate |
| --- | --- | --- |
| 0. Characterize and prove feasibility | Baseline route/method/error matrix; pinned-version listener/Node-ownership spike; minimum-Node check; explicit URL-difference list | Demonstrate auth + ordinary JSON, one open SSE stream, one Files download, revocation, and bounded close on a real socket. Resolve version/API blockers before broad edits |
| 1. Introduce H3 composition | App factory, dependency/lock update, global policy, listener lifecycle; limited temporary adapters | Existing server tests pass unchanged; startup/listen-error/port-0/close tests pass |
| 2. Migrate core HTTP routes | Explicit H3 registrations and native ordinary responses; remove legacy core dispatcher | Full route/method matrix and action/session/Pi API suites pass; no catch-all legacy dispatcher remains |
| 3. Verify compatibility islands | Named auth, plugin, SSE, bridge, and file adapters; ownership and error-path tests | No double writes, stream leaks, lost cookies/security headers, stale plugin routes, or early stream termination |
| 4. Cut over and document | Update operator architecture notes, remove migration-only wrappers, record retained Node boundaries | Full verification below; browser/TUI acceptance recorded; clean committed tree |

A phase may use temporary wrapping to keep the tree runnable. The release is not complete until phase 2 removes handwritten core dispatch. Do not keep two permanent production dispatchers or add a runtime feature flag unless staged rollout actually requires it.

## 7. Verification and acceptance criteria

| ID | Acceptance criterion | Evidence required |
| --- | --- | --- |
| AC1 | H3 owns primary-server middleware, routing, and ordinary responses | App factory/route review; no legacy `matchRoute`/`API_ROUTES` or `main.ts` dispatcher; explicit retained-adapter list |
| AC2 | No supported API/client contract changes outside reviewed URL differences | Characterization matrix across all route families, methods, query/body cases, and 404/405 paths; include HEAD/OPTIONS |
| AC3 | Auth cannot be bypassed by routing, method errors, or normalization | Existing `auth.test.ts` plus bare `/api`, unknown/API-auth/plugin paths, encoded prefixes, revocation, proxy, and cookie-header regressions |
| AC4 | Streaming remains live and bounded | `event-stream.test.ts`, `bridge.test.ts`, `session-directory.test.ts`, real-socket flush/disconnect tests, and root `tests/web-bridge-*.test.ts` coverage |
| AC5 | Plugin routes and Files keep ownership and safety | `activity-plugin.test.ts`, `plugin-host.test.ts`, `files.test.ts`, `files-stream.test.ts`, dynamic activation/deactivation and timeout/handled-response regressions |
| AC6 | Runtime/startup/shutdown and build convergence still work | `main.test.ts`, build-identity tests, bind-failure cleanup, repeated close with active streams/downloads, and both launch paths |
| AC7 | Browser and TUI workflows require no client edits | Browser login/refresh/logout; open session, prompt/abort, reconnect mid-turn; plugin action; Files preview/download; build reload; TUI bridge attach/events/detach and `/web start/reload/stop/status` |
| AC8 | Repository remains releasable | `npm run tidy`, `npm run lint:dead` for changed exports/files, and `npm --prefix web run test:e2e`; clean git status and scoped commits |

Use app-level `app.request()` tests for native routes and error envelopes without binding a port. Those tests **cannot** establish peer-address trust, real raw plugin transport, SSE flushing, backpressure, or forced socket shutdown; retain real Node listener tests for those concerns. Add no-sleep deterministic unit tests for scheduling/pressure decisions, with deadlines only in socket integration tests.

The repository gate is `npm run tidy` (typecheck, smell lint, root tests, web check/build/tests). Only the two documented native regular/fullscreen TUI clipping failures are accepted baseline exceptions. Browser e2e is a separate command, not part of `tidy`. Record actual results and any blocked browser prerequisites; do not treat unrun coverage as green.

## 8. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| v1 examples or moving v2 documentation do not match installed APIs | Pin the package; verify adapter/listener/error APIs against its exports and types in phase 0 |
| H3 automatically handles HEAD or normalizes a path differently | Explicit method guards and canonicalization fixtures before cutover |
| Prepared security/cookie headers disappear on errors | Assert final wire headers for normal, thrown, returned-error, and raw responses |
| H3 sends an extra response after a plugin or SSE handler takes ownership | One narrow ownership adapter, proven on real sockets; no fake transport |
| Web body APIs consume a Node stream twice or change parsing semantics | Exactly one body reader per route, streaming byte caps, endpoint-specific error mapping |
| Framework shutdown waits forever or bypasses plugin teardown | Keep one lifecycle owner; forced active-connection closure and existing teardown budget |
| A nominal framework migration leaves the old system underneath | AC1 requires native core routes and removal of handwritten dispatch |

## 9. Rollout, rollback, and remaining decisions

Ship on the same port and commands after compatibility and browser/TUI checks. No data, session-file, auth-store, or plugin-manifest migration is needed. Update [Pi Web](../pi-web.md) with the listener/app split and retained Node boundaries when implementation ships; do not describe this draft as current runtime behavior.

Rollback by reverting migration commits in reverse dependency order, including web dependency/lockfile updates, then restarting with `/web reload`. Keep auth and session data intact. Immediate rollback triggers: auth/CSRF regression, lost bridge ownership, frozen/early-ended streams, broken plugin downloads, or unbounded shutdown.

Before implementation approval, confirm:

1. **Release scope:** accept the primary-host-first boundary; standalone graph-host migration is a separate follow-up.
2. **Dependency pin and listener:** choose the tested v2 pin and supported listener/ownership APIs after the phase-0 spike.
3. **URL differences:** approve the enumerated canonicalization outcomes, including the proposed malformed-path JSON 400; do not silently change route identity or trust boundaries.

## References

- [H3 getting started (v2)](https://h3.dev/guide)
- [H3 API and application testing](https://h3.dev/guide/api/h3)
- [H3 routing, including automatic HEAD](https://h3.dev/guide/basics/routing)
- [H3 response generation and error-header behavior](https://h3.dev/guide/basics/response)
- [H3Event and pathname encoding](https://h3.dev/guide/api/h3event)
- [H3 body utilities](https://h3.dev/utils/request), [response/stream utilities](https://h3.dev/utils/response), [Node adapter utilities](https://h3.dev/utils/more)
- [srvx Node support](https://srvx.h3.dev/guide/node) and [runtime request handles](https://srvx.h3.dev/guide/handler)
- Package metadata checked with `npm view h3 version dist-tags engines --json` and `npm view h3@2.0.8 dependencies --json`.
