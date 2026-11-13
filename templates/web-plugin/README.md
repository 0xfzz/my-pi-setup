# Web plugin boilerplate

The reference template for a web plugin in this repo. Copy the four pieces
below into place, rename `hello-world` to your plugin id, and register it.
The template compiles from a single rule (see
[`docs/web-plugin-architecture.md`](../../docs/web-plugin-architecture.md)):

> **If it changes what pi does, it is a pi extension.
> If it changes what the web shows, it is a web plugin.
> The only things that cross the line are contracts.**

A plugin is **two halves plus one neutral file**:

| Piece | Template path | Copy to | Kind |
| --- | --- | --- | --- |
| Shared constants + view factory | `lib/hello-world-web-view.ts` | `lib/<id>-web-view.ts` | pure data (no pi, no web) |
| pi extension (behavior) | `extension/hello-world.ts` | `extensions/<id>.ts` | behavior (imports pi + `lib/`) |
| Web descriptor + `package.json` | `web/hello-world/` | `web/plugins/<id>/` | interface (declarative, imports `lib/` only) |

## 1. Copy and rename

```sh
id=hello-world   # your plugin id, ^[a-z][a-z0-9-]*$

cp templates/web-plugin/lib/hello-world-web-view.ts "lib/$id-web-view.ts"
cp templates/web-plugin/extension/hello-world.ts        "extensions/$id.ts"
mkdir -p "web/plugins/$id"
cp templates/web-plugin/web/hello-world/descriptor.ts   "web/plugins/$id/descriptor.ts"
cp templates/web-plugin/web/hello-world/package.json    "web/plugins/$id/package.json"
```

Then, in `sed -i "s/hello-world/$id/g"` for each copied file (mind the hyphen —
an id like `my-plugin` cannot be a JS identifier, so also rename the exported
symbols `helloWorldWebView` / `helloWorldPlugin` / `helloWorldExtension`
accordingly).

## 2. Register it

- **Extension** — append `"./extensions/$id.ts"` to
  `package.json` → `pi.extensions` (the root package, not the web one).
- **Descriptor** — import it in `web/plugins/index.ts` and add it to the
  `WEB_PLUGINS` array.

`npm run tidy` will then typecheck, lint, and test both halves, and the
boundary guard (`tests/web-boundaries.test.ts`) will confirm neither half
reaches across the contract.

## 3. The bridge (pi APIs)

The two halves never import each other; they talk through two typed channels.

**Extension → web.** `publishWebView(pi, PLUGIN_ID, view)` pushes a validated
declarative view (`status`, `kv`, `list`, `graph`, `dialog`) over the event
bus; the web client renders it where the descriptor places it. The view shape
comes from `web/core/plugin-contracts/view.ts`; per-plugin constants belong in
`lib/<id>-web-view.ts` so both halves import the same ids and factory.

**Web → extension.** The descriptor declares `actions`; when the user runs one,
the client emits `WEB_PLUGIN_ACTION_REQUEST_EVENT` with
`{ requestId, pluginId, actionId, sessionId }`. The extension subscribes and
matches on `pluginId` first, then `actionId`. Confirm-style actions are
enforced by the host before the event is emitted.

**Web → pi built-ins.** Anything the web UI itself needs from pi (autocomplete,
settings, trust, auth, built-in commands) goes through the one facade
`lib/web-pi-apis/` — not through a plugin descriptor. Register a module there
when a new web surface must call into a pi built-in.

## 4. Plugin dependencies

Every plugin owns its folder's `package.json` (`@pi-web-plugin/<id>`, private).
Put npm dependencies there, and they install via the web root's npm workspaces
(`web/package.json` → `"workspaces": ["plugins/*"]`). The web root's own
`package.json` must not carry plugin-internal dependencies.

## 5. Where a panel goes (only when you need one)

Most plugins are declarative only — no React. A panel (like Files, Artifacts) is
the exception: keep its components in `web/plugins/<id>/`, register them in
`web/plugins/panels.tsx` (`PLUGIN_PANELS`), and reuse
`web/core/client/plugin-system/` renderers. The descriptor itself stays
declarative.