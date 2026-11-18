# Web: performance audit and latency benchmark

> Part of [pi-workflow-extensions](../README.md). What makes the Fastify pi-web
> stack slow, and how latency is measured before and after a fix.

| | |
| --- | --- |
| **Status** | audit · current benchmark guide |
| **Detail for** | [README § Web](../README.md) |
| **Scope** | `web/core/server/`, `web/core/http/`, `web/core/client/`, `web/core/plugin-contracts/`, `web/core/auth/`, `lib/sse-pressure.ts` |
| **Verified against** | `npm run bench:web`, `npm run tidy` |
| **Related** | [pi-web](pi-web.md), [web plugin architecture](web-plugin-architecture.md) |

- **What it is** — a code-backed audit of pi-web's request, stream and render hot paths plus a standalone latency benchmark.
- **Why it exists** — Fastify only stays fast when handlers do not rebuild codecs, reserialize frames, clone whole states or scan whole files per token/request.
- **How it is enforced** — `web/bench/server-latency.bench.ts` and `web/bench/client-latency.bench.ts` report p50/p95/p99 per operation; each scenario has a p95 ceiling and the command exits non-zero when a ceiling is exceeded.
- **What it refuses** — no benchmark runs inside `npm test` or `npm run test:web`; no assertion that a microbenchmark predicts inference latency.
- **What it cannot do** — it measures Node-side and loopback costs on the host it runs on; browser paint cost needs a separate browser profile.

---

## Running the benchmark

```sh
npm run bench:web
```

Two standalone runners live in `web/bench/` (tooling, not either runtime):
`server-latency.bench.ts` measures the JWT, stream, store, history and
real-HTTP paths; `client-latency.bench.ts` measures browser-side pure functions
without a DOM. They are separate files because the server must never import
client source. The harness generates its own
fixtures in temp directories, starts a real Fastify app on a loopback port for
the HTTP scenarios, warms each operation, then reports milliseconds per
operation. **Lower is better.** The p95 column is the acceptance metric; a
scenario fails and the command exits 1 when its p95 exceeds its ceiling.

Recorded baseline (node v22.23.2, this host, median of three runs):

| Scenario | Unit | p50 | p95 | p99 |
| --- | --- | ---: | ---: | ---: |
| `jwt-verify` | verify | 0.020 ms | 0.031 ms | 0.054 ms |
| `stream-tracker` | delta | 0.002 ms | 0.002 ms | 0.003 ms |
| `sse-coalesce` | frame | 0.016 ms | 0.022 ms | 0.031 ms |
| `ui-snapshot` | publish + snapshot | 1.950 ms | 2.555 ms | 2.969 ms |
| `history-tail` | read | 1.64 ms | 4.40 ms | 5.25 ms |
| `client-stream-delta` | delta | 0.002 ms | 0.002 ms | 0.002 ms |
| `markdown-split` | append | 0.031 ms | 0.059 ms | 0.079 ms |
| `http-api` | request | 0.75 ms | 1.13 ms | 1.55 ms |
| `http-asset` | request | 1.08 ms | 1.40 ms | 2.20 ms |
| `http-shell` | request | 1.04 ms | 1.34 ms | 2.43 ms |

The first `ui-snapshot` trial used an invalid view fixture (`items` instead of
`rows`), which the store rejected, so those numbers measured empty sessions.
The baseline above was re-taken with the corrected fixture before any fix.

Current acceptance run (same host after the fixes, one run):

| Scenario | p95 | Ceiling | Result |
| --- | ---: | ---: | --- |
| `jwt-verify` | 0.019 ms | 0.030 ms | PASS |
| `sse-coalesce` | 0.012 ms | 0.015 ms | PASS |
| `ui-snapshot` | 0.132 ms | 0.300 ms | PASS |
| `history-tail` | 1.518 ms | 3.000 ms | PASS |
| `http-api` | 1.078 ms | 2.000 ms | PASS |
| `http-asset` | 1.302 ms | 2.000 ms | PASS |
| `http-shell` | 1.285 ms | 2.000 ms | PASS |
| `client-stream-delta` | 0.002 ms | 0.010 ms | PASS |
| `markdown-split` | 0.086 ms | 0.150 ms | PASS |

Unchanged-but-measured scenarios (`stream-tracker`) keep a loose ceiling because
the synthetic delta path was already fast; the code-level quadratic accumulation
is still on the backlog. The in-process hot-loop ceilings (`jwt-verify`,
`sse-coalesce`, `ui-snapshot`, `history-tail`) sit below their recorded baselines,
so a regression there fails the command. The three loopback HTTP scenarios keep
a 2 ms operational ceiling instead: socket and event-loop noise on a shared host
moves their p95 more than the few microseconds the fixes save, so their
improvement is judged from the recorded before/after numbers, not from a ceiling
below baseline.

## What the audit found

Ranked by how directly the defect taxes a token or a request. Items marked
*fixed* have a benchmark-backed change in git history; the rest stay on the
list until a change and a measurement land together.

1. **Per-stream UI sync timer** — *fixed.* `web/core/server/event-stream.ts`
   used to start one 1 s timer per browser stream; each tick replayed every
   remembered plugin view through `bridge.ts:184-192` and `publisher.ts:62-72`,
   bumped the global UI store revision and rebuilt every subscriber's plugin
   frame. A refcounted per-session timer now emits once per session per second
   and asks each attached stream only for its own deduplicated state frame.
   The client audit proposed removing the periodic replay entirely; the timer
   was kept because the attach-time sync alone cannot refresh plugin state that
   changes after a stream connects.
2. **SSE encode → parse → encode** — *fixed.* `lib/sse-pressure.ts` used to
   encode into `BoundedSseEvents`, parse it back on `consume()`, and
   `web/core/http/sse.ts` serialized it again. `consumeEncoded()` and
   `EventChannel.sendEncoded()` now hand the admitted bytes to the formatter
   directly, including deduped plugin frames. The `sse-coalesce` ceiling is
   0.015 ms (baseline p95 ~0.021 ms, now ~0.012 ms).
3. **Quadratic in-flight text/arguments** — *backlog.*
   `web/core/server/stream-tracker.ts:59,86` copies the whole text prefix per
   delta and `JSON.parse`s the whole argument prefix; the browser twin is
   `web/core/client/streaming.ts:181,197`. The synthetic benchmark does not yet
   make this expensive enough to justify a riskier chunked representation.
4. **Global UI snapshot** — *fixed.* `web/core/plugin-contracts/ui-state-store.ts`
   used to invalidate one cached snapshot for any session and deep-clone all
   128 sessions for every frame. Frozen session snapshots are now cached by
   session revision and reused by unrelated frames. The `ui-snapshot` ceiling
   is 0.3 ms (baseline p95 ~2.5 ms, now ~0.13 ms).
5. **Whole-file history reads and directory scans** — *history read fixed.*
   `web/core/server/sessions.ts` used to read the entire session file on every
   stamp change (the format tolerates 37 MB files); it now reads a bounded tail
   window and widens it only when the visible history is still short. The
   `history-tail` ceiling is 3 ms (baseline p95 ~4 ms, now ~1.5 ms). Session
   lookups that enumerate every project directory and stat every candidate are
   still outstanding.
6. **Per-request JWT codec** — *fixed.* `web/core/auth/jwt.ts:53,104` used to
   construct a fast-jwt signer/verifier on every call; the codecs are now cached
   by key and kid with a clock-independent verifier, while expiry stays in this
   module. The `jwt-verify` ceiling is 0.03 ms (baseline p95 ~0.031 ms, now
   ~0.023 ms).
7. **Repeated static setup** — *fixed.* `web/core/server/client-static.ts`
   used to call `realpath(root)` for every asset and read/parse `build.json`
   in an `onSend` hook even for non-HTML payloads. The root boundary is now
   resolved once per app and the build id is read only for HTML shell payloads.
   The loopback HTTP scenarios have a 2 ms p95 ceiling.
8. **Response tracking for short requests** — *backlog.*
   `web/core/server/auth.ts:473` tracks every authenticated response with a
   close listener, although only long-lived SSE responses need revocation.
9. **Browser render cascades** — *backlog.*
   `web/core/client/use-session.ts:286` bumps a hook-wide state once per frame;
   `AppShell` consumes the whole hook and rebuilds all plugin slots, while
   `web/core/client/transcript.tsx:535` rebuilds every row wrapper on each
   render. Needs a browser Profiler harness before changing render boundaries.
10. **Markdown rescan** — *backlog.* `web/core/client/plugin-system/markdown.tsx:120`
    splits the full answer per frame; only the open chunk actually changes.
11. **Resolver hot hook** — *backlog.* `web/core/server/plugin-module-loader.ts:52-59`
    sorts every generation key and recomputes `pathToFileURL` on every module
    resolution once the hook is installed.
12. **Tool and bash update copies** — *backlog.* `web/core/client/use-session.ts:855,872,883,894,1101`
    spreads whole result/status maps, and `:606-640` copies the history array
    and a message's blocks for every bash delta.
13. **History-reload cascade** — *backlog.* Five sites bump one global epoch in
    `web/core/client/use-session.ts`, tearing down the stream and refetching
    state, models, commands and branch on each resync or compaction event.
14. **Validation serialization** — *backlog.* `web/core/plugin-contracts/ui-event-models.ts:75-79`
    and `view.ts` stringify/encode payloads repeatedly only to enforce size caps.
15. **Unbounded caches and listener copies** — *backlog.* `sessions.ts` keeps
    `diskNameCache`/`headerCache` without eviction, `bridge.ts:288` copies its
    listener set per event, and `server/ui-store.ts` persists synchronously.
16. **Gated, user-driven costs** — *not changed.* The per-entry
    `message.before-render-model` waterfall (`routes.ts:434-446`) and the
    per-call pi deep imports (`pi-api/mcp.ts`, `pi-api/trust.ts`) need a matching
    benchmark scenario before any contract or import change.

## Browser HAR follow-up

A Firefox HAR against a running server showed a 30 s `startup_error` on a
resumed session: `web/core/server/event-stream.ts` waited for a detached owner
that exited immediately with `--session-id cannot be combined with --session`.
`lib/session-host.ts` passed both flags whenever `sessionFile` was known.
The host now always resumes by exact session id (pi finds the project file by
that id), so the conflicting flag is gone and the stream no longer waits for a
process that cannot start. Regression: `tests/session-host.test.ts`.

## Browser bundle budgets

The initial page load used to ship three ESM entry bundles that esbuild could
not tree-shake: every exported symbol of an entry is reachable by definition.
`core/client/host/runtime.ts` re-exported all ~9,000 Phosphor icons and every
file-viewer renderer, and the host build had `splitting: false`, so Mermaid and
its diagram stack were inlined into `ui.js` despite an existing `import()`.
The browser downloaded ~19.6 MB of uncompressed JavaScript before it could
paint, matching the multi-second network bars in the HAR screenshot.

| Entry | Before | After | Where the rest went |
| --- | ---: | ---: | --- |
| `runtime.js` | 14.87 MB | 401 KB | `icons.js` and `file-viewer.js` are separate entries, fetched only on use |
| `ui.js` | 4.05 MB | 543 KB | Mermaid/KaTeX/Cytoscape are hashed dynamic chunks |
| `app.js` | 655 KB | 736 KB | icons are imported by name and bundled into the app |

First-party app and plugin builds use `FIRST_PARTY_EXTERNALS`, which excludes
only the icon shim; external plugins can still import any icon through the
import map. The files plugin suspends on the `@file-viewer/*` vendor modules
when a document preview opens, so neither the runtime nor the plugin half
pulls the viewers onto the cold path. `web/bundle-budget.mjs` fails the build
if `app.js`, `runtime.js` or `ui.js` drifts above its ceiling again.

This is a bundle-size fix, not a claim about a specific wall-clock number:
transfer time still depends on the proxy's compression and the client link.
Measure the rebuilt HAR to confirm the target on the deployment in question.

## Already optimized — do not re-fix

- Token deltas render at most once per frame (`web/core/client/frame-coalescer.ts`)
  and tool progress is coalesced server-side for 150 ms (`event-stream.ts:88`).
- Cumulative `partial` is stripped from bridge and browser wire events
  (`lib/bridge-event-slim.ts`, `web/core/server/wire.ts`); tool results are
  truncated to 8 KB (`tool-result-wire.ts`).
- History parsing reads only the tail window (`sessions.ts:1140`), and parsed
  histories are bounded and stamped (`history-cache.ts`).
- Startup AJV schema compilation, removed content-type parsers, warn-only
  logging, bounded plugin matcher and async scrypt are already in place.
- Stable markdown chunks and historical assistant rows are memoized
  (`markdown.tsx`, `transcript.tsx`, `tool-block-memo.ts`).
