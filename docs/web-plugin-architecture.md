# The pluggable architecture: web = interface, extension = behavior

> Part of [pi-workflow-extensions](../README.md).

One rule decides everything:

> **If it changes what pi does, it is a pi extension.
> If it changes what the web shows, it is a web plugin.
> The only things that cross the line are contracts.**

This is not stylistic preference; it is debt control. Behavior that leaks
into the interface fork-persists twice (once in the browser, once in pi),
gets fixed twice, and drifts. Interface decisions that leak into behavior
make pi untestable without a browser. The boundary is enforced on the
import graph by `tests/web-boundaries.test.ts` — every `npm test` fails if
source code reaches across, so the rule holds by construction, not by
review discipline.

## The two plugin kinds

### pi extension — behavior

`extensions/*.ts`, loaded by pi's extension runner. It may:

- register commands, tools, event handlers, prompts (`pi.registerCommand`,
  `pi.registerTool`, `pi.events.on`, …)
- call the session context (`ctx.compact`, `ctx.setModel`, …)
- publish web views and receive web actions (the bridge below)
- import pi packages, `lib/`, vendored pi-side code

It may **not** import anything under `web/core/` (client, server, wire
contracts) or `web/plugins/` (interface descriptors). Its entire web
surface is the HTTP bridge + the `lib/` contracts.

### web plugin — interface bridging

`web/plugins/<id>/descriptor.ts` — a **declarative descriptor**, data not code. It says:
"extension X publishes view V; render it in region/slot S; offer action A."
It may import only `lib/` contracts. No pi packages, no node, no web
runtime, no logic. The web client learns descriptors at runtime from
`/api/plugins` — the client never imports them either.

Every plugin owns one folder `web/plugins/<id>/` with its own
`package.json` (`@pi-web-plugin/<id>`, private), so a plugin's npm
dependencies belong to the plugin and never pile up in `web/package.json`.
The web root declares those folders as npm workspaces
(`"workspaces": ["plugins/*"]`), so plugin dependencies still install
and hoist into `web/node_modules`. Register the plugin in
`web/plugins/index.ts` and it ships.

The only place core and plugins meet is the composition roots outside
`web/core/`: `web/app.tsx` (client) imports the shell and the panel
registrations, and `web/server.ts` registers `WEB_PLUGINS` into the server
plugin host before serving. Core itself never imports a plugin — the
dependency stays one-way (plugins → core, core ↛ plugins), enforced by
`tests/web-boundaries.test.ts`.

A plugin with a bespoke panel (Files, Artifacts) keeps its React UI in
its own folder and registers the panel in `web/plugins/panels.tsx`, reusing
only the core renderers (`web/core/client/plugin-system/`). Descriptors stay
declarative; the UI is still presentation, never behavior.

When a TUI extension grows a web surface, the web plugin is the *bridge
for that surface*: it maps the TUI shape to a web placement. It never
decides anything; it declares.

**Two ways to install one.** A first-party plugin is listed in
`web/plugins/index.ts` and registered by the composition root. A plugin from
anywhere else ships a directory with `pi-web-plugin.json` under
`~/.pi/agent/web-plugins`, `<project>/.pi/web-plugins`, or a pi package's
`pi.webPlugins`; the kernel discovers it, validates the manifest without
running code, and compiles its `contributes` block through the same
descriptor validator. The repo tree is a discovery root too, which is how
`web/plugins/files` ships a manifest **and** a server half.

**A server half is code, and lives behind its own rule.** A plugin may declare
`main.server`; that entry point runs in the web server process (native dynamic
import, so it shares the host's module graph). Its directory gets the only
allowance to reach `web/core/server/` — `web/plugins/files/server` is the
single example — because reusing the audited fs policy beats duplicating
traversal rules. Everything else under `web/plugins/` stays declarative.

## The layers and what may import what

```
┌────────────────────────── pi process ──────────────────────────┐
│  extensions/*          behavior: commands, tools, handlers     │
│    │ imports: pi, lib/, vendor/, plugin-contracts, a plugin's  │
│    │ contract.ts      NOT client/server/shared, descriptors     │
│    │ publishes: publishWebView(pi, id, view)                   │
├──────────────────────────── contracts ─────────────────────────┤
│  web/core/plugin-contracts/      plugin contract: descriptors, views,     │
│                        actions, UI events, validation           │
│  web/plugins/<id>/contract.ts   per-plugin bridge contract      │
│                        (id + actions + view factory)            │
│  web/core/pi-api/      the pi_api facade: the ONE place that    │
│                        imports pi's built-in modules for the    │
│  web/core/shared/           wire contracts (client↔server):          │
│                        commands, mentions, pi-api shapes        │
├────────────────────────── web server ──────────────────────────┤
│  web/core/server/           host: routes, SSE, bridge, plugin host;  │
│    │ imports: shared, lib/, pi           NOT web/core/client, plugins│
├────────────────────────── browser ─────────────────────────────┤
│  web/core/client/           interface: renders state, forwards       │
│    │ imports: shared (+ type-only web/core/plugin-contracts)             │
│    │            NOT pi, node, server, extensions, lib runtime   │
└─────────────────────────────────────────────────────────────────┘
```

Two import classes with different rules (the guard checks both):

- **Runtime imports** — move code across a boundary; strictly bounded
  per the table above.
- **Type-only imports** (`import type` / `export type … from`) — erased at
  build. Allowed from contract layers only (`web/core/shared`,
  `web/core/plugin-contracts`): the wire legitimately composes the plugin
  contract's types. Never from behavior code (pi packages in the client
  are denied even as types).

## The contracts

Three contract surfaces exist, and each has exactly one home:

| Contract | Home | Speaks between |
|---|---|---|
| Plugin contract (descriptor/view/action shapes) | `web/core/plugin-contracts/` | extension ↔ web plugin ↔ client renderer |
| Per-plugin bridge contract (id, actions, view shape) | `web/plugins/<id>/contract.ts` | extension ↔ its plugin descriptor |
| Wire contract (commands, pi_api, mentions) | `web/core/shared/` | client ↔ server |
| pi built-in calls | `web/core/pi-api/` (the facade) | server ↔ pi's own modules |

**The contract is the bridge seam.** The reference pattern is modes:
`web/plugins/modes/contract.ts` defines `MODES_PLUGIN_ID` and the action
ids; `extensions/modes.ts` (behavior) and `web/plugins/modes/descriptor.ts`
(interface) both import from there. Neither side imports the other: the
extension never imports the descriptor, and the web never imports the
extension. The guard allows an extension to reach a plugin *only* through
`web/plugins/<id>/contract.ts` (or the dashboard plugin's shared library).

The `extension` field on a descriptor is an id, not a file path: a plugin may
bridge an extension installed as an external pi package, so
`validatePlugin` no longer requires `extensions/<id>.ts` to exist.

## Logic extension points (server half)

The kernel exposes four seams a server-half plugin can use, each behind a
capability and each removed on deactivate:

| Seam | API | Wired at |
|---|---|---|
| Hooks — observe | `ctx.hooks.event(point, fn)` | `session.created`, `session.settled`, `message.appended`, `tool.finished`, `plugin.enabled` |
| Hooks — transform | `ctx.hooks.waterfall(point, fn)` | `prompt.before-send`, `attachment.before-upload`, `message.before-render-model`, `session.list.sort` |
| Hooks — veto | `ctx.hooks.bail(point, fn)` | `session.before-delete`, `file.before-read` |
| Services | `ctx.services.provide/replace/decorate` | `service:session.search`, `service:model.pick`, `service:notifier`, `service:title-generator` |
| Routes | `ctx.routes.get/post/put/patch/delete` | `/api/p/<pluginId>/…` |

Every call site is a named point in `web/core/server/` — `sessions.ts` (prompt
send, session lifecycle, session list sort, delete), `routes.ts` (history
render, model pick) and `web/plugins/files/server/index.ts` (file read). A
veto is recorded in the bounded audit log and surfaced to the caller (403 with
the plugin's own reason); a throwing or slow handler is isolated and counted
toward the breaker, never propagated into the host.

## The lifecycle

### A web surface, end to end

1. **Descriptor** — `web/plugins/foo/descriptor.ts` declares the view, placement
   (`region`/`slot`/`anchor`), surfaces and actions. Registered in
   `web/plugins/index.ts` (`WEB_PLUGINS`). A plugin installed from a directory
   instead ships `pi-web-plugin.json` whose `contributes` block carries the same
   fields; the kernel compiles it through the same validator, so both kinds of
   plugin reach the client identically.
2. **Serving** — the composition root `web/server.ts` registers `WEB_PLUGINS`
   into the server plugin host (`web/core/server/plugin-host.ts`), which
   validates descriptors and serves them at `/api/plugins`; disabled or
   quarantined plugins are hidden and their actions refused in the same
   request.
3. **Publishing** — the pi extension calls
   `publishWebView(pi, "foo", view)`; the view rides
   `WEB_PLUGIN_VIEW_EVENT` → the bridge → the client's plugin-state
   frame. While a view is published, the declared placement renders it.
4. **Rendering** — the client renders declarative views
   (`PluginViewRenderer`: status/list/kv/graph/dialog). It renders what
   arrived, and it applies the declared placement under the host's own
   ceilings (see *Placement and host ceilings* below). It computes no
   plugin data.
5. **Backend** — a plugin with a server half mounts its own routes with
   `ctx.routes` under `/api/p/foo/…`; the dispatcher owns authentication,
   the `routes` capability check, teardown on deactivate and the call budget.
   The Files plugin's `/api/p/files/*` is the reference (see *A plugin's own
   backend* below).
6. **Actions back** — the user triggers a declared action →
   `POST /api/plugins/action` → `WEB_PLUGIN_ACTION_REQUEST_EVENT` → the
   pi extension handles it (behavior). A declared `confirm` string is
   enforced byte-identically before submission; keybindings are
   descriptor data the client binds.

### A session bridge, end to end

- The pi process owning a session attaches (`GET /api/bridge/:id/attach`)
  → SSE command stream in, event stream out (see docs/pi-web.md).
- Commands typed in the web arrive as `{type:"prompt"}` /
  `{type:"web_command"}` and run on the same session the TUI sees.
- Two command registries: pi's `registerCommand` for genuine TUI
  commands; the **web core registry** in `extensions/web.ts` dispatching
  the web's names through the `web_command` channel. Never register the
  same name in both — pi warns "conflicts with built-in".
- The web never spawns behavior on its own: a webPorted command either
  opens a web dialog (interface) or forwards through the bridge
  (behavior executes in pi).

### A plugin's own backend

The interface half declares what the browser shows; the server half declares
what the browser can ask for. Both are declarations, so neither needs a core
edit:

```ts
// web/plugins/acme/server/index.ts — loaded by the kernel from
// pi-web-plugin.json → main.server
import type { PluginRuntime } from "../../../core/plugin-contracts/kernel/manager.ts";

const runtime: PluginRuntime = {
  setup(ctx) {
    ctx.routes.get("summary/:id", async (request) => ({
      status: 200,
      body: { id: request.params.id, root: request.sessionRoot },
    }));
  },
};

export default runtime;
```

`GET /api/p/acme/summary/42?sessionId=…` reaches it. The split of
responsibilities is deliberate:

| Concern | Owner |
|---|---|
| Which routes exist, and for how long | the kernel (registered in `setup`, removed on deactivate/rollback/quarantine) |
| Path shape inside `/api/p/<pluginId>/` | the plugin (validated: no `..`, no `*`, `:param` segments only) |
| Authentication, CSRF, body limits | the core server (`web/core/server/http.ts`, `auth.ts`) |
| Session resolution (`sessionId` → `sessionRoot`) | the dispatcher, before the handler runs |
| Time budget, error isolation, 502 mapping | the dispatcher (`runWithBudget`, 10 s default) |
| The bytes/JSON of the answer | the plugin |

A handler that must own the response — streaming a file, holding a long-lived
write — reads `request.transport` (the real `IncomingMessage`/`ServerResponse`)
and returns `{ handled: true }`. That is the one escape hatch, and it exists
because the Files plugin streams with Range support.

**Capabilities still apply.** `ctx.routes` throws without the `routes`
capability, exactly like `ctx.hooks` and `ctx.services`, so a manifest that
forgot it fails activation with a named error instead of silently exposing an
endpoint.

## The pi_api facade (read-only built-ins)

When the web needs a pi built-in *capability* (not behavior change), it
calls it through `POST /api/agent/:id/pi_api` — the facade in
`web/core/pi-api/` runs pi's own implementation. Today:
`autocomplete.suggestions` (pi's editor completion for the `@` picker)
and `commands.builtin` (pi's built-in command list). The facade is
read-only by design; anything that *changes* pi state goes through the
bridge commands, where pi runs it.

## The decision test

Ask, for anything new:

| Question | Yes → |
|---|---|
| Does it change what pi does (commands, tools, session state, file effects)? | pi extension |
| Is it a TUI surface that needs a web counterpart? | web plugin (descriptor) + the extension that publishes |
| Does the web need to *read* a pi built-in (completion, lists)? | pi_api facade module |
| Is it purely how the browser renders or arranges things? | web client |
| Do two sides need the same constant? | `lib/<plugin>-web-view.ts` |

Worked examples from this repo:

- **modes** — the full reference pattern: behavior in
  `extensions/modes.ts`, constants in `web/plugins/modes/contract.ts`, interface
  in `web/plugins/modes/descriptor.ts`.
- **@ mentions** — the client gates the picker (UX); pi's provider
  supplies the suggestions (pi_api); pi's read tool resolves the sent
  mention (behavior, in pi).
- **`/compact` from the web** — the composer dispatches through the
  `web_command` channel; `ctx.compact` runs in pi. The web never
  compacts.
- **`/model` picker** — interface port: the web dialog renders the model
  list pi posted; picking sends `set_model` through the bridge.

## Anti-patterns (each is now a failing test)

- A web component computing pi behavior (routing, decisions, state
  mutation) — behavior belongs in the extension.
- An extension importing `web/core/shared/` or `web/plugins/` — the bridge
  and lib contracts are its only web surface.
- The client importing pi packages, even types — pi's shapes cross as
  wire contracts, defined in `web/core/shared` or `web/core/plugin-contracts`.
- Copying pi data into web source (command lists, changelogs) — call it
  at runtime (pi_api, routes) so upgrades cannot drift.
- A "plugin" with logic in `web/plugins/` — descriptors are data; the
  moment they need code, the code belongs in `lib/` (contract), the
  extension (behavior), or the plugin's own `server/` entry (its declared
  backend).
- A plugin route that re-implements authentication, session resolution or
  path policy — the dispatcher owns those; the handler owns the answer.
- A descriptor field nothing mounts. Anchors, overrides and `sessionPanel`
  are mounted by the client (`AnchorHost`, `ComponentOverrideHost`,
  `panel-policy.ts`); a new placement must come with its host, or it is
  dead metadata.

## Enforcement

`tests/web-boundaries.test.ts` walks the source trees, resolves every
static/dynamic/require import (with the type-only distinction), and
applies the table above. Violations fail `npm test` naming the file, the
import and the reason. When you legitimately need a new crossing, change
the zone rules in that test first — a reviewed boundary change, not a
silent reach.

## Scaffold

`templates/web-plugin/` is the copy-paste starting point: a shared
constants file, a bridge-shaped extension, a declarative descriptor, and a
per-plugin `package.json`, with a README that walks the rename/register
steps and the two typed channels (`publishWebView` out, the action-request
event in, and the `web/core/pi-api/` facade for built-ins). It lives
outside the guarded zones on purpose — copy each piece into place, never an
entire template into a zone.
