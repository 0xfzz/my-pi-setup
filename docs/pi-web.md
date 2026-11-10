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

## The session bridge (TUI ↔ web sync)

The pi process that **owns** a live session — the TUI — attaches it to the
web server, making that one AgentSession the single source of truth for
both frontends. `extensions/web.ts` does the bridging:

- It attaches whenever the server is reachable at session start, and right
  after `/web start` brings the server up (`GET /api/bridge/:id/attach`).
- The attach response is an SSE command stream: a prompt typed in a
  browser arrives as `{type:"prompt"}` and runs against the **same session**
  (`pi.sendUserMessage`), so the TUI sees the same turn it would see if the
  user had typed it locally. Aborts call `ctx.abort()`. Plugin actions emit
  on `pi.events`, so the TUI-side extensions handle them exactly like
  in-process ones.
- The extension posts the session's events back (batched at 25 ms —
  message deltas included), plus the TUI-side plugin views and
  working-indicator bus events, so the web renders the TUI's turns, plugin
  surfaces and working line in realtime.

While a bridge is attached, the web's `/api/agent/:id` routes proxy into it
and the session is listed as live; when it detaches, the server falls back
to resuming the session file and browser streams reconnect. A reconnect
after a gap emits `bridge_resync`, which makes the client reload its
history. Without a TUI attached, the web still spawns/resumes sessions
in-process — but running both frontends on one session is exactly what the
bridge is for.

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

## Popups and the web UI primitives

The web core ports pi's TUI interaction primitives, so any extension can
bridge its TUI UI to the web without web-specific code. Extensions publish
the same `ui.*` events in both hosts (`publishWebUi` in
`lib/web-plugins/publisher.ts`); the unified store keeps per-session state
and the event stream ships it in every `plugin_state` frame. The client
renders them in the same slots the TUI uses:

| Event | TUI primitive | Web rendering |
| --- | --- | --- |
| `ui.notify` | `ctx.ui.notify` | bottom-right toast, auto-expires after 6s, level-colored |
| `ui.status.changed` | `ctx.ui.setStatus` (footer) | status chips in the header |
| `ui.widget.changed` | `ctx.ui.setWidget` | bordered line blocks above/below the composer |
| `ui.custom.changed` | custom full-screen view | centered popup panel(s) of lines |
| `ui_prompt_start`/`end` (forwarded by the web extension) | select/confirm/input dialog | banner: pi is blocked on a terminal dialog |

This is the "TUI design system" surface: a new dialog-ish primitive lands
in the event model + store + client once, and every extension can use it
from either host. The TUI's own `ctx.ui.notify`/`setStatus`/`setWidget`
calls do not emit events, so bridging them means also calling `publishWebUi`
from the extension — the contract lives in `lib/web-plugins/ui-contracts.ts`.

## Dialogs — the TUI command port and the model picker

pi's TUI answers several commands with a selector or dialog; the web now
answers them with its own. The composer intercepts the ported names
(`webPorted` in `web/shared/commands.ts`) and runs the web side:

| Command | TUI | Web |
| --- | --- | --- |
| `/model` (bare) | model selector | model picker (search, ↑↓/enter, current marker) |
| `/model <provider/id>` | exact-match apply | same apply via POST /api/agent/:id/model |
| `/thinking` (bare) | level cycle | level picker |
| `/session` | stats page | info dialog (client data) |
| `/changelog` | changelog page | dialog from GET /api/changelog |
| `/copy` | clipboard | browser clipboard (last assistant text) |
| `/export` | file export | markdown transcript download |
| `/resume` | session selector | the session sidebar |
| `/compact`, `/name`, `/new`, `/clone`, `/reload`, `/web` | direct | dispatched as session commands |

Genuinely TUI-only commands (`/settings`, `/tree`, `/share`, …) still get an
honest notice instead of being fed to the model.

**The model chip** sits at the composer with the thinking level, both live:
the extension posts `web_models` (the picker's list: scoped or available
models) and `session_state` (current model/thinking) at attach, at every
turn start and after any change; picking a model POSTs to the session and
the TUI applies it (`pi.setModel`) — footer included. A model changed in
the terminal (its own `/model`, Ctrl+P) reaches the web at the next turn's
`session_state` push, and the state the fetch-on-settle reads carries the
same model so nothing resurrects a stale one.

**Extensions can open web dialogs too** — the web's extensibility surface:
publish a `dialog` view (title, markdown body or lines, up to 8 actions,
`open: false` to close) through the same view events as every other view.
The web renders it modally; its action buttons dispatch through the plugin
action pipeline back to the extension. That, plus slots, region overrides,
pages, toasts, statuses, widgets and the ui.* events, is the full kit an
extension uses to extend the web UI.

## Themes

Dark and light palettes are both defined in `web/client/base.css` as the
same slot variables; `data-theme` on `<html>` selects one and is set before
the first React render (no flash). The choice is `pi-web-theme` in
localStorage; with no stored choice the web follows the OS and re-follows
it live. The toggle is the ☾/☀ button in the sidebar head. Shadows and
modal scrims are theme-aware (`--scrim`), so plugin views and popups read
fine in both.

## Responsive layout and render performance

Below 720px the session sidebar collapses off-canvas behind a ☰ toggle in
the header and reopens as an overlay with a scrim; selecting a session
closes it, and crossing from wide to narrow closes it automatically.
Nothing renders wider than the viewport — the transcript, composer and
plugin views wrap.

On the performance side, message bodies and markdown are memoized: stream
deltas, plugin_state frames and status changes re-render only the live
message, not the transcript's history. Before that, every frame re-parsed
every historical message's markdown and rebuilt its DOM — the visible
flicker ("blipping") plugin UIs had during streaming.

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
