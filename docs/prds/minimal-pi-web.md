# PRD: Minimal pi-web — a plugin-first web client

Status: Accepted
Date: 2026-11-09
Owner: faiz (implemented by the pi agent)

## Problem

`vendor/pi-web` is a ~177k LOC vendored Next.js fork. Roughly 95% of it —
settings, MCP/models config, file explorer, terminal panel, auth, PWA, i18n,
session search, minimap, branch navigation — is unused in our workflow, yet
every plugin change must be carried across a heavyweight fork. The plugin
system is bolted onto a chrome-heavy shell instead of being the shell.

## Goal

Replace the fork with a first-party, minimal web client under `web/`:

- **Base pi UI only**: session transcript, composer, mode/status — realtime.
  "Not too much going on" — the app is a chat core plus plugin surfaces.
- **Extremely customizable plugin system**: any user can add a plugin by
  dropping a descriptor into `web-plugins/` and publishing views from an
  extension. Plugins can *add* features (slots, pages, actions) **and
  override the minimal base regions** declaratively.
- **Simple and realtime**: one plain Node server (tsx), one SSE stream per
  client carrying transcript events, working updates and plugin views; one
  React SPA bundled with esbuild. No Next.js.

## Non-goals (v1)

Auth/login, multi-user, PWA, i18n, settings/MCP/models/file/git/terminal UI,
session search, minimap, branch navigator, web push, project-trust dialogs,
extension custom-TUI-over-RPC rendering (requests fail gracefully with a
diagnostic), subagent web panels (subagents still run via the SDK default).

## Architecture

```
web/
  package.json        # deps: @earendil-works/pi-coding-agent, react, react-dom; dev: esbuild, playwright
  server/             # plain Node HTTP (tsx), no framework
    main.ts           # static serve, routes, SSE plumbing
    sessions.ts       # trimmed session manager: spawn pi RPC sessions, registry, commands
  client/             # React SPA, esbuild bundle
    app.tsx           # shell: header, transcript, composer, plugin surfaces
    ...renderers      # ported from vendor components/plugins/*
  e2e/                # Playwright, same patterns as the vendored suite
```

- **Session core**: `createAgentSessionServices` +
  `createAgentSessionFromServices` from `@earendil-works/pi-coding-agent`
  (the same primitives `vendor/pi-web/lib/rpc-manager.ts` uses, minus its
  3.4k LOC of trust/model/lease/push chrome). Sessions spawn on demand and
  register in a live map.
- **Event wire**: port `agent-event-wire/stream/connection` (~900 LOC) —
  `GET /api/agent/:id/events` is an SSE stream of message updates, working
  updates, session meta and plugin views; the client reconnects
  automatically. Commands (`send`, `abort`, `set-mode`) go through
  `POST /api/agent/:id`.
- **Plugin host**: first-party move of the 567-line `web-plugins-host`
  (store, `recordView`, `attachSessionPlugins`, action relay, audit) to
  `lib/web-plugins/host.ts`, adapted from Next responses to plain Node. The
  registry is the existing `web-plugins/index.ts`; descriptors and the
  extension-side publishers in `lib/web-plugins/publisher.ts` are unchanged,
  so all 7 existing plugins keep working without edits.
- **Client**: React 19 + esbuild. Slots (top/center/bottom/floating), plugin
  pages (`/plugins/:id` via client-side routing), view renderers
  (kv/list/graph + markdown + line icons), action menus and keybinding
  dispatch — ported from `components/plugins/*` (first-party, ~1.7k LOC).

## Override contract (the new capability)

Base regions: `header`, `status`, `transcript`, `composer`.

Descriptor surfaces gain `{ kind: "override", region: <Region> }`. A plugin
publishes a view targeted at the region; while a valid view is present the
base UI renders **that view instead of the built-in region**, and when the
view is absent the built-in default returns automatically. Rules:

- Override views use the existing WebView vocabulary (kv/list/graph/…),
  validated server-side — no arbitrary client code, ever.
- Region views are per-session, like all plugin views.
- If more than one plugin overrides a region, the last registration wins and
  the conflict is visible in diagnostics.
- Slots remain the additive mechanism; overrides are the replacement
  mechanism. A minimal install can therefore become a full custom cockpit
  plugin by plugin.

## Realtime design

One SSE per client page (`/api/agent/:id/events`) multiplexes: transcript
message updates, working updates, mode changes, plugin view revisions and
action feedback. Reconnect replays state via snapshot endpoints (same
revision-stamped pattern the plugin host already uses). The session list is
a lightweight poll. No WebSockets.

## Migration plan

1. **Phase A** — scaffold `web/` (package, server skeleton, client shell).
2. **Phase B** — session core + transcript + composer (interactive base).
3. **Phase C** — plugin host + surfaces + actions; 7 plugins unchanged.
4. **Phase D** — override regions.
5. **Phase E** — e2e, docs rewrite (`docs/pi-web.md`), delete
   `vendor/pi-web`. Git history preserves the fork if anything must be
   recovered.

## Testing

- Node `--test` units for server routes, session manager, host and contract
  extensions (same infra as the root suite).
- Renderer units using the React server-render pattern the vendored
  `.test.mjs` files use.
- Playwright e2e against the standalone server with fixture sessions
  (`PI_WEB_TEST_PLUGIN_VIEWS`-style seeding), asserting base UI, plugin
  surfaces, actions and an override fixture.

## Success criteria

- `npm run web` serves the app; sessions list, transcript streams realtime,
  composer sends input, abort works.
- The 7 existing web plugins render identically in slots/pages with actions
  and keybindings intact.
- An override plugin replaces the composer region in a test fixture, and
  removing its view restores the built-in composer.
- First-party LOC (server + client + tests) stays under ~10k; no Next.js in
  the dependency tree.
- `vendor/pi-web` is deleted; `npm run tidy` and the new suites pass.

## Constraints

- Never execute plugin-provided client code; overrides are declarative views.
- Extensions and publishers (`lib/web-plugins/*`, `web-plugins/*`,
  `extensions/*`) are contract-stable — the rewrite consumes them unchanged.
