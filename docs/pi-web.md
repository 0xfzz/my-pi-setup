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
| `npm run build` | esbuild bundle + Tailwind/shadcn CSS compile into `core/client/dist` |
| `npm start` | serve the built client (`tsx server.ts`) |
| `npm run check` | tsc over server, client and shared |
| `npm test` | build, then unit tests over `core/server`, `core/client`, `core/shared` and `plugins/` |
| `npm run test:e2e` | Playwright e2e with the fixture session (needs a browser) |

From the pi TUI, `/web start | reload | stop | status | set-password | clear-password` manages a detached
instance on port 30142 (`lib/web-ui.ts`): single-instance with takeover,
esbuild when sources changed, direct `node --experimental-strip-types`
spawn (no npm wrapper holding the server's stdio), and auto-reload watching
`web/` plus the plugin contract directories. A session also re-checks the
running server at start, so a server left behind by an earlier session is
rebuilt and restarted instead of being attached to at its old version — see
[One version across sessions](#one-version-across-sessions).

## Architecture

```
packages/
  pi-web-bridge/  standalone pure protocol SDK (@pi-web/bridge); web/core/protocol re-exports it
web/
  server.ts     composition root: registers WEB_PLUGINS into the plugin host,
                then starts the core server (core never imports a plugin)
  app.tsx       client composition root: wires the core shell to the
                first-party plugin panels/pages before the first render
  core/         everything plugins may depend on — the one-way boundary
    server/     Fastify HTTP host (tsx)
      app.ts           app factory: cookies/headers/errors, static registration
      main.ts          listener lifecycle, auth and build-watcher wiring
      client-static.ts @fastify/static + stamped HTML/extensionless SPA policy
      routes.ts        native /api routes: sessions, agent, bridge, plugins
      sessions.ts      session core: spawn/resume via the SDK, live registry,
                       commands (prompt/abort/web_command), disk scan, history
      wire.ts          event projection for the browser
      event-stream.ts  event producers: replay, coalescing, JSON heartbeats
      plugin-host.ts   the plugin host: discovery, kernel wiring, ui sink
    http/       shared HTTP mechanisms, independent of either host runtime
      sse.ts           @fastify/sse framing/lifecycle + byte-pressure adapter
    client/     React 19 SPA (esbuild bundle into core/client/dist)
      shell.tsx        base regions + slots + overrides + routing
      use-session.ts   the session hook (one EventSource per session + the
                       push-driven directory stream)
      transcript.tsx, composer.tsx, streaming.ts
      components/ui/   shadcn/ui primitives (button, textarea, input, badge, separator)
      lib/utils.ts     cn() class-merge helper
      globals.css      shadcn/Tailwind theme tokens (compiled into dist)
      plugin-system/   view renderer, slots, anchors, panels, pages, actions, shortcuts
    shared/     regions.ts, commands.ts, pi-api.ts — contracts used by server + client
    plugin-contracts/  view vocabulary, descriptors, actions, kernel, publisher
    pi-api/     the pi_api facade modules (below)
    e2e/        e2e.mjs + files-viewers.e2e.mjs — the Playwright suite
  plugins/      the first-party plugins (descriptors, bespoke panels, server halves)
```

The plugin contract itself lives in the root repo and is shared with the
TUI: `web/core/plugin-contracts/` (view vocabulary, descriptors, actions, kernel,
publisher) and `web/plugins/` (the descriptors). Extensions publish views
from `extensions/*.ts` — unchanged from the vendored era.

The pure protocol vocabulary has its own installable package:
`packages/pi-web-bridge` (`@pi-web/bridge`). Server, client and core protocol
shims re-export it so there is one implementation; plugin browser projects use
the SDK and the generated host-module import map instead of `web/core/*`. The
legacy core paths remain only for declarative descriptors and server halves.

## Realtime design

One SSE stream per selected session (`GET /api/agent/:id/events`)
multiplexes everything:

- **Agent events** — message deltas, tool execution status, lifecycle —
  projected by `web/core/server/wire.ts` (no turn markers, no system messages,
  slimmed tool payloads, no cumulative partial snapshots).
- **`plugin_state` frames** — the session's plugin views, working model
  and running flag, pushed on every real store revision and deduplicated
  by session content, so slots, pages, region overrides and the working
  indicator update without reloads. A UI-sync replay of unchanged values
  is acknowledged without changing state, so it cannot rebroadcast the
  whole snapshot.
Commands `POST /api/agent/:id` (`prompt`, `abort`, `get_state`,
`web_command`). The transcript loads one bounded page from
`GET /api/agent/:id/history?limit=…`; the response carries opaque cursors
for older pages and for entries appended later. Live prompts and replies
append from the SSE stream, and a reconnect reads only entries after the
stored cursor instead of reloading the transcript. The session list is push-driven over
`GET /api/sessions/events` (one directory EventSource: a full snapshot on
connect, then running/idle and add/remove transitions — no polling), with
`GET /api/sessions?q=…` for whole-directory search. The selected session
persists in `localStorage`, so reloads and plugin-page navigation
reconnect the stream. All four event streams (agent, directory, TUI attach,
and standalone graph) use `@fastify/sse` through `web/core/http/sse.ts`.
Backpressure: rebuildable deltas drop above 512 KiB queued; the primary
streams cut the connection before admitting a frame beyond 16 MiB, so the
client reconnects and re-snapshots. Accounting includes producer staging,
formatter queues and UTF-8 socket bytes, not just Node's raw string length.
Agent/directory retain 30-second JSON heartbeats and 150-ms tool-progress
coalescing; TUI attach uses library keepalive comments while registration
healing remains application-owned.

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
  surfaces and working line in realtime — including pi's compaction events
  (`session_before_compact`, `session_compact`, `session_compact_failed`),
  in the same wire shape an in-process session produces.
- **Two command channels, two registries.** `pi.registerCommand` is pi's —
  for genuine TUI commands (pi's built-ins like `/compact` already own
  those names there; shadowing them is exactly the "conflicts with
  built-in" warning). The **web core registry** (`extensions/web.ts`)
  registers the same names for the web and dispatches through its own
  bridge channel `{type:"web_command"}` — the handlers call pi's ctx
  methods (`ctx.compact`, rename, new-session, reload). Compaction is the
  exception: a session the server owns runs it directly on its own core
  (there is no pi process to ask, and a bus emit reaches no listener), while
  a bridged session forwards the command to the extension that holds the
  context; the other commands re-route through the prompt path, where the
  mode-gated pi commands dispatch them.
- When the extension (re)posts its command list (`web_commands` events),
  the bridge fans a `commands_changed` event to the browser streams; the
  client refetches `/api/agent/:id/commands`, so a `/reload` in the TUI
  refreshes the web palette too.

**Built-in commands.** All 24 pi built-ins dispatch from the web: 13 are
web-ported (model, thinking, session, changelog, copy, export, resume,
hotkeys, settings, scoped-models, trust, login, logout — client dialogs
or actions), and 11 dispatch through the web-command channel into the web
core registry in the pi process (compact, name, new, clone, reload, fork,
tree, import, quit + share and bug). Nothing is terminal-only anymore.
Session-control commands run with a valid command context by dispatching
through pi's runner (`/web-<name>` registered commands reached via the
prompt path), never a captured context; `/tree` renders a searchable,
keyboard-navigable tree picker from pi's own `getTree()` projection,
`/fork` picks through the extension dialog pipeline (answerable from
either frontend), `/settings` and `/scoped-models` edit pi's own
SettingsManager, `/trust` writes pi's trust store, `/login`/`/logout`
drive pi's ModelRuntime credential flows, and `/share`/`/bug` run pi's
export and report machinery — each posting a result dialog.

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
history. Without a TUI attached, a real server now uses the same bridge shape:
`/api/agent/new` and disk resumes start a detached headless pi RPC owner that
holds the AgentSession, and the HTTP process only bridges to it. A server
reload drops the bridge, not the session; the owner reattaches when the new
process is healthy. `PI_WEB_SESSION_HOST=0` selects the older in-process runner
(it is also the fallback on Windows, where the FIFO-backed RPC stdin is not
available). The owner's pi executable is resolved from `<agent-dir>/bin/pi`
first, since a detached server need not have the managed launcher on its PATH;
`PI_WEB_PI_BIN` overrides it for custom installs. A spawn failure fails the
request without taking the web server down. A persistent pid file under the
agent dir lets a replacement server wait for an existing owner instead of
starting a second one on the same session file, and an owner retires itself if
the web stays gone for two minutes.

### Reloading without killing sessions

`/web start` launches a detached source watcher, so file edits are seen even
with no terminal session open. Client-only changes are rebuilt in place: the
build id changes and open pages reload, while the server and its sessions keep
running. A server/runtime change needs a new process; the watcher asks the
server for its live-session counts (`/api/reload-state`) and defers the restart
while a session owned **by this process** is live. Bridged sessions survive by
definition and do not block it. Before a restart the server fails readiness,
refuses new API work, and ends every SSE stream with a `retry` hint so browsers
and bridges reconnect to the replacement. `/web stop` and `/web reload` also
retire the watcher; `/web reload` starts a fresh one with the new server.

## Password protection (publishing the web)

By default the server listens on `127.0.0.1` with no login, which is fine on your
own machine. To reach it from elsewhere, set a password first — the web can
run shell commands through the agent, so an open port is a remote shell.

```
/web set-password      # type it twice into a hidden prompt (TUI only)
/web clear-password    # turn protection off again
/web status            # reports "Password protection: on/off"
```

- The password is never accepted as an argument (it would land in your history);
  at least 10 characters.
- It is stored as a scrypt hash in `~/.pi/agent/web-auth.json` (mode 0600;
  `PI_WEB_AUTH_FILE` overrides). A running server picks the change up
  immediately — no `/web reload`.
- Changing the password rotates the signing secret, so **every existing browser
  session is signed out** at once, and the open event streams are cut.
- A corrupt auth file **fails closed**: the server answers 503 instead of
  serving unprotected.

**Reaching it from other machines.** Start pi with `PI_WEB_HOST=0.0.0.0` (the
detached server inherits it), or leave the server on loopback and put a TLS
reverse proxy or tunnel (Caddy, nginx, cloudflared, Tailscale) in front. Use
HTTPS on the public side: the password and cookies cross the network. Behind
nginx set `proxy_set_header Host $host;` so the same-origin check sees the public
host (or list it in `PI_WEB_ALLOWED_ORIGINS`).

Set `PI_WEB_HSTS=1` once HTTPS is in place to emit
`Strict-Transport-Security: max-age=31536000; includeSubDomains` on every
response. It is off by default so a plain-HTTP localhost server never tells
browsers to upgrade to a TLS endpoint that does not exist.

A non-loopback bind **refuses to start** without a configured password (run
`/web set-password` first). `PI_WEB_ALLOW_UNPROTECTED=1` is an explicit, dangerous
override for isolated networks. Likewise, `PI_WEB_TRUST_PROXY=all` is refused on
a public bind because any client can forge forwarding headers; either keep the
default `loopback` policy with a local proxy, use `off` for a direct bind, or set
`PI_WEB_ALLOW_TRUST_ALL_PROXY=1` if you deliberately accept the risk.

### Tokens

| Token | Lifetime | Where it lives |
|---|---|---|
| Access (HS256 JWT) | 15 min | `pi_web_at` cookie — HttpOnly, SameSite=Strict, `Secure` over https |
| Refresh (HS256 JWT, different key) | 30 days sliding, 1 year absolute | `pi_web_rt` cookie — same flags, path `/api/auth` only |

JavaScript never sees either token (no XSS exfiltration), and `EventSource`,
which cannot set headers, authenticates through the cookie. Environment knobs:
`PI_WEB_ACCESS_TTL_SECONDS`, `PI_WEB_REFRESH_TTL_DAYS`.

**Refresh rotation.** Every refresh returns a new refresh token and retires the
old one; the server tracks one *family* per login (persisted in
`web-auth-sessions.json`, so `/web reload` and restarts sign nobody out). A retired token
replayed after a 10 s grace window means a copy leaked, so the whole family is
revoked. Inside the window — two tabs, parallel requests — the duplicate just gets a
fresh access token, so ordinary use never trips it. Logout and revocation take
effect on the very next request, because access tokens are also checked against the
live session.

**Why no endpoint fails on an expired token.** The client (`web/core/client/auth.ts`):

1. refreshes proactively, a minute before expiry and whenever a backgrounded tab wakes;
2. wraps `fetch` so any `/api` 401 triggers one refresh, shared by every request
   failing at that moment, then a single retry — callers never see the expiry;
3. reopens an event stream that died on a 401 (`EventSource` never retries those);
4. coordinates tabs with a Web Lock and a `localStorage` hint so they do not rotate
   the token against each other;
5. treats only a 401 from the refresh endpoint as "signed out" — being offline or a
   5xx keeps the session and retries.

### Other protections

- `/api/health`, `/api/auth/*` and the static client are public (the client must load
  to show the login screen; it carries no data). Everything else under `/api` needs
  a valid access token.
- The bridge routes (`/api/bridge/*`) accept only the **bridge token** from
  `web-auth.json`, which the pi TUI presents automatically; a browser session cannot
  impersonate a session's owner.
- Login throttling: 5 wrong passwords lock a client for 15 min; a global cap
  (100 / 15 min) backstops distributed guessing. Clients are told apart by IP — behind a
  local proxy the last `X-Forwarded-For` hop is used (`PI_WEB_TRUST_PROXY=1` trusts a
  non-loopback proxy, `0` never). If you lock yourself out, restart the server.
- CSRF: SameSite=Strict plus a `Sec-Fetch-Site` / `Origin` check on writes. Set
  `PI_WEB_REQUIRE_CSRF_HEADER=1` to also require the first-party
  `x-pi-web-csrf: 1` header on cookie-authenticated writes (the bundled client
  always sends it). Bearer-token and body-token clients are unaffected.
- Scripts can sign in with `POST /api/auth/login {"password": "...", "returnTokens": true}`
  and use `Authorization: Bearer <accessToken>`; refresh with
  `POST /api/auth/refresh {"refreshToken": "..."}` (one refresh at a time).

**Deployment checklist.** pi-web has one operator credential, not per-user
accounts: anyone who can sign in can drive the agent, read project files,
edit provider/MCP settings and run shell commands. Do not share the URL and
password as if it were a multi-user service — put an identity-aware proxy
(OIDC/mTLS) or a private tunnel in front, and run the server as a dedicated,
least-privileged user. For a public listener, set a password, keep the proxy
trust policy at its default, enable `PI_WEB_HSTS=1` and
`PI_WEB_REQUIRE_CSRF_HEADER=1`, and terminate TLS at the proxy.

**Diagnostics.** Both hosts run on Fastify. Request ids are always assigned;
a structured logger is enabled at `warn` level so ordinary requests stay
silent and only warnings/errors are emitted. The request field set is
credential-safe: the query string (which can carry a graph bootstrap token) is
dropped, and headers/bodies are never serialized. Startup/process messages and
the plugin action audit are separate and unchanged.

## HTTP API

| Route | Method | Purpose |
|---|---|---|
| `/api/health` | GET | liveness + `bootId` + the served client `buildId` (always public) |
| `/api/reload-state` | GET | live/bridged session counts used by the reload guard |
| `/api/auth/status` | GET | `{ required, authenticated }` — public |
| `/api/auth/login` | POST | password → cookies (public, throttled) |
| `/api/auth/refresh` | POST | rotate the refresh token, new access token |
| `/api/auth/logout` | POST | revoke the session, clear cookies |
| `/api/plugins` | GET | visible descriptors (kernel: enabled, unquarantined) |
| `/api/plugins/action` | POST | the plugin action route (below) |
| `/api/plugin-manager` | GET | plugin kernel state for the manager page |
| `/api/plugin-manager/:id/:action` | POST | enable / disable / reload / clear-quarantine |
| `/api/p/<pluginId>/…` | * | a plugin's own backend routes |
| `/api/sessions/events` | GET | the push-driven session directory stream (snapshot + transitions) |
| `/api/sessions` | GET | live + disk sessions, newest first (`?q=` searches the whole directory) |
| `/api/agent/new` | POST | spawn a pi session (`createAgentSession`) |
| `/api/agent/:id` | GET / POST | state read / prompt, abort, get_state |
| `/api/agent/:id/events` | GET | the SSE stream |
| `/api/agent/:id/history` | GET | one transcript page (`cursor`, `direction=older|newer`, `limit`) |
| `/api/agent/:id/commands` | GET | pi's runtime built-ins + the session's live commands |
| `/api/agent/:id/protocol` | POST | versioned Bridge Protocol envelopes (the retired `pi_api` alias is gone) |
| `/api/agent/:id/tree` | GET | pi's tree, projected for the web picker |
| `/api/agent/:id/models` | GET | the picker's model list (scoped or available) |
| `/api/agent/:id/model` | POST | apply a model (`/model <provider/id>`) |
| `/api/agent/:id/thinking` | POST | set the thinking level |
| `/api/agent/:id/branch` | GET | the session directory's git branch, or null |
| `/api/directories` | GET | directory listing for path pickers |
| `/api/changelog` | GET | pi's changelog for the `/changelog` dialog |
| `/api/sessions/:id` | DELETE | delete a session (`session.before-delete` may veto) |

Every non-GET API request to a wrong method gets 405; unknown sessions 404. With a web password set, every route except `/api/health` and `/api/auth/*` answers 401 without a valid access token (see [Password protection](#password-protection-publishing-the-web)).

## Bridge Protocol — pi's built-ins, called not copied

The web never reimplements pi features. Every web capability crosses one
versioned seam: `POST /api/agent/:id/protocol` carries a `pi-web-bridge` v1
envelope (`kind`, `name`, `messageId`, `source`, `payload`) and gets a reply
envelope or a named `BridgeError`. Session-less directory work (session list,
search and create) uses `POST /api/protocol` with no `sessionId`; both routes
share the same handshake, capability and audit rules. Commands and queries
dispatch to core adapters; sequenced envelopes with a resume cursor stream over
the existing SSE routes. The `bridge.hello` reply is the raw `bridge.hello-ack`
object; every other reply is an envelope. Plugin halves share one
selection-following client: catalog events arrive as `protocol_envelope`
payloads on the session stream instead of opening one SSE connection per
subscribed name, and a terminal `startup_error` closes that client's session
streams instead of reconnecting forever. The old `pi_api` route was a Phase 7
alias and is retired. The catalog and parity matrix are
generated in [bridge-protocol-catalog.md](bridge-protocol-catalog.md) and
[bridge-protocol-parity.md](bridge-protocol-parity.md). A plugin may declare
`bridge.core.messages` to receive only the catalog names it needs; undeclared
calls are denied and audited. `bridge.extension.messages` declares namespaced
plugin-owned events/commands with inline JSON schemas; the SDK registry,
kernel lifecycle, bindings and generic bridge relay enforce ownership and
validation without changing the frozen catalog. A browser half runs only
after hash-bound operator confirmation; safe mode, protected points and the
per-contribution breaker are enforced by the browser host in `web/app.tsx`.

The wire vocabulary of the 15 built-in APIs still lives in `web/core/shared/pi-api.ts`
(names, params, results);
`web/core/pi-api/` implements it as pluggable modules over pi's own code:

| api | pi implementation | web surface |
|---|---|---|
| `autocomplete.suggestions` | `CombinedAutocompleteProvider` from `@earendil-works/pi-tui` — the TUI editor's own completion: @ file mentions, paths, quoted paths, fd walk (gitignore-aware, located via pi's `ensureTool`), pi's fuzzy ranking | the composer's `@` picker |
| `commands.builtin` | `BUILTIN_SLASH_COMMANDS` from pi's core | the command palette's built-in list |
| `settings.read` / `settings.write` | `SettingsManager` — pi's effective settings, written through its setter methods | the web `/settings` dialog |
| `settings.models.read` / `settings.models.write` | `SettingsManager.getEnabledModels` / `setEnabledModels` | the web `/scoped-models` dialog |
| `trust.read` / `trust.write` | `ProjectTrustStore` + `getProjectTrustOptions` from pi's trust-manager | the web `/trust` dialog |
| `mcp.read` / `mcp.write` | pi's MCP config (`loadMcpConfig`) and its own config mutators (`addMcpServerConfig`, `removeMcpServerConfig`, `updateMcpServerConfig`) | the MCP manager page |
| `auth.read` / `auth.login` / `auth.state` / `auth.answer` / `auth.logout` | `ModelRuntime` (`listCredentials`, `login`, `logout`) against pi's shared auth.json | the web `/login` and `/logout` dialogs |

Three consequences worth stating:

- **@ mentions are pi's.** The composer gates when a picker appears
  (`activeMentionToken` — web UX); the suggestions and the insertion
  semantics (directories keep completing, no trailing space; the char at
  the caret is excluded from the prefix) are pi's. A sent `@path` rides the
  prompt **as text**: pi's read tool resolves it model-side (it strips the
  `@` prefix natively), so no file content is ever inlined into the prompt.
- **The built-in command list is pi's.** `/api/agent/:id/commands` merges
  pi's `BUILTIN_SLASH_COMMANDS` at runtime with the session's live commands
  (`pi.getCommands()` + the web core registry, posted over the bridge).
  The web adds only *presentation* flags (`web/core/shared/commands.ts`:
  `COMMAND_META` — `webPorted` / `web` / `tuiOnly`); commands pi ships that
  the web has never heard of pass through unflagged and dispatch as prompt
  text, exactly like typing them in the TUI. (Today every pi built-in is
  flagged, so `tuiOnly` is an empty set — the composer still honours it for
  future commands.)

- **Project trust is core, not a plugin.** The “trust this folder?”
  prompt that gates `.pi/` config, `mcp.json` and project extensions is
  pi's built-in project trust. The web already bridges it with the
  `/trust` dialog (`trust.read` / `trust.write` over pi's
  `ProjectTrustStore`) and the `/settings` default-project-trust control —
  no plugin is needed. A plugin `pi.on("project_trust")` cannot bridge the
  *first* prompt anyway: project trust resolves **before** `session_start`
  fires, so the web bridge is not attached yet. Answer it once in the
  terminal (or pre-set it from the web) and it is persisted.

### Extending an adapter

Add a module and register it — the route, validation and lifecycle are
generic:

1. Add the name + params + result to `web/core/shared/pi-api.ts`
   (`PiApiName` / `PiApiParams` / `PiApiResult`).
2. Implement a `PiApiModule` (`web/core/pi-api/types.ts`) — one file per
   api family; its `handle` calls pi's code, `init`/`dispose` own
   lifecycle (the registry lazily initializes on first use and tears down
   on host detach).
3. Register it in `PI_API_MODULES` (`web/core/pi-api/index.ts`).
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

A descriptor (`web/plugins/<id>/descriptor.ts`) declares **surfaces**:

| Surface | Effect |
|---|---|
| `{ kind: "slot", slot }` | inline strip (`top` / `bottom`) or navbar-opened panel (`center` / `floating`); sidebar placement takes precedence |
| `{ kind: "page", path }` | dedicated page at `/plugins/:id` |
| `{ kind: "override", region }` | **replaces a base region** — `header`, `status`, `transcript`, `composer` — while a view is published; the built-in region returns automatically |
| `{ kind: "sidebar" }` | navbar icon opens the view in the right-hand panel; takes precedence over inline slot placements |

**Placement hints** (`ui[].placement` and `ui[].strategy`) are applied by the
client's slot policy (`web/core/client/plugin-system/slot-policy.ts`):

- `strategy: "compact"` renders the slot's one-line summary in any slot.
- `maxHeight` bounds a centre card's body and a floating card; `maxWidth`
  bounds a floating card. The host clamps both to its ceilings (body 360px,
  card 400px), so a plugin asks for less space and never more.
- `collision: "hide"` removes an inline slot on phones (≤720px).

Sidebar, centre, and floating views are hosted in the right panel, opened only
from the plugin's navbar icon. They never occupy chat height or float over its
content. Sidebar placement also suppresses any duplicate top/bottom slot for
that plugin. Plugins declaring only a top/bottom slot keep their inline strip;
region overrides and dialogs are unchanged.

**Anchors** are the named host spots a plugin may add to instead of replacing:
`app.header`, `session.header`, `session.sidebar`, `chat.before`, `chat.after`,
`chat.composer`, `chat.working`, `file-panel.header`, `viewport.overlay`. A
`ui[]` contribution with `placement: { kind: "anchor" }` mounts there, ordered
by `order`, then `priority`, then plugin id, and gated by `visibleWhen`
(`always` / `running` / `idle` / `has-view`). `AnchorHost`
(`web/core/client/plugin-system/AnchorHost.tsx`) mounts them at each spot and
`anchor-policy.ts` (in the same `plugin-system/` directory) decides what goes
where — pure functions, unit-tested
without a browser.

One published view renders once. The precedence is **region override → panel →
anchor**: a plugin whose view already replaced a base region, or that the
navbar opens in the right panel, is not mounted again at an anchor.

**Component overrides** replace or hide a host component by key
(`ui.working-indicator.v1`, `ui.extension-status.v1`, …) through
`ComponentOverrideHost`. A declarative view has no way to receive and re-render
the built-in, so `mode: "wrap"` renders the plugin's view *beside* the built-in
(which always survives) while `replace` and `hide` suppress it. Resolution is
the shared contract's (`resolveOverrides`), so the client and
`validateRegistry` cannot disagree.

Descriptors may declare an optional host-rendered `icon`: `files`, `list-checks`,
`tree-structure`, `users`, `chart-bar`, `sliders`, `spinner`, or `puzzle-piece`.
Legacy plugins without an icon use the puzzle-piece fallback. Icons are a
closed vocabulary, never plugin-supplied SVG, HTML, or URLs. The navbar is a
single scrollable row on narrow screens; panels retain their mobile overlay.

Extensions publish views with `publishWebView(pi, pluginId, view)` from
`web/core/plugin-contracts/publisher.ts`. Views are **declarative and validated
server-side** — `kv`, `list` (status icons + markdown detail), `status`,
`graph` (nodes, edges, markdown detail) — so a plugin never ships client
code. The vocabulary: `web/core/plugin-contracts/view.ts`.

**User plugins**: drop a directory with a `pi-web-plugin.json` into
`~/.pi/agent/web-plugins` (or `.pi/web-plugins` in a project); the kernel
(`web/core/plugin-contracts/kernel/`) discovers it, validates the manifest
before running any code, tracks enable state, and quarantines misbehaving
ones. The manifest's `contributes` block carries the same descriptor fields
(`title`, `icon`, `description`, `surfaces`, `ui`, `actions`, `sessionPanel`),
so a discovered plugin's view appears at `/api/plugins` exactly like a
first-party one. Precedence for a duplicate id is project > user > package >
repo; the losers are listed as `shadowed` in the manager.

First-party plugins may use the same mechanism: `web/plugins/files` ships a
real manifest with a server half, so the repo tree is a discovery root too.

**Fully independent plugin projects** add a manifest with `main.browser`
pointing to a bundled `.js`/`.mjs` file, place the package under an absolute
path from `PI_WEB_PLUGIN_ROOTS`, enable it through the plugin manager, then
confirm the hash-bound browser-code prompt. The authenticated
`/api/browser-halves` routes publish metadata and the exact asset bytes;
containment, MIME, size limits, safe mode and the breaker apply to every
external half. New projects import `@pi-web/bridge`; first-party browser
bundles additionally use the generated `@pi-web/host-ui` module so React and
the panel/page registries stay single instances. The old core import paths are
a legacy allowance for declarative descriptors and server halves only.

### A plugin's own backend endpoints

A plugin extends the HTTP API the same way it extends the UI — by declaring,
not by editing core. `ctx.routes` mounts handlers under
`/api/p/<pluginId>/`:

```ts
export default {
  setup(ctx: PluginContext) {
    ctx.routes.get("summary/:id", async (request) => ({
      status: 200,
      body: { id: request.params.id, sessions: await countSessions(request.sessionRoot) },
    }));
  },
} satisfies PluginRuntime;
```

`GET /api/p/acme.metrics/summary/42` then reaches it. The dispatcher
(`web/core/server/plugin-routes.ts`) owns everything the plugin must not
re-implement: the route exists only while the plugin is active (routes are
removed on deactivate), registration needs the `routes` capability, the path
stays inside the plugin's own namespace, `sessionId` is resolved to
`sessionRoot` before dispatch, and every call runs under a 10 s budget — a
handler that throws or hangs answers 502 with `plugin_route_failed` /
`plugin_route_timeout` instead of crashing the host. For byte streams, return
`{ stream: { stream: readable, status: 200, headers, close } }`: the dispatcher
sends the Node Readable through Fastify and calls the optional, idempotent
`close` callback on completion, error, or disconnect. `close` may return a
promise. Streams returned after a timeout or disconnect are destroyed and
released without being sent. `request.headers` supplies incoming headers such
as `range`, and `request.signal` aborts on disconnect or budget expiry.

`request.transport` with `{ handled: true }` remains a **deprecated external
plugin compatibility API only**, isolated in
`web/core/server/legacy-plugin-transport.ts`. It contains the real Node pair,
not a synthetic response. Once a legacy plugin writes headers, the host never
appends JSON; a subsequent throw/timeout terminates an unfinished response.
First-party plugins must use the body/stream result contract.

The Files plugin is the reference: `web/plugins/files/server/index.ts` mounts
`/api/p/files`, `/read`, `/search` and `/download`, reusing the audited
traversal/symlink policy in `web/core/server/files.ts` rather than duplicating
it. Its client (`web/plugins/files/lib/files-api.ts`) calls those routes.

### A plugin's realtime surface

A server half does not have to be request/response. Two seams cover the other
directions, and neither needs a client change:

| Need | Seam |
|---|---|
| React to live session activity | `ctx.events.on("session.tool" \| "session.message" \| "session.lifecycle", fn)` |
| Show something in the browser | `ctx.ui.view / notify / status / widget` — the same store an extension publishes into |
| Tell another plugin something | `ctx.events.emit("<yourId>.<name>", payload)` and `listen` |

```ts
// web/plugins/activity/server/index.ts — capabilities: ["tap.pi-events:session.tool", "ui.publish"]
export default {
  setup(ctx) {
    ctx.events.on("session.tool", (event) => {
      ctx.ui.status(event.sessionId, `tool ${event.payload.toolName}`);
    });
  },
} satisfies PluginRuntime;
```

`web/plugins/activity` is the worked example: it taps tool/message/lifecycle
events and publishes a declarative list view plus one status line, with no
client code, no route and no polling. Full rules — payload bounds, ordering,
the reserved host state a plugin may not publish, and the channel namespace —
are in [web-plugin-architecture.md](web-plugin-architecture.md#realtime-communication-the-three-directions).

### The plugin manager

`/plugins/core.plugin-manager` is a first-party **core** plugin, so safe mode
(which starts only `core.*`) can never lock the operator out of the surface
that fixes a broken plugin. It lists every installed plugin with its lifecycle
state, granted/pending capabilities, mounted routes and quarantine reason, and
drives four operator actions through `/api/plugin-manager`:

| Request | Effect |
|---|---|
| `GET /api/plugin-manager` | status, safe mode, warnings, shadowed ids, routes, audit tail |
| `POST /api/plugin-manager/:id/enable` | activate (retry a failed plugin) |
| `POST /api/plugin-manager/:id/disable` | deactivate, dependents first |
| `POST /api/plugin-manager/:id/reload` | re-import the plugin's own module tree (entry and siblings) and roll back on failure |
| `POST /api/plugin-manager/:id/clear-quarantine` | clear the breaker and retry |

An unknown plugin is 404, a refused action (quarantined, unresolved) is 409
with the kernel's own message.

**Actions** are descriptor-declared and relayed over the session event bus:

- *confirmed action* — requires typing the exact confirm string
  (byte-identical; 403 otherwise), e.g. the monitor's `request sync`
- *instant action* — one click, optionally keybound (e.g. **Alt+M** for
  the modes switch; shortcuts never fire while typing in a field)

Semantics: 404 before validation, 403 on a confirm mismatch (nothing
emitted), 409 while another *confirmed* action is in flight for the
session, then audit + single-use requestId relay. Instant actions and the
web core channel skip the in-flight lock — they are fire-and-forget
dispatches, so a lock there would refuse the next click (e.g. rapid
Normal↔Plan toggling). The web server never executes
anything itself — the owning extension re-checks and republishes.

**Region overrides** resolve per session in `web/core/shared/regions.ts`;
when several plugins override one region, registry order decides and the
conflict is reported in the `plugin_state` frame and shown as a banner.
`example-override` is the reference plugin: inert until its instant
"Replace the composer" action runs.

### One version across sessions

A web server is spawned detached, so it outlives the pi session that started
it, and the client bundle is a build artifact with fixed file names. Both facts
let versions drift apart: one session's browser could render a plugin set, a
contract or a whole bundle that another session never sees. Four mechanisms
keep every session on one version:

| Mechanism | What it removes |
|---|---|
| Build-input fingerprinting (`lib/web-ui-reload.ts`) | A contract or entry edit that is bundled into the client but not fingerprinted restarts the server without rebuilding — new server code, old client. |
| Session-start convergence (`extensions/web.ts`) | A server started from older sources is compared against the current fingerprints when a session starts, and rebuilt+restarted once (shared reload lock). |
| Build identity (`web/core/server/client-build.ts`) | The build writes `dist/build.json`; the server stamps the id into the served HTML and reports it on `/api/health` and the directory snapshot. A page whose stamp differs reloads onto the served bundle, once per build. |
| Registry push (`web/core/server/plugin-registry-broadcast.ts`) | Enable/disable/reload/quarantine change the served set; the kernel's audit log drives a `plugins_changed` frame, so an open tab re-reads `/api/plugins` instead of keeping its page-load snapshot. |

A plugin **reload** re-imports the plugin's own module tree
(`web/core/server/plugin-module-loader.ts`): the plugin directory resolves with
a per-load generation query, so its entry and its sibling modules re-evaluate,
while modules outside it — the kernel, the files policy, the host — keep their
identity. A plain `import()` would return the cached module and report success
while running the old code.

### Owned processes — no leaks, no orphans

A plugin can be deactivated, disabled, reloaded or quarantined at any moment,
and the host can exit while it is running. A child process it started does not
disappear with it: it outlives the object that created it and becomes an orphan
holding a port, a file or a lock. So the kernel is the owner of record, and
`ctx.resources` is the only supported way to create something that outlives a
JS object:

```ts
export default {
  activate(ctx: PluginContext) {
    const child = ctx.resources.spawn("node", ["worker.js"]);   // needs the `exec` grant
    ctx.resources.interval(() => ctx.ui.notify(sessionId, "tick"), 30_000);
    const controller = ctx.resources.signal();                  // aborted on deactivate
  },
} satisfies PluginRuntime;
```

Everything created here is disposed with the plugin, LIFO, in the same drain as
`ctx.register`. Disposers may return a promise and are **awaited** under the
deactivate budget, so `disable` does not resolve while a child is still dying.

Durability comes from three layers:

| Layer | What it guarantees |
|---|---|
| Deactivate / reload / activate-failure | that plugin's children are SIGTERMed, then SIGKILLed after a grace; timers cleared |
| `host.shutdown()` | every remaining child is released, then the pidfile is removed |
| Boot | children a **dead** predecessor left behind are reaped before any plugin runs |

Ownership is recorded in `<statePath>.children.json` (`web-plugins.json.children.json`
by default). Reaping never kills on trust: each record carries the child's
`/proc/<pid>/stat` start token, so a pid the OS recycled for an unrelated
process fails the match and is skipped, and a record whose owning host is still
alive is left alone. A pid that is alive but cannot be proven ours is reported
in `warnings`, not signalled.

Exit is bounded for the same reason. `main()` runs teardown under one deadline
(`web/core/server/shutdown.ts`, 5 s total, equal share per step), so a hung SSE
close cannot starve the plugin host of the time it needs to release children;
the process exits regardless, and a `process.on("exit")` hook makes a
synchronous last-resort kill for the paths no signal handler sees.

This is a durability contract, not a sandbox: plugin code runs in-process and
can import `child_process` directly. A child spawned outside `ctx.resources` is
invisible to the kernel and survives its plugin. Children spawned through
`ctx.resources` are never `detached` — a detached child is an orphan by design.

## The working indicator

`ui.working.changed` events stream the frames and message (the bubbly
spinner's TUI data through the unified UI store); the transcript's
working line animates them while the session reports itself running.

## Popups and the web UI primitives

The web core ports pi's TUI interaction primitives, so any extension can
bridge its TUI UI to the web without web-specific code. Extensions publish
the same `ui.*` events in both hosts (`publishWebUi` in
`web/core/plugin-contracts/publisher.ts`); the unified store keeps per-session state
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
from the extension — the contract lives in `web/core/plugin-contracts/ui-contracts.ts`.

## Dialogs — the TUI command port and the model picker

pi's TUI answers several commands with a selector or dialog; the web now
answers them with its own. The composer intercepts the ported names
(`webPorted` in `web/core/shared/commands.ts`) and runs the web side:

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
| `/compact`, `/name`, `/new`, `/clone`, `/reload`, `/web` | direct | dispatched as session commands; `/compact` also renders the live status and the transcript marker |

Every pi built-in is ported or dispatched — nothing is terminal-only, so the
composer's TUI-only notice is currently unreachable (it stays as the guard
for future built-ins).

**The model chip** sits at the composer with the thinking level, both live:
the extension posts `web_models` (the picker's list: scoped or available
models) and `session_state` (current model/thinking) at attach, at every
turn start and after any change; picking a model POSTs to the session and
the TUI applies it (`pi.setModel`) — footer included. The picker offers the
scope as one tab and every available model as "All models", and a pick from
either tab resolves: the bridge looks the `provider/id` up in the whole
catalogue it posted, not only in the scope, so a model outside the scope is
selectable exactly as it is in the TUI's selector. A model changed in
the terminal (its own `/model`, Ctrl+P) reaches the web at the next turn's
`session_state` push, and the state the fetch-on-settle reads carries the
same model so nothing resurrects a stale one. The list itself is the attach
snapshot's (`web_models`); a post sent before the attach opens is refused,
and a session whose list never landed falls back to a one-row picker holding
only the current model — the symptom of a dropped post, not of a scope.

**The context-window meter** reads the same state, so the snapshot has to
carry `contextUsage` and has to be posted *after* the attach stream opens:
the server has no bridge before that, refuses the post, and the meter — which
only dashes when it has no reading — stays blank until a turn settles. The
snapshot is posted on every (re)attach, and again on each `ui_sync`, so a
browser attaching later sees the current reading rather than the one cached
when the bridge opened. The command list (`web_commands`) rides the same
attach snapshot for the same reason: a fresh bridge caches nothing, and the
composer's palette reads that cache.

**The workspace line** sits at the top of the input field: a folder icon and
the directory the session runs in, then its git branch when that directory is
a worktree. It has a row of its own rather than a place beside the context
meter, so a long path ellipsizes instead of squeezing the model and thinking
chips. The path comes from the session list the client already holds, so it
needs no request of its own; the branch comes from `GET /api/agent/:id/branch`,
one read per selection, because git's answer can change (a checkout, a new
clone) and nothing else reports it. That route runs
`git symbolic-ref --short HEAD` in the session's directory — read-only,
bounded by a one-second timeout — and answers `null` for a detached HEAD, a
directory that is not a repository, a missing git binary or an unreadable
path. A null branch leaves the line to the path alone rather than showing an
error: the line is context, not session state. Both segments ellipsize rather
than widening the field, and the tooltip carries the full `<path> · <branch>`.

**Compaction** is announced twice over, because pi has two paths for it and
they are not the same event. Pi's own compactions — a typed `/compact`, the
context threshold, overflow recovery — emit `compaction_start` and
`compaction_end`. A compaction an extension contributes as a `turn_end`
boundary draft (this repo's VCC controller is one) is committed directly by
pi and announced as an appended `compaction` entry instead, with no start or
end at all. The wire projects both: the start/end pair keeps its reason,
cancellation flag, token counts and failure text, and an appended compaction
entry becomes a `compaction_applied` signal. The summary never crosses the
wire either way — the transcript marker reads the saved entry, so a custom
compactor's row renders exactly like pi's own and a reloaded transcript shows
the same thing as the live one.

The browser shows the state in two places. While a compaction runs, the
working line takes over with pi's own wording — "Compacting context...",
"Auto-compacting...", or "Context overflow detected, auto-compacting..." —
which replaces a plugin's working message rather than deferring to it, since
the compaction is not the plugin's work. Afterwards, a `Compacting` marker row
in the transcript says how many tokens the summary replaced and folds the
summary away until clicked. A *failed* compaction is different: it changed
nothing, so there is no entry to read. A manual failure comes back on the
command response and shows in the composer; an automatic one has no HTTP
response to carry it, so the marker row itself holds the reason — otherwise
the browser would show a context that never shrank and no explanation why.

One asymmetry is worth knowing. For a session the **TUI owns**, the browser's
events come from the extension, which forwards the three `session_*` compaction
events and nothing else — the extension API does not surface the internal
appended-entry event to extensions. So a boundary-draft compaction in a
TUI-owned session is not announced live; its marker appears on the next
transcript read (a reconnect, a session switch, or a reload). A session the
**server owns** has no such gap: its core sees the entry directly.

**Extensions can open web dialogs too** — the web's extensibility surface:
publish a `dialog` view (title, markdown body or lines, up to 8 actions,
`open: false` to close) through the same view events as every other view.
The web renders it modally; its action buttons dispatch through the plugin
action pipeline back to the extension. That, plus slots, region overrides,
pages, toasts, statuses, widgets and the ui.* events, is the full kit an
extension uses to extend the web UI.

**Extensions can contribute web commands too.** The `web_command` channel runs
a command in the pi process on the session's context. The bridge owns its own
built-ins; another extension contributes one through a two-way conversation on
the session bus (`web/core/plugin-contracts/web-commands.ts`): it announces
descriptors (`web-plugin:commands`) and runs the command when the bridge asks
for it back by name (`web-plugin:web-command`). A shared module registry cannot
work here — pi evaluates every extension with `moduleCache: false`, so no two
extensions share a module instance. The host re-asks on each `ui_sync`, so a
consumer attaching late still sees the list. Two flags are presentation only.
`managesModels` contributes a page beside the built-in **Models** picker in
its shared sidebar dialog; several commands may claim it (the provider editor
and the router both do), and the pages are ordered by their label so the nav
does not reshuffle with the extensions' load order. `addsModels` marks the one
command that is the picker's **+ Add models** entry — the command that puts a
model *into* the catalogue — so a second catalogue page cannot take an entry it
cannot serve. `settingsEntry` supplies the sidebar label and
`settingsPlugin` explicitly names the plugin publisher whose dialog is embedded
in the right content pane. The host suppresses that publisher's standalone
popup while the shared dialog owns it; plugin-specific UI stays in the plugin.
Dialog actions may declare `placement: "header"` to appear beside the pane's
title (for example, **Add provider**); other actions stay in the footer.
A dialog can also publish `items`: selectable text rows with `id`, `label`,
optional `detail`, `actionId` and bounded `values`. Clicking a row uses the same
plugin action pipeline as a button. This lets plugins supply interactive lists
without adding subject-specific rendering or operations to the host.

**Restarting the server rapidly trips the crash-loop guard.** Two process
starts within 60s boot the plugin kernel in safe mode: only `core.*` plugins
activate, `/api/plugins` hides the rest, and every plugin action answers 404
"Plugin not found" while published views still render — so the UI looks alive
but clicks do nothing.

A deliberate exit no longer counts: `main()` installs SIGTERM/SIGINT handlers
that close the server and shut the plugin host down, and that shutdown forgets
the start it is ending, so a reload or supervisor restart is not a crash. An
unannounced start still counts, which is what the guard is for.

To leave safe mode without restarting, use the operator action — the plugin
manager page shows a **Leave safe mode** button, and the same action is
available over HTTP:

```sh
curl -X POST http://127.0.0.1:<port>/api/plugin-manager/kernel/clear-safe-mode \
  -H 'content-type: application/json' -b '<your session cookie>' -d '{}'
```

It clears the recorded starts and activates the enabled plugins that safe mode
parked, in dependency order.

A dialog may also declare **`fields`** — a form of typed answers (`text`, a
masked `secret`, or a `select` menu) — and a `submitsInput` action then
carries them back as `values` (a name→value record), so a multi-step dialog
is possible without the host knowing anything about its subject: the
extension publishes one step and receives the answers. A `secret` field may
not carry a value (a pre-filled credential would live in the event stream),
a `select` needs its choices, and a dialog declares `input` or `fields`, not
both. Give each step its own dialog `id`: a new id starts a fresh form, while
a re-publish of the same id keeps what the user typed (which is how a
refused value is corrected in place).

## Minimalist workspace

The shell uses a Claude Code-inspired split layout: a quiet 232px session
sidebar, a compact project header, a centered transcript, and a single bordered
composer. Published plugin views open in the existing right-hand preview panel;
no placeholder file browser or extra navigation is added.

- **Plugin panels** are opened by their own icon in the top navbar. Clicking a
  different icon switches the right panel; clicking the active icon, its close
  button, or Escape closes it. Buttons show only for published non-dialog views.
  Sidebar plugins never also render cards, strips, or floating buttons in chat.
- **Search sessions** filters the sidebar by project path or session ID.
- The header's **Sessions** toggle hides or restores the sidebar on desktop;
  on phones it opens the existing off-canvas overlay.
- Theme and sign-out controls live in the sidebar footer. Model and thinking
  controls sit below the message box; commands, file mentions, attachments,
  streaming, plugin actions, and region overrides keep their existing behavior.
- Light and dark palettes are neutral, with color reserved for outcome/status
  indicators. A thin context-window meter sits just above the composer and
  tracks the session's token usage (amber above 80%, red above 95%). The web
  continues to follow the OS unless a theme is saved.

## Themes

Both themes are the same slot variables. The legacy stylesheet
(`web/core/client/base.css`) switches on `data-theme` on `<html>`; the
shadcn/Tailwind tokens (`web/core/client/globals.css`) switch on the `.dark`
class. `theme.ts` (in `web/core/client/`) moves both together, set before the first React render
(no flash). The choice is `pi-web-theme` in localStorage; with no stored
choice the web follows the OS and re-follows it live. The toggle is the
Moon/Sun button in the sidebar footer (a Phosphor icon). Shadows and modal
scrims are theme-aware (`--scrim`), so plugin views and popups read fine
in both.

## Design system

The client is styled with [shadcn/ui](https://ui.shadcn.com) primitives
(vendored into `web/core/client/components/ui/`, new-york style, neutral color
base) on top of Tailwind CSS v4, with [Phosphor icons](https://phosphoricons.com)
(`@phosphor-icons/react`) for every icon so there is one consistent set.
`@shadcn/lint` is wired through oxlint (`.oxlintrc.json`): app code under
`web/core/client/` is checked against `no-inline-styles`, `no-raw-colors` and
`no-arbitrary-values`, while the vendored `components/ui/` directory is
excluded because it carries the canonical class strings those rules police
elsewhere.

## Responsive layout and render performance

Below 720px the session sidebar collapses off-canvas behind the hamburger
(List) toggle in the header and reopens as an overlay with a scrim;
selecting a session closes it, and crossing from wide to narrow closes it
automatically.
Nothing renders wider than the viewport — the transcript, composer and
plugin views wrap. The panel overflow menu uses direct Open and adjacent
Pin/Unpin actions on phones, rather than a sideways submenu. Each action
has a 44px-high touch target; the menu is constrained to the viewport and
scrolls vertically when the available height is short (including landscape
and keyboard-sized viewports). Desktop panels keep their submenus.

On touch keyboards, Return inserts a newline and the Send button submits the
whole draft; desktop Enter-to-send and Shift+Enter remain unchanged. The
composer grows with multiline drafts up to a viewport-relative height cap.
Touch inputs use 16px text to avoid iOS focus zoom without disabling pinch
zoom. The app follows `visualViewport` resize and pan events so the composer
stays above the software keyboard, and restores its height when the keyboard
closes. Dialogs use that same frame, so a phone bottom sheet and its scrollable
list stay above the keyboard instead of disappearing behind it. Picker search
fields do not claim focus on touch devices — that would open the keyboard
before the list is visible — and disable browser autocomplete suggestions.
Pinch zoom does not trigger a layout resize.

The Files plugin opens full-screen on phones. Its header's expand/restore
button also lets desktop users maximize either the explorer or a file
preview. Restore returns to the docked panel/drawer without resetting the
explorer search or remounting a loaded document viewer. Escape first exits
full-screen mode; a second Escape closes the restored panel. This is an
in-app full-screen layout, not the browser Fullscreen API, so it works on
mobile Safari too. File search uses 16px text and phone file controls have
44px touch targets.

## Logging

The web server uses Pino for all diagnostics. The terminal shows colorized,
human-readable lines when attached to a TTY; the same records are appended to
`~/.pi/agent/logs/pi-web.log` (or `$PI_CODING_AGENT_DIR/logs/pi-web.log`) by
default. Request IDs, request errors, startup and shutdown, plugin boot
failures, process warnings, uncaught exceptions and unhandled rejections share
that stream. Crash records include the error's stack trace.

`PI_WEB_LOG_LEVEL` selects `fatal`, `error`, `warn`, `info` (the default),
`debug` or `trace`. `PI_WEB_LOG_FILE` overrides the file path; set it to `off`
to keep logs only on the terminal. `PI_WEB_LOG_FILE_FORMAT=json` switches the
file from readable text to newline-delimited JSON for log tooling, and
`PI_WEB_LOG_PRETTY=off` forces plain terminal output (useful behind a log
collector). Credential-looking keys and common token patterns in free text are
replaced with `[REDACTED]` before either destination sees them.

The file is not meant to be read raw: it is not rotated and about 99% of it is
request/response pairs. `npm run web-log` prints a bounded digest instead
(failures grouped by cause with repeat counts, failed and slow routes, restarts,
per-process summary) and reads both the JSON and the pretty format. `--since 30m`,
`--pid`, `--around`, `--req` and `--grep` zoom in on one failure. The
`read-web-log` skill (`.agents/skills/read-web-log`) tells agents to use it
rather than `cat`/`tail`; the logic lives in `lib/web-log-*.ts`.

Browser `console.warn`/`console.error`, uncaught errors and unhandled promise
rejections are batched to `POST /api/client/log` with their stacks. Browser log
requests deliberately use the native `fetch` captured before auth wraps it, so
a failed log delivery cannot recurse through the auth retry loop. The endpoint
is authenticated, bounds message and stack lengths, caps batches at 20 entries
and writes them into the same log with `source=browser`. Handled failures from
fetch, response-body reads, session commands, plugin boot and routes, SSE setup,
pi_api dispatch and detached session hosts also reach the same stream; expected
validation responses stay user-facing without being reported as crashes.

Loading feedback starts before each fetch: the host shows a non-blocking
“Loading… Please wait.” status above dialogs and full-screen plugins. It
counts concurrent requests (and JSON/text/blob body reads), only disappearing
once they settle, including errors and cancellation. It fits narrow phones
and keyboard-sized screens without moving the layout or intercepting taps.
Plugins need no request-tracking dependency: the host wraps browser fetch
before authentication and plugin requests start. Persistent EventSource
connections do not keep this indicator spinning forever.

The status is revealed for work that is actually slow, never for a blink: a
request must stay outstanding for a moment before the card appears, and once
shown it stays long enough to be read. A prompt fires several quick
overlapping requests, and publishing each one made the card flicker in and out
of the corner, so the reveal and the minimum visible time are deliberate.

Sessions, conversation history, directory browsing and lazy file viewers have
local loading messages instead of premature empty states. Native image and
media previews show loading until decoding/metadata is ready, and media
shows it again when buffering. Office previews follow the viewer's loading
state; streamed PDFs retain the PDF reader's own loading feedback. Errors
replace loading, and spinner animation respects reduced-motion preferences.

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
(`PI_WEB_TEST_PLUGIN_VIEWS=1`): base shell, session selection, per-plugin
navbar icons and panel switching, chat without duplicate plugin slots, the
composer region override, the working indicator, the Alt+M
shortcut, the plugin page with its graph, and the confirmed-action round
trip whose accepted requestId flows into the graph label over SSE without
a reload.
