# Web plugin boilerplate

A **plugin** is a thin, declarative **bridge** for a pi extension. The
extension owns behavior; the plugin owns the web surface. The extension is
**optional** — you can write a plugin for an extension installed elsewhere
(an external pi package).

> **If it changes what pi does, it is a pi extension.
> If it changes what the web shows, it is a web plugin.
> The only thing that crosses the line is the contract.**

A plugin is **one folder with three files**:

```
web/plugins/<id>/
├── package.json      # @pi-web-plugin/<id> (private)
├── contract.ts       # plugin id + action ids + view factory (the bridge seam)
└── descriptor.ts     # declarative: slots, placement, actions — imports contract.ts
```

The **extension** imports the plugin's `contract.ts` to publish views and
answer actions. The descriptor imports it to declare them. Neither imports the
other directly.

## 1. Copy and register

```sh
id=hello-world   # your id, ^[a-z][a-z0-9-]*$

mkdir -p "web/plugins/$id"
cp templates/web-plugin/contract.ts   "web/plugins/$id/contract.ts"
cp templates/web-plugin/descriptor.ts "web/plugins/$id/descriptor.ts"
cp templates/web-plugin/package.json  "web/plugins/$id/package.json"
```

Rename `hello-world` → `$id` across the three files (mind that an id like
`my-plugin` is not a JS identifier, so also rename the `helloWorldWebView` /
`helloWorldPlugin` symbols). Then import the descriptor in
`web/plugins/index.ts` and add it to the `WEB_PLUGINS` array.

## 2. Wire the extension (the bridge)

Your extension (in `extensions/<id>.ts`, or an external package) publishes the
view and answers the action by importing the plugin's contract:

```ts
import { publishWebView } from "../web/core/plugin-contracts/publisher.ts";
import { WEB_PLUGIN_ACTION_REQUEST_EVENT, type ActionRequestPayload } from "../web/core/plugin-contracts/actions.ts";
import { HELLO_WORLD_GREET_ACTION, HELLO_WORLD_PLUGIN_ID, helloWorldWebView } from "../web/plugins/hello-world/contract.ts";

export default function helloWorldExtension(pi: ExtensionAPI) {
  let greets = 0;
  const publish = () => publishWebView(pi, HELLO_WORLD_PLUGIN_ID, helloWorldWebView(++greets));

  pi.on("session_start", () => publish());
  pi.events?.on(WEB_PLUGIN_ACTION_REQUEST_EVENT, (data: unknown) => {
    const request = data as Partial<ActionRequestPayload> | undefined;
    if (request?.pluginId === HELLO_WORLD_PLUGIN_ID && request.actionId === HELLO_WORLD_GREET_ACTION) {
      publish();
    }
  });
}
```

The two channels, both through the shared contract:

- **extension → web** — `publishWebView(pi, PLUGIN_ID, view)` pushes a
  validated `status`/`kv`/`list`/`graph`/`dialog` view; the client renders it
  where the descriptor placed it.
- **web → extension** — the descriptor declares `actions`; when the user runs
  one, the client emits `WEB_PLUGIN_ACTION_REQUEST_EVENT` with
  `{ requestId, pluginId, actionId, sessionId }`. Match `pluginId` first,
  then `actionId`.

The generic vocabulary lives in `web/core/plugin-contracts/`; the per-plugin
ids and view shape live in `contract.ts` inside the plugin folder.

## 3. Plugin dependencies

A plugin's npm dependencies belong to its own `package.json` and install via
the web root's npm workspaces (`web/package.json` → `"workspaces": ["plugins/*"]`).
Keep plugin-internal dependencies out of `web/package.json`.

## 4. When you need a backend endpoint

A plugin may ship a **server half** (`main.server`) that mounts its own HTTP
routes under `/api/p/<id>/` — no core edit, no route table entry:

```ts
// web/plugins/<id>/server/index.ts
import type { PluginRuntime } from "../../../core/plugin-contracts/kernel/manager.ts";

const runtime: PluginRuntime = {
  setup(ctx) {
    ctx.routes.get("summary", async (request) => ({
      status: 200,
      body: { session: request.sessionId, root: request.sessionRoot },
    }));
  },
};

export default runtime;
```

Declare it in a `pi-web-plugin.json` beside the descriptor:

```jsonc
{
  "id": "hello-world",
  "name": "Hello world",
  "version": "1.0.0",
  "engines": { "piWeb": "^1.0.0", "sdk": "^1.0.0" },
  "main": { "server": "./server/index.ts" },
  "trust": "trusted",
  "capabilities": ["routes"],
  "activation": ["onStartup"],
  "contributes": { "surfaces": [{ "kind": "sidebar" }], "title": "Hello world" }
}
```

The dispatcher owns authentication, the `routes` capability check, the
`sessionId` → `sessionRoot` resolution and a 10 s budget (a throw or timeout is
a 502, never a crash). The route exists only while the plugin is active. See
`web/plugins/files/server/index.ts` for a streaming example that owns the
response via `request.transport` and returns `{ handled: true }`.

## 5. When you need a panel (rare)

Most plugins are declarative only — no React. A bespoke panel (Files, Artifacts)
keeps its components in `web/plugins/<id>/`, registers them in
`web/plugins/panels.tsx` (`PLUGIN_PANELS`), and reuses
`web/core/client/plugin-system/` renderers. The descriptor stays declarative.