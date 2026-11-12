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

`web/plugins/*.ts` (or `web/plugins/<id>/descriptor.ts`) — a **declarative descriptor**, data not code. It says:
"extension X publishes view V; render it in region/slot S; offer action A."
It may import only `lib/` contracts. No pi packages, no node, no web
runtime, no logic. The web client learns descriptors at runtime from
`/api/plugins` — the client never imports them either.

A plugin with a bespoke panel (Files, Artifacts) keeps its React UI in
its own folder and registers the panel in `web/plugins/panels.tsx`, reusing
only the core renderers (`web/core/client/plugin-system/`). Descriptors stay
declarative; the UI is still presentation, never behavior.

When a TUI extension grows a web surface, the web plugin is the *bridge
for that surface*: it maps the TUI shape to a web placement. It never
decides anything; it declares.

## The layers and what may import what

```
┌────────────────────────── pi process ──────────────────────────┐
│  extensions/*          behavior: commands, tools, handlers     │
│    │ imports: pi, lib/, vendor/          NOT web/core/*, web/plugins/* │
│    │ publishes: publishWebView(pi, id, view)                   │
├──────────────────────────── contracts ─────────────────────────┤
│  lib/web/plugins/      plugin contract: descriptors, views,     │
│                        actions, UI events, validation           │
│  lib/<x>-web-view.ts   per-plugin shared constants (neutral     │
│                        home both sides import)                  │
│  lib/web-pi-apis/      the pi_api facade: the ONE place that    │
│                        imports pi's built-in modules for the    │
│  web/core/shared/           wire contracts (client↔server):          │
│                        commands, mentions, pi-api shapes        │
├────────────────────────── web server ──────────────────────────┤
│  web/core/server/           host: routes, SSE, bridge, plugin host;  │
│    │ imports: shared, lib/, web/plugins/, pi      NOT web/core/client│
├────────────────────────── browser ─────────────────────────────┤
│  web/core/client/           interface: renders state, forwards       │
│    │ imports: shared (+ type-only lib/web-plugins)             │
│    │            NOT pi, node, server, extensions, lib runtime   │
└─────────────────────────────────────────────────────────────────┘
```

Two import classes with different rules (the guard checks both):

- **Runtime imports** — move code across a boundary; strictly bounded
  per the table above.
- **Type-only imports** (`import type` / `export type … from`) — erased at
  build. Allowed from contract layers only (`web/core/shared`,
  `lib/web-plugins`): the wire legitimately composes the plugin
  contract's types. Never from behavior code (pi packages in the client
  are denied even as types).

## The contracts

Three contract surfaces exist, and each has exactly one home:

| Contract | Home | Speaks between |
|---|---|---|
| Plugin contract (descriptor/view/action shapes) | `lib/web/plugins/` | extension ↔ web plugin ↔ client renderer |
| Per-plugin constants (ids, action names) | `lib/<plugin>-web-view.ts` | the extension and the descriptor |
| Wire contract (commands, pi_api, mentions) | `web/core/shared/` | client ↔ server |
| pi built-in calls | `lib/web-pi-apis/` (the facade) | server ↔ pi's own modules |

**Shared constants are the neutral ground.** The reference pattern is
modes: `lib/modes-web-view.ts` defines `MODES_PLUGIN_ID` and the action
ids; `extensions/modes.ts` (behavior) and `web/plugins/modes.ts`
(interface) both import from there. Neither side imports the other. The
guard fails any extension that imports `web/plugins/` directly.

## The lifecycle

### A web surface, end to end

1. **Descriptor** — `web/plugins/foo.ts` declares the view, placement
   (`region`/`slot`/`anchor`), surfaces and actions. Registered in
   `web/plugins/index.ts` (`WEB_PLUGINS`).
2. **Serving** — the server's plugin host (`web/core/server/plugin-host.ts`)
   loads the registry, validates descriptors, and serves them at
   `/api/plugins`; disabled or quarantined plugins are hidden and their
   actions refused in the same request.
3. **Publishing** — the pi extension calls
   `publishWebView(pi, "foo", view)`; the view rides
   `WEB_PLUGIN_VIEW_EVENT` → the bridge → the client's plugin-state
   frame. While a view is published, the declared placement renders it.
4. **Rendering** — the client renders declarative views
   (`PluginViewRenderer`: status/list/kv/graph/dialog). It renders what
   arrived, and it applies the declared placement under the host's own
   ceilings (see *Placement and host ceilings* below). It computes no
   plugin data.
5. **Actions back** — the user triggers a declared action →
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

### The pi_api facade (read-only built-ins)

When the web needs a pi built-in *capability* (not behavior change), it
calls it through `POST /api/agent/:id/pi_api` — the facade in
`lib/web-pi-apis/` runs pi's own implementation. Today:
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
  `extensions/modes.ts`, constants in `lib/modes-web-view.ts`, interface
  in `web/plugins/modes.ts`.
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
  wire contracts, defined in `web/core/shared` or `lib/web-plugins`.
- Copying pi data into web source (command lists, changelogs) — call it
  at runtime (pi_api, routes) so upgrades cannot drift.
- A "plugin" with logic in `web/plugins/` — descriptors are data; the
  moment they need code, the code belongs in `lib/` (contract) or the
  extension (behavior).

## Enforcement

`tests/web-boundaries.test.ts` walks the source trees, resolves every
static/dynamic/require import (with the type-only distinction), and
applies the table above. Violations fail `npm test` naming the file, the
import and the reason. When you legitimately need a new crossing, change
the zone rules in that test first — a reviewed boundary change, not a
silent reach.
