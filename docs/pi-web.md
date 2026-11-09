# Minimal pi-web

> Part of [pi-workflow-extensions](../README.md).

The first-party web client for pi: a minimal, realtime base UI — session
transcript, composer, mode/status — with an extremely customizable plugin
system. Any user can add a plugin that extends the base (slots, pages,
actions) or overrides the minimal regions themselves, declaratively.

This replaces the vendored Next.js fork (`vendor/pi-web`, deleted in Phase
E; git history preserves it). The design and migration record live in
[`docs/prds/minimal-pi-web.md`](prds/minimal-pi-web.md).

## Quick start

```sh
cd web
npm install
npm run dev        # build + serve on http://127.0.0.1:30142
```

| Command | What it does |
|---|---|
| `npm run build` | esbuild bundle into `client/dist` |
| `npm start` | serve the built client (`tsx server/main.ts`) |
| `npm run check` | tsc over server, client and shared |
| `npm test` | unit tests (server routes, wire, reducer, regions) |
| `npm run test:e2e` | Playwright e2e with the fixture session (needs a browser) |

From the pi TUI, `/web start | reload | stop | status` manages a detached
instance on port 30142 (`lib/web-ui.ts`): single-instance with takeover,
esbuild when sources changed, direct `node --experimental-strip-types`
spawn (no npm wrapper holding the server's stdio), and auto-reload watching
`web/` plus the plugin contract directories.

## Architecture

```
web/
  server/    plain Node HTTP (tsx, no framework)
    main.ts        routes: health, plugins, sessions, agent, action, static
    sessions.ts    session core: spawn/resume via the SDK, live registry,
                   commands (prompt/abort/get_state), disk scan, history
    wire.ts        event projection for the browser
    event-stream.ts  SSE transport: coalescing, heartbeats, backpressure
    plugin-host.ts   the plugin host: views store, session-bus attach,
                     action relay + audit, kernel wiring, fixtures
  client/    React 19 SPA (esbuild bundle)
    shell.tsx        base regions + slots + overrides + routing
    use-session.ts   the session hook (one EventSource per session)
    transcript.tsx, composer.tsx, streaming.ts
    plugins/         view renderer, slots, plugin pages, actions, shortcuts
  shared/    regions.ts — override resolution (server + client)
  e2e/       e2e.mjs — the Playwright suite
```

The plugin contract itself lives in the root repo and is shared with the
TUI: `lib/web-plugins/` (view vocabulary, descriptors, actions, kernel,
publisher) and `web-plugins/` (the descriptors). Extensions publish views
from `extensions/*.ts` — unchanged from the vendored era.

## Realtime design

One SSE stream per selected session (`GET /api/agent/:id/events`)
multiplexes everything:

- **Agent events** — message deltas, tool execution status, lifecycle —
  projected by `server/wire.ts` (no turn markers, no system messages,
  slimmed tool payloads, no cumulative partial snapshots).
- **`plugin_state` frames** — the session's plugin views, working model
  and running flag, pushed on every store revision and deduplicated, so
  slots, pages, region overrides and the working indicator update without
  reloads.

Commands `POST /api/agent/:id` (`prompt`, `abort`, `get_state`);
history loads from `GET /api/agent/:id/history` (parsed from the session
file); the session list polls `/api/sessions` every 5 s. The selected
session persists in `localStorage`, so reloads and plugin-page navigation
reconnect the stream. Backpressure: rebuildable deltas drop above 512 KB
queued, the stream ends above 16 MB (the client reconnects and
re-snapshots).

## HTTP API

| Route | Method | Purpose |
|---|---|---|
| `/api/health` | GET | liveness |
| `/api/plugins` | GET | visible descriptors (kernel: enabled, unquarantined) |
| `/api/plugins/action` | POST | the plugin action route (below) |
| `/api/sessions` | GET | live + disk sessions, newest first |
| `/api/agent/new` | POST | spawn a pi session (`createAgentSession`) |
| `/api/agent/:id` | GET / POST | state read / prompt, abort, get_state |
| `/api/agent/:id/events` | GET | the SSE stream |
| `/api/agent/:id/history` | GET | transcript entries |

Every non-GET API request to a wrong method gets 405; unknown sessions 404.

## The plugin system

A descriptor (`web-plugins/*.ts`) declares **surfaces**:

| Surface | Effect |
|---|---|
| `{ kind: "slot", slot }` | additive region: `top` / `center` / `bottom` / `floating` |
| `{ kind: "page", path }` | dedicated page at `/plugins/:id` |
| `{ kind: "override", region }` | **replaces a base region** — `header`, `status`, `transcript`, `composer` — while a view is published; the built-in region returns automatically |
| `{ kind: "sidebar" }` | reserved for the sidebar contract |

Extensions publish views with `publishWebView(pi, pluginId, view)` from
`lib/web-plugins/publisher.ts`. Views are **declarative and validated
server-side** — `kv`, `list` (status icons + markdown detail), `status`,
`graph` (nodes, edges, markdown detail) — so a plugin never ships client
code. The vocabulary: `lib/web-plugins/view.ts`.

**User plugins**: drop a descriptor with a server entry into
`~/.pi/agent/web-plugins` (or `.pi/web-plugins` in a project); the kernel
(`lib/web-plugins/kernel/`) discovers them, tracks enable state, and
quarantines misbehaving ones — the same kernel the TUI-era host used.

**Actions** are descriptor-declared and relayed over the session event bus:

- *confirmed action* — requires typing the exact confirm string
  (byte-identical; 403 otherwise), e.g. the monitor's `request sync`
- *instant action* — one click, optionally keybound (e.g. **Alt+M** for
  the modes switch; shortcuts never fire while typing in a field)

Semantics: 404 before validation, 403 on a confirm mismatch (nothing
emitted), 409 while another action is in flight for the session, then
audit + single-use requestId relay. The web server never executes
anything itself — the owning extension re-checks and republishes.

**Region overrides** resolve per session in `web/shared/regions.ts`;
when several plugins override one region, registry order decides and the
conflict is reported in the `plugin_state` frame and shown as a banner.
`example-override` is the reference plugin: inert until its instant
"Replace the composer" action runs.

## The working indicator

`ui.working.changed` events stream the frames and message (the bubbly
spinner's TUI data through the unified UI store); the transcript's
working line animates them while the session reports itself running.

## Verification

The root gate covers the whole repo:

```sh
npm run tidy   # typecheck + oxlint + root tests + web tests (build included)
```

The e2e suite (separate, needs a browser) drives the fixture session
(`PI_WEB_TEST_PLUGIN_VIEWS=1`): base shell, session selection, all three
slots, the composer region override, the working indicator, the Alt+M
shortcut, the plugin page with its graph, and the confirmed-action round
trip whose accepted requestId flows into the graph label over SSE without
a reload.
