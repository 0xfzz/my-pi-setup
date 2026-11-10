# Minimal pi-web

> Part of [pi-workflow-extensions](../README.md).

The first-party web client for pi: a minimal, realtime base UI — session
transcript, composer, mode/status — with an extremely customizable plugin
system. Any user can add a plugin that extends the base (slots, pages,
actions) or overrides the minimal regions themselves, declaratively.

This replaces the vendored Next.js fork (`vendor/pi-web`, deleted in Phase
E; git history preserves it). The design and migration record live in
[`docs/prds/minimal-pi-web.md`](prds/minimal-pi-web.md).

The division of labor is codified in
[`docs/web-plugin-architecture.md`](web-plugin-architecture.md) — **the web
is interface, pi extensions are behavior** — and enforced on the import
graph by `tests/web-boundaries.test.ts`.

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
- **Two command channels, two registries.** `pi.registerCommand` is pi's —
  for genuine TUI commands (pi's built-ins like `/compact` already own
  those names there; shadowing them is exactly the "conflicts with
  built-in" warning). The **web core registry** (`extensions/web.ts`)
  registers the same names for the web and dispatches through its own
  bridge channel `{type:"web_command"}` — the handlers call pi's ctx
  methods (`ctx.compact`, rename, new-session, reload). In-process hosts
  re-route through the prompt path, where the mode-gated pi commands
  dispatch them.
- When the extension (re)posts its command list (`web_commands` events),
  the bridge fans a `commands_changed` event to the browser streams; the
  client refetches `/api/agent/:id/commands`, so a `/reload` in the TUI
  refreshes the web palette too.

**Built-in commands.** pi's 24 built-ins all have a web disposition: 8 are
web-ported (model, thinking, session, changelog, copy, export, resume,
hotkeys — client dialogs/actions), 9 dispatch through the web-command
channel into pi's own command runner (compact, name, new, clone, reload,
fork, tree, import, quit — `ctx.compact`, `setSessionName`, `newSession`,
`fork`, `navigateTree`, `switchSession`, `reload`, `shutdown`), and the 7
that genuinely need the terminal (settings, scoped-models, share, bug,
trust, login, logout) say so honestly. Session-control commands run with a
valid command context by dispatching through pi's runner
(`/web-<name>` registered commands reached via the prompt path), never a
captured context; `/tree` renders a searchable, keyboard-navigable tree
picker from pi's own `getTree()` projection, and `/fork` picks through the
extension dialog pipeline — answerable from either frontend.

While a bridge is attached, the web's `/api/agent/:id` routes proxy into it
and the session is listed as live. **The bridge owns the session**: while
it is attached — or within a 10 s self-heal window after it drops —
`ensureSession` never resumes the session in-process (two AgentSessions on
one file would split the frontends: the web's prompts would run on the
server's copy while the TUI's turns never reach the web). A live bridge
whose registry entry drifted re-registers itself on its heartbeat, and a
displaced in-process copy is disposed on takeover. When the TUI is truly
gone the window expires and the server falls back to resuming the session
file, with browser streams reconnecting. A reconnect
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
| `/api/agent/:id/commands` | GET | pi's runtime built-ins + the session's live commands |
| `/api/agent/:id/pi_api` | POST | call a pi built-in api (below) |

Every non-GET API request to a wrong method gets 405; unknown sessions 404.

## The pi_api facade — pi's built-ins, called not copied

The web never reimplements pi features. Every web capability maps to a
**pi built-in api** it calls at runtime through one generic route:

```
POST /api/agent/:id/pi_api   { "api": "<name>", "params": { … } }
                             → { "ok": true, "result": … } | { "ok": false, "error": … }
```

The contract lives in `web/shared/pi-api.ts` (names, params, results);
`lib/web-pi-apis/` implements it as pluggable modules over pi's own code:

| api | pi implementation | web surface |
|---|---|---|
| `autocomplete.suggestions` | `CombinedAutocompleteProvider` from `@earendil-works/pi-tui` — the TUI editor's own completion: @ file mentions, paths, quoted paths, fd walk (gitignore-aware, located via pi's `ensureTool`), pi's fuzzy ranking | the composer's `@` picker |
| `commands.builtin` | `BUILTIN_SLASH_COMMANDS` from pi's core | the command palette's built-in list |

Two consequences worth stating:

- **@ mentions are pi's.** The composer gates when a picker appears
  (`activeMentionToken` — web UX); the suggestions and the insertion
  semantics (directories keep completing, no trailing space; the char at
  the caret is excluded from the prefix) are pi's. A sent `@path` rides the
  prompt **as text**: pi's read tool resolves it model-side (it strips the
  `@` prefix natively), so no file content is ever inlined into the prompt.
- **The built-in command list is pi's.** `/api/agent/:id/commands` merges
  pi's `BUILTIN_SLASH_COMMANDS` at runtime with the session's live commands
  (`pi.getCommands()` + the web core registry, posted over the bridge).
  The web adds only *presentation* flags (`web/shared/commands.ts`:
  `COMMAND_META` — `webPorted` / `web` / `tuiOnly`); commands pi ships that
  the web has never heard of pass through unflagged and dispatch as prompt
  text, exactly like typing them in the TUI.

### Extending the facade

Add a module and register it — the route, validation and lifecycle are
generic:

1. Add the name + params + result to `web/shared/pi-api.ts`
   (`PiApiName` / `PiApiParams` / `PiApiResult`).
2. Implement a `PiApiModule` (`lib/web-pi-apis/types.ts`) — one file per
   api family; its `handle` calls pi's code, `init`/`dispose` own
   lifecycle (the registry lazily initializes on first use and tears down
   on host detach).
3. Register it in `PI_API_MODULES` (`lib/web-pi-apis/index.ts`).

Deep pi imports that the package `exports` map does not open load by file
path — e.g. `../../node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js`.
Both `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent` are
declared dependencies of this repo, so the imports are versioned, not
ambient.

### Lifecycle

- **Per-cwd providers**: modules cache per session cwd (a clone into
  another directory rebuilds); `dispose()` drops the cache.
- **Abort**: every dispatch carries the host's `AbortSignal`; pi's fd walk
  respects it.
- **Failures are responses, not crashes**: an api error becomes
  `{ok: false, error}` — the bridge and the web stay up.

## The plugin system

> One rule: **web plugins are interface bridging (declarative
> descriptors); pi extensions are behavior.** The boundary, the lifecycle
> and the decision test are specified in
> [`docs/web-plugin-architecture.md`](web-plugin-architecture.md).

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
