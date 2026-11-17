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
- **How it is enforced** — `web/core/server/latency.bench.ts` reports p50/p95/p99 per operation; each scenario has a p95 ceiling and the command exits non-zero when a ceiling is exceeded.
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
| `ui-snapshot` | publish + snapshot | 0.073 ms | 0.121 ms | 0.144 ms |
| `history-tail` | read | 1.64 ms | 4.40 ms | 5.25 ms |
| `client-stream-delta` | delta | 0.002 ms | 0.002 ms | 0.002 ms |
| `markdown-split` | append | 0.031 ms | 0.059 ms | 0.079 ms |
| `http-api` | request | 0.75 ms | 1.13 ms | 1.55 ms |
| `http-asset` | request | 1.08 ms | 1.40 ms | 2.20 ms |
| `http-shell` | request | 1.04 ms | 1.34 ms | 2.43 ms |

## What the audit found

Ranked by how directly the defect taxes a token or a request. Items marked
*fixed* have a benchmark-backed change in git history; the rest stay on the
list until a change and a measurement land together.

1. **Per-stream UI sync timer** — `web/core/server/event-stream.ts:228` starts
   one 1 s timer per browser stream, and each tick replays every remembered
   plugin view through `bridge.ts:184-192` and `publisher.ts:62-72`, bumps the
   global UI store revision and rebuilds every subscriber's plugin frame.
   Subscribers, not sessions, determine the cost.
2. **SSE encode → parse → encode** — `lib/sse-pressure.ts:40,66` encodes into
   `BoundedSseEvents`, parses it back on `consume()`, and
   `web/core/http/sse.ts:103` serializes it again. Every coalesced tool update
   and pre-`connected` event pays three JSON operations.
3. **Quadratic in-flight text/arguments** — `web/core/server/stream-tracker.ts:59,86`
   copies the whole text prefix per delta and `JSON.parse`s the whole argument
   prefix; the browser twin is `web/core/client/streaming.ts:181,197`.
4. **Global UI snapshot** — `web/core/plugin-contracts/ui-state-store.ts:302,390`
   invalidates one cached snapshot for any session and deep-clones all 128
   sessions for every frame, with notifications fanning out to all listeners.
5. **Whole-file history reads and directory scans** —
   `web/core/server/sessions.ts:1156` reads the entire session file on every
   stamp change (the format tolerates 37 MB files); `:1035` resolves a session
   by enumerating every project directory, and `:716` stats every candidate.
6. **Per-request JWT codec** — *fixed.* `web/core/auth/jwt.ts:53,104` used to
   construct a fast-jwt signer/verifier on every call; the codecs are now cached
   by key and kid with a clock-independent verifier, while expiry stays in this
   module. The `jwt-verify` ceiling is 0.03 ms (baseline p95 ~0.031 ms, now
   ~0.023 ms).
7. **Repeated static setup** — `web/core/server/client-static.ts:15` calls
   `realpath(root)` for every asset, and `:31-40` reads and parses
   `build.json` in an `onSend` hook even for non-HTML payloads.
8. **Response tracking for short requests** — `web/core/server/auth.ts:473`
   tracks every authenticated response with a close listener, although only
   long-lived SSE responses need revocation.
9. **Browser render cascades** — `web/core/client/use-session.ts:286` bumps a
   hook-wide state once per frame; `AppShell` consumes the whole hook and
   rebuilds all plugin slots, while `web/core/client/transcript.tsx:535`
   rebuilds every row wrapper on each render.
10. **Markdown rescan** — `web/core/client/plugin-system/markdown.tsx:120`
    splits the full answer per frame; only the open chunk actually changes.
11. **Resolver hot hook** — `web/core/server/plugin-module-loader.ts:52-59`
    sorts every generation key and recomputes `pathToFileURL` on every module
    resolution once the hook is installed.

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
