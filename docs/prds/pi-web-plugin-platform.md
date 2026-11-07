# PRD: pi-web plugin platform — everything is a plugin

> Follow-up to [Fully pluggable, event-driven pi-web UI](./pi-web-pluggable-ui.md). That PRD delivered declarative placement and a working-indicator bridge. An [audit](#2-audit-summary) of it found the system lets plugins *position host-rendered data*, not *change pi-web*. This PRD turns pi-web into a small **kernel** and makes every feature, UI and non-UI, a plugin that can be replaced, wrapped, extended or removed without editing `vendor/pi-web`.

| Field | Value |
| --- | --- |
| **Status** | proposed |
| **Owner** | Faiz |
| **Scope** | `lib/web-plugins/` (contracts + SDK), `web-plugins/` (first-party plugins), `vendor/pi-web/` (kernel only), `docs/` |
| **Related** | [pi-web-pluggable-ui](./pi-web-pluggable-ui.md), [plugin-actions](./plugin-actions.md), [fork-pi-web-integration](./fork-pi-web-integration.md) |
| **Amends** | pluggable-ui non-goal "arbitrary third-party JavaScript" and goal G6; see [§7](#7-trust-and-security) |

## 1. Problem and vision

Today a plugin author can choose where a `kv`/`list`/`status` view appears and pick one of three host-owned looks for two built-in widgets. Anything else (render a message differently, add a composer button, intercept a prompt, add an API route, ship a theme, change how sessions sort) means editing `AppShell.tsx`, `MessageView.tsx`, `rpc-manager.ts` or another fork file.

**Vision.** *Nothing in pi-web is special.* The chat window, sidebar, message renderer, file viewer, settings and session list are first-party plugins registered through the same API a user plugin uses. A user plugin changes any of them by registering a higher-priority contribution at the same extension point. Non-UI behavior (prompt handling, session lifecycle, API routes, storage, background jobs) is pluggable the same way. Plugins have an explicit lifecycle so they can be installed, enabled, reloaded, disabled and removed live, and a broken plugin can never take the app down.

And it has to be **fun to develop**: one file, typed, hot-reloaded in under a second, with a visible inspector that shows what every plugin touched.

## 2. Audit summary

Findings from the audit of the pluggable-ui implementation that this PRD must close:

| # | Finding | Evidence |
| --- | --- | --- |
| F1 | Plugins supply data, not rendering; `replace`/`wrap` only choose `default`/`compact`/`card` | `components/plugins/UiComponent.tsx` `strategy()`; `lib/web-plugins/view.ts` has 3 view types |
| F2 | Only 2 of 6 component keys target a real built-in | `ui.working-indicator.v1`, `ui.extension-status.v1` are the only host-mounted `UiComponent`s |
| F3 | Most of pi-web has no extension point (messages, tool results, composer, rows, settings, file viewer, terminal, shortcuts, routes) | no `PluginAnchor`/`UiComponent` in those files |
| F4 | Anchors are additive siblings only; no insert-between or wrap-subtree | `PluginLayout.tsx` |
| F5 | No browser→plugin events, parameterless actions, no plugin API routes, no read access to chat/tool events | `lib/web-plugins/actions.ts` |
| F6 | Standard `ctx.ui` APIs are no-ops in web: `setHeader`, `setFooter`, `setEditorComponent`, `addAutocompleteProvider`, `onTerminalInput`, `setHiddenThinkingLabel`, `getAllThemes`, `getTheme`; `setTheme` errors | `vendor/pi-web/lib/rpc-manager.ts` ~2299-2386 |
| F7 | No theme/token contribution | hard-coded `[data-theme]` blocks in `app/globals.css` |
| F8 | Plugin source is closed: one hard-coded path, loaded once at import, descriptor `extension` must be a file in this repo | `web-plugins-host.ts:40-53`, `descriptor.ts` |
| F9 | Every new extension point requires a fork edit; contracts are duplicated as vendored copies | `VENDORED.md`, `lib/web-ui-*.ts` |
| F10 | `userChoice` override input is never wired; nothing publishes `ui.layout.changed` | grep |
| F11 | No lifecycle: no enable/disable, no deactivate, no dependency order, no reload, no quarantine | n/a |

## 3. Goals

- **G1. UI is fully customizable.** Any visible region or component of pi-web can be replaced, wrapped, decorated, hidden, extended or re-themed by a plugin, with a built-in fallback.
- **G2. Logic is fully customizable.** Non-UI behavior (session lifecycle, prompt/message pipeline, API routes, storage, jobs, session listing/sorting, notifications) is reachable through typed hooks and replaceable services.
- **G3. Dogfooding.** Every built-in feature is a first-party plugin using only the public SDK. If a first-party plugin needs a private API, the SDK is wrong; the fix is to extend the SDK.
- **G4. Real lifecycle.** Discover → validate → resolve → enable → load → activate → deactivate → dispose, with dependencies, activation events, live reload, and quarantine on failure.
- **G5. Small fork.** The kernel is the only part of `vendor/pi-web` that knows about plugins. Adding a new extension point must not require touching upstream files.
- **G6. Fun to develop.** Scaffold, typed SDK, hot reload, inspector, test harness and examples. A useful plugin is ≤ 30 lines.
- **G7. Safe by default.** Capabilities are declared and granted. A failing, slow or malicious plugin is contained, diagnosable and removable. A **safe mode** boots with only first-party plugins.
- **G8. pi compatibility.** CLI extensions keep working unchanged. Plugins never require a pi-web-only `ctx.ui.*` option; standard `ctx.ui` calls from F6 gain real web behavior.

## 4. Non-goals

- Changing what pi itself does (system prompt, tool semantics, compaction, session file format). Plugins may *observe and transform at the pi-web boundary*; they do not patch pi internals.
- Plugin marketplace, ratings, remote auto-install, or auto-update. Installation is local and explicit.
- Hosting multiple users with per-user plugin sets. pi-web stays single-operator.
- Pixel-parity between TUI and web.
- Overriding authentication, transport, signed-session handling or the destructive-action confirmation component (kept from the earlier PRD R4). Those are *observable* but not *replaceable*; see [§7.3](#73-protected-core).

## 5. Architecture

```text
 plugin sources                      kernel (vendor/pi-web, small)                    plugins
 ──────────────                      ─────────────────────────────                    ───────
 repo web-plugins/        ┌──────────────────────────────────────────────┐
 ~/.pi/agent/web-plugins/ │ discovery → manifest validation → resolver   │   core.chat       (first-party)
 <proj>/.pi/web-plugins/  │ lifecycle manager (state machine, budgets)   │   core.sidebar    (first-party)
 pi packages (pi.webPlugins)│ capability gate + audit log                │   core.messages   (first-party)
                          │ registries: slots · components · services ·  │   core.files …    (first-party)
                          │   hooks · routes · commands · keys · themes  │   acme.zen-chat   (user)
                          │ event bus (existing WebUiStore, generalized) │   bubbly-spinner  (user/first-party)
                          │ transport: one snapshot + SSE, auth, loopback│
                          └──────────────┬─────────────────┬─────────────┘
                                server half (Node)     browser half (ESM / sandbox)
```

### 5.1 One plugin, two halves

A plugin is a directory (or a pi package) with a manifest and up to two entry points.

- **Server half**: runs in the pi-web Node process. Registers hooks, services, routes, jobs, storage, server-side contributions. Replaces today's descriptor + `publishWebView` plumbing.
- **Browser half**: an ES module loaded by the kernel in the page. Registers slot contributions, component replacements, commands, keybindings, themes, i18n. Replaces today's `WebPluginUiContribution` + host-owned strategies.
- A plugin may ship only one half. A declarative-only plugin (no code) remains valid (descriptor `ui` array) and is compiled into the same registries by a built-in adapter, so every existing descriptor keeps working.

### 5.2 Kernel responsibilities (and nothing else)

1. Discover, validate, resolve and run the plugin lifecycle ([§6](#6-plugin-lifecycle)).
2. Own the registries and the resolution rules ([§5.5](#55-resolution-rules)).
3. Own the event bus, snapshot, SSE and authentication (existing `WebUiStore`, `useWebUiState`, proxy).
4. Enforce capabilities, budgets and the audit log.
5. Provide the root `<PluginRoot>` that mounts first-party plugin output. Upstream components are wrapped, not rewritten ([§9](#9-fork-and-upstream-strategy)).

Everything else (rendering a chat, listing sessions) lives in plugins.

### 5.3 Manifest

`pi-web-plugin.json`, or `package.json#pi.webPlugin` for a pi package that is both a CLI extension and a web plugin.

```jsonc
{
  "$schema": "https://…/pi-web-plugin.schema.json",
  "id": "acme.zen-chat",                  // ^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$
  "name": "Zen chat",
  "version": "1.2.0",
  "engines": { "piWeb": "^1.0.0", "sdk": "^1.0.0" },
  "main": { "server": "./server.ts", "browser": "./browser.tsx" },
  "trust": "trusted",                     // "declarative" | "sandboxed" | "trusted"
  "capabilities": ["ui.slots", "ui.replace:chat.message.*", "session.hooks", "storage", "routes"],
  "dependsOn": { "core.messages": "^1.0.0" },
  "optionalDependsOn": { "acme.metrics": "^1.0.0" },
  "activation": ["onStartup"],            // see §6.3
  "settings": { /* JSON schema, rendered in Settings automatically */ },
  "contributes": { /* optional declarative contributions, see §5.4 */ }
}
```

### 5.4 Extension-point catalog

Every extension point has: a stable dotted **id** (`chat.message.assistant`), a **kind**, a typed **props/payload schema**, a **version**, a built-in default, and a **stability** tag (`stable` | `experimental`). Ids are the public API; the registry rejects unknown ids unless a plugin *defines* the point ([§5.4.3](#543-plugins-defining-extension-points)).

#### 5.4.1 UI extension points (browser half)

| Kind | What a plugin can do | Examples of ids |
| --- | --- | --- |
| **slot** | Add a component into a named, ordered region (children of the slot's host). Supports `before`/`after` an existing contribution id, so insert-between works. | `app.header`, `session.header`, `session.sidebar.row.actions`, `chat.before`, `chat.composer.toolbar`, `chat.composer.above`, `file-panel.header`, `settings.sections` |
| **component** | Replace, wrap or decorate a *built-in component by key*. A replacement receives the validated props and a `Default` component to render the original. | `chat.message.user`, `chat.message.assistant`, `chat.tool.<name>`, `chat.tool.result.<name>`, `chat.working`, `chat.input`, `sidebar.session-row`, `file.viewer.<mime>`, `settings.panel.<id>` |
| **page / route** | Own a route under `/p/<plugin-id>/…` and optionally a nav entry. | `/p/acme.zen-chat/stats` |
| **command** | Add a command to the palette and optionally a slash command, with a handler in the browser or server half. | `acme.zen-chat.toggle` |
| **keybinding** | Bind or rebind shortcuts, with conflict detection against the core map. | `mod+k`, `g s` |
| **theme / tokens** | Define a theme (a validated set of design tokens: colors, radii, spacing, fonts, shadows) or override tokens of any theme. Plugins never inject raw CSS in `declarative`/`sandboxed` trust; `trusted` may add a stylesheet. | `theme.acme-zen`, `tokens.accent` |
| **i18n** | Add a locale or override message keys. | `en`, `id` |
| **icon / asset** | Provide icons and static assets served from a namespaced path. | `icon.session` |
| **message renderer** | Render custom message types or tool results as rich UI (also covers pi's `registerMessageRenderer` for web). | `chat.message.custom.<type>` |

Rules: a `component` contribution **must** provide a fallback behavior (render `Default`, or `null` when `hide`). `slot` contributions never receive control of their host's layout, only their own box.

#### 5.4.2 Logic extension points (server half, plus browser services)

| Kind | Semantics | Examples |
| --- | --- | --- |
| **event** (observe) | Fire-and-forget, async, cannot affect the result. | `session.created`, `session.settled`, `message.appended`, `tool.finished`, `plugin.enabled` |
| **waterfall** (transform) | Each handler receives the previous value and returns a new one; ordered by priority. | `prompt.before-send`, `message.before-render-model`, `session.list.sort`, `session.title.generate`, `attachment.before-upload` |
| **bail** (veto) | First handler to return `{ deny: reason }` stops the action; reason is surfaced to the user. Core-protected actions cannot be vetoed by an un-granted plugin. | `session.before-delete`, `prompt.before-send`, `file.before-read` |
| **service** (replace) | A named, typed implementation other code resolves through the registry. A plugin may *provide*, *decorate* or *replace* it (highest priority wins; decorators chain). | `service:session.search`, `service:model.pick`, `service:notifier`, `service:title-generator` |
| **route** | Server HTTP routes under `/api/p/<plugin-id>/…`, authenticated by the existing signed session, validated by a schema, rate-limited. | `GET /api/p/acme.metrics/summary` |
| **job** | Scheduled or event-triggered background task with a budget and cancellation. | `every 5m`, `on session.settled` |
| **storage** | Scoped key-value (global / project / session) with quota, plus change events. | `ctx.storage.project.get("layout")` |
| **bridge** | Typed browser↔server messaging channel owned by the plugin (replaces parameterless actions). | `ctx.bridge.call("approve", {id})` |
| **pi-event tap** | Read-only subscription to the session's pi event stream (messages, tool calls, usage) projected into validated, size-bounded events. | `tap("tool_execution_end")` |

Browser-side `service`, `waterfall` and `event` kinds exist too (for example `service:chat.scroll-policy`, `waterfall:message.copy-text`), so UI behavior is as pluggable as UI markup.

#### 5.4.3 Plugins defining extension points

A plugin can declare **its own** slots, components, hooks and services (namespaced by plugin id, schema + version required). Other plugins extend those. This is how plugin ecosystems compose (`acme.metrics` exposes `acme.metrics.card` slot; `acme.zen-chat` fills it). The registry validates schemas at registration and at call time.

### 5.5 Resolution rules

Deterministic, testable, and shown in the inspector.

1. **Per point, candidates** = all active contributions that target it and pass `visibleWhen`/scope/capability checks.
2. **Order**: user choice from Settings → higher `priority` → plugin dependency order (dependents after dependencies) → lexical `pluginId/contributionId`.
3. **component**: at most one active *replacement* (highest rank); all *wrappers* compose outside-in by rank; `Default` is the next layer inward. `hide` is a replacement with `null` output.
4. **slot**: all contributions render, ordered by `order`, then `before`/`after` constraints (cycles are rejected at registration).
5. **waterfall / event / bail**: run by priority; every handler has a timeout (default 250 ms server, 16 ms render budget for sync UI work); a timeout or throw is isolated and counted toward the circuit breaker; the chain continues with the previous value.
6. **service**: replace (highest rank) → decorators chain → provider. Two *exclusive replacements* with equal rank are a registration conflict that disables the later one with a named diagnostic.
7. **Failure**: a contribution that throws, times out or violates its schema is disabled for the affected scope, the next candidate (ultimately the built-in) renders, and a diagnostic is recorded ([§6.5](#65-health-circuit-breaker-and-safe-mode)).

### 5.6 SDK (the fun part)

One package, `@pi-workflow/web-plugin-sdk`, importable from both halves. Everything is typed from the catalog, and `definePlugin` infers contribution props from the extension-point id.

```ts
// server.ts: logic
import { definePlugin } from "@pi-workflow/web-plugin-sdk";

export default definePlugin({
  setup(ctx) {                                   // sync, declarative registration
    ctx.hooks.waterfall("prompt.before-send", async (prompt, { session }) =>
      session.project.endsWith("/docs") ? `${prompt}\n\nAnswer in plain language.` : prompt);

    ctx.hooks.bail("session.before-delete", ({ session }) =>
      session.pinned ? { deny: "Pinned sessions can't be deleted." } : undefined);

    ctx.services.decorate("session.list.sort", (next) => (rows) =>
      next(rows).sort((a, b) => Number(b.pinned) - Number(a.pinned)));

    ctx.routes.get("/summary", async ({ session }) => ({ turns: await ctx.storage.session.get("turns") ?? 0 }));
  },
  async activate(ctx) {                          // async, may start timers/IO; everything returned via ctx.* is auto-disposed
    ctx.jobs.on("session.settled", async ({ session }) => ctx.storage.session.update("turns", (n = 0) => n + 1));
  },
});
```

```tsx
// browser.tsx: UI
import { defineBrowserPlugin } from "@pi-workflow/web-plugin-sdk/browser";

export default defineBrowserPlugin((ctx) => {
  // Replace how assistant messages look, keep everything else.
  ctx.components.wrap("chat.message.assistant", ({ message, Default }) => (
    <div className="zen-bubble"><Default message={message} /></div>
  ));

  // Add a button to the composer toolbar, right after "attach".
  ctx.slots.add("chat.composer.toolbar", { after: "core.chat/attach" }, () => (
    <ctx.ui.Button onClick={() => ctx.bridge.call("summarize")}>Summarize</ctx.ui.Button>
  ));

  ctx.theme.define("zen", { accent: "#7aa2f7", radius: "14px", fontSans: "Inter" });
  ctx.keys.bind("mod+shift+z", "acme.zen-chat.toggle");
  ctx.commands.register("acme.zen-chat.toggle", { title: "Toggle zen mode" }, () => ctx.storage.global.toggle("zen"));
});
```

SDK conveniences: `ctx.ui` is a themed component kit (Button, Card, Table, Markdown, Badge, Stack, Input, Tabs, Dialog, Toast) so plugins match the host and work in sandbox mode; `ctx.log` writes to the inspector; `ctx.settings` is the typed, schema-validated user config; `ctx.signal` aborts on deactivate; `ctx.disposable(fn)` registers cleanup.

### 5.7 Declarative path stays first-class

The existing descriptor (`WEB_PLUGINS` array, `publishWebView`, `ctx.ui.setWorkingMessage`, Bubbly) is compiled into the new registries by `core.compat` (a first-party plugin), so existing plugins keep working untouched and are migrated at leisure. `ctx.ui.setStatus/setWidget/setTitle/setWorkingIndicator` keep their pi semantics and gain real components behind them. The F6 no-ops (`setHeader`, `setFooter`, `setEditorComponent`, `addAutocompleteProvider`, `getAllThemes`, `getTheme`, `setTheme`, `setHiddenThinkingLabel`, `onTerminalInput`) are wired to extension points (`app.header.custom`, `chat.footer`, `chat.input`, `composer.autocomplete`, `theme.*`, `chat.thinking.label`, `terminal.input`) so CLI extensions gain web behavior with no change.

## 6. Plugin lifecycle

### 6.1 States

```text
 discovered ─▶ validated ─▶ resolved ─▶ enabled ─▶ loaded ─▶ activating ─▶ active
     │            │            │          ▲  │         │          │          │
     ▼            ▼            ▼          │  ▼         ▼          ▼          ▼
  ignored      rejected     unresolved   disabled   failed     failed   deactivating ─▶ disposed
                                                       └──────────────▶ quarantined (circuit breaker)
```

| State | Meaning | Exit |
| --- | --- | --- |
| `discovered` | Found at a root; manifest read, nothing executed. | validate |
| `validated` | Manifest schema, id, version, `engines`, capability list, contribution schemas valid. | resolve, or `rejected` with named errors |
| `resolved` | Dependencies satisfied and ordered (topological, cycle = `unresolved`). | enable |
| `enabled` | User/config has it on. Persisted in `~/.pi/agent/web-plugins.json`. | load, or `disabled` |
| `loaded` | Entry modules imported (server in a guarded module scope; browser by the kernel loader). No side effects beyond module evaluation. | activate |
| `activating` / `active` | `setup` ran (sync registration), then `activate` ran (async) within its budget; contributions are live. | deactivate, fail |
| `deactivating` | Reverse of activation: contributions unregistered first, then `deactivate`/disposables run in LIFO order within budget. | `disposed` |
| `disposed` | No registered contribution, timer, listener, route, job or storage handle remains. Verified by a leak check. | re-enable → `loaded` |
| `failed` | `setup`/`activate` threw or timed out; contributions from this run are rolled back. | retry with backoff, or `quarantined` |
| `quarantined` | Circuit breaker tripped (N failures in window); stays off until the user clears it or the plugin version changes. | user action |

### 6.2 Lifecycle hooks (plugin-facing)

| Hook | When | Contract |
| --- | --- | --- |
| `setup(ctx)` | After load, before activate | **Synchronous**, registers declarative contributions only. Throws roll back everything registered so far. |
| `activate(ctx)` | After setup, honoring activation events | May be async; budget default 5 s. May start jobs/timers through `ctx` (auto-disposed). |
| `onConfigChange(next, prev)` | Settings changed | Apply live, or call `ctx.requestReload()`. |
| `onSessionStart(session)` / `onSessionEnd(session)` | A hosted session starts / ends | Per-session state is created and disposed with the session; no cross-session leakage. |
| `onDependencyChange(dep, state)` | A dependency was enabled/disabled/reloaded | Re-resolve services or degrade; required dependency loss triggers deactivation. |
| `deactivate(ctx)` | Disable, reload, shutdown | Best-effort flush within budget (default 2 s); the kernel unregisters anyway after the budget. |

### 6.3 Activation events (lazy loading)

`activation` lists events that cause load+activate, so idle plugins cost nothing:

`onStartup` · `onSession` · `onSessionKind:<kind>` · `onRoute:<path>` · `onSlotVisible:<slot-id>` · `onComponentUsed:<component-id>` · `onCommand:<id>` · `onHook:<hook-id>` · `onEvent:<event-id>` · `onSetting:<id>`.

A contribution that targets a lazily-activated plugin (e.g. a slot) is registered as a *stub* from the manifest `contributes` block so the host knows where to wake it; the real implementation swaps in after activation, with the built-in/placeholder rendering until then.

### 6.4 Live operations

- **Enable / disable** without restart. Disable runs deactivation, unregisters, and the built-in output returns in the same frame.
- **Reload** (`pi-web plugin reload <id>` and file-watch in dev): deactivate → re-import with a cache-busting version → activate; if the new version fails, **roll back to the last working version** and report why.
- **Install / uninstall**: copy or link a directory or pi package into a root; uninstall requires `disposed` and deletes only that plugin's storage if the user confirms.
- **Server↔browser version skew**: browser half carries the plugin version and a content hash; a mismatch makes the kernel reload the browser half before it can send bridge messages.
- **Ordering guarantees**: dependency order on activate, reverse on deactivate; events delivered after activation only; no hook runs for a plugin that is not `active`.

### 6.5 Health, circuit breaker and safe mode

- Every hook, render and route handler runs under a **budget** (time, output size, call rate) and an **error boundary**.
- A per-plugin **circuit breaker** counts failures (render errors, hook throws/timeouts, rejected events); trip → `quarantined`, built-ins return, a toast and an inspector entry explain why, and the plugin never runs unattended again until cleared.
- **Safe mode**: `PI_WEB_SAFE_MODE=1`, `?safe=1`, or automatically after 2 crashes within one minute of start. Only `core.*` first-party plugins load; the Settings plugin manager remains reachable to fix the problem.
- **Boot crash loop guard**: a plugin that was `activating` when the process died is marked `failed` on next boot.

### 6.6 Dependency and compatibility rules

- Semver ranges for `dependsOn` and `engines.piWeb`/`engines.sdk`; incompatible → `unresolved` with a message naming the pair.
- Extension-point ids are versioned (`chat.message.assistant@1`). A major bump keeps the old id served by a compatibility adapter for one SDK major, then rejects with a diagnostic. No silent stale props.
- Duplicate plugin ids across roots: precedence **project > user > package > repo**, losers listed in diagnostics.

## 7. Trust and security

This PRD deliberately lifts the earlier "no arbitrary browser JS" rule, because "everything changeable" is impossible without it. The risk is real: a browser script in the pi-web origin carries the operator's authenticated session, and pi-web can run an agent that runs shell commands. **Browser-side trusted code is therefore equivalent to local code execution** and is treated that way.

### 7.1 Trust tiers

| Tier | Code | Capabilities | Default for |
| --- | --- | --- | --- |
| `declarative` | none; JSON only | descriptor, views, tokens, declarative contributions | anything unverified |
| `sandboxed` | browser half in a sandboxed iframe (`allow-scripts` only, unique origin) or worker; server half unavailable | render via `ctx.ui` kit, `ctx.bridge` to its own server half *if separately trusted*, read-only snapshot slices it was granted | third-party UI |
| `trusted` | full ES module in the page; server half in-process | everything granted in the manifest | first-party and plugins the operator explicitly enabled |

The kernel never upgrades a tier. Enabling a `trusted` plugin from outside the repo requires an explicit confirmation showing id, version, source path, content hash and requested capabilities, and records the grant in `web-plugins.json` and the audit log. A changed content hash revokes the grant until reconfirmed.

### 7.2 Capabilities

Manifest-declared, user-granted, enforced at every registry call and every bridge/route/storage call, audited.

`ui.slots[:id]` · `ui.replace:<id-glob>` · `ui.theme` · `ui.css` (trusted only) · `ui.route` · `commands` · `keys` · `hooks.observe:<id>` · `hooks.transform:<id>` · `hooks.veto:<id>` · `services.provide:<id>` · `services.replace:<id>` · `routes` · `storage[:scope]` · `jobs` · `tap.pi-events[:type]` · `session.read` · `session.write` · `fs.read:<root>` · `net:<host>` · `exec` (never auto-grantable; requires per-run confirmation).

Wildcard grants are visible in the confirmation and in diagnostics. A call outside the grant throws `CapabilityError` naming plugin and capability, and is logged.

### 7.3 Protected core

Kept non-replaceable and non-vetoable by any plugin: signed-session authentication and proxy, loopback binding, SSE transport integrity, the capability gate and audit log itself, the plugin manager and safe-mode entry, and destructive-action confirmation dialogs (plugins may *observe* and *add* confirmations, never skip them). Protected points are listed in the catalog with `protected: true`; registration against them fails with a named error.

### 7.4 Other controls

- Server routes inherit authentication, CSRF protection and a body-size limit; schemas are required.
- Event/model payloads keep today's validation: size, rate, depth, ANSI/HTML stripping, `__proto__` guards. Plugin-produced text is still rendered as text in `declarative`/`sandboxed` tiers.
- Sandboxed iframes get a strict CSP, no same-origin access, message-passing only, size-bounded structured-clone messages.
- Audit log (append-only, bounded) records enable/disable/grant/revoke, capability denials, quarantines, and every veto.
- Plugin storage is namespaced by plugin id and quota-limited.

## 8. Developer experience

**D1. Scaffold.** `pi-web plugin new <id> [--ui|--logic|--both]` generates a manifest, typed entries, a test, and a README. Templates: `working-indicator`, `message-renderer`, `composer-button`, `theme`, `prompt-middleware`, `api-route`, `dashboard-card`.

**D2. Dev loop.** `pi-web plugin dev <dir>` links the plugin, enables it, and watches files. Server half reloads in-process and the browser half hot-swaps with state preserved where the plugin opts in. Target: save → visible in < 1 s. A reload failure keeps the last good version and prints the error with source mapping.

**D3. Inspector.** Extending the `/plugins` diagnostics page, plus an in-page overlay (toggle `mod+alt+i`) that outlines every slot and replaceable component with its id, shows which plugin owns what, the resolution order, budgets/latency per contribution, and a **"disable this plugin"** button. Clicking any region shows "how do I change this?" with the extension-point id and a copy-paste snippet. This is the discoverability answer to "what can I change?".

**D4. Typed catalog.** `pi-web plugin catalog` and generated docs list every extension point with props, stability, and example. Autocomplete of ids and props comes from the SDK types.

**D5. Test harness.** `createTestHost({ plugins })` boots the kernel without Next.js: assert registrations, run hooks, render components in jsdom, simulate lifecycle (enable, fail, reload), and snapshot resolution order.

**D6. Validation.** `pi-web plugin check <dir>` validates the manifest, capabilities vs. usage (static scan for undeclared `ctx.*` use), and extension-point ids, with fix-it messages.

**D7. Packaging.** `pi-web plugin pack` produces a directory/tarball with a content hash for the trust prompt. A pi package can list `"pi": { "webPlugins": ["./web"] }` so one repository ships a CLI extension and its web half.

**D8. Examples worth keeping.** A maintained examples directory: Bubbly Spinner (reference, now using the public SDK), a "zen chat" skin, a prompt-guard (bail), a project-aware title generator (service), a metrics card using a plugin-defined slot, and a Pomodoro command.

**D9. Docs.** One "your first plugin in 5 minutes" tutorial and the full catalog; the earlier author example in `docs/pi-web.md` is replaced by links.

## 9. Fork and upstream strategy

- Upstream `CONTRIBUTING.md` declines plugin systems, custom themes and pi-web-only APIs. This work therefore stays a **fork**. The goal is to make resync cheap, not to upstream.
- **Wrap, don't rewrite.** Each upstream component (`ChatWindow`, `MessageView`, `ChatInput`, `SessionSidebar`, `FileViewer`, …) is registered as a first-party plugin's *default* component through a thin adapter file under `components/plugins/core/`. In the upstream file the fork diff is one wrapper per component (`<PluginComponent id="chat.message.assistant" props={…} Default={AssistantMessage} />`), enforced by a size budget test on the fork diff.
- **Mount points are data.** The slot tree lives in the kernel's `<PluginRoot>`; adding a slot never touches upstream files.
- **Service seams on the server.** `rpc-manager.ts` gets named hook invocations (`hooks.waterfall("prompt.before-send", …)`) at the same call sites the audit identified, not forked logic.
- Contracts live **once**, in `lib/web-plugins/`, and are consumed by the vendored tree through a build-time copy (generated, git-ignored) or workspace alias rather than hand-maintained duplicates, retiring the parity-test workaround (F9). If the bundler can't resolve outside the tree, a generated copy with a staleness check replaces the manual one.
- `VENDORED.md` lists the kernel files only; first-party plugin adapters are listed as one group.

## 10. Requirements

### 10.1 Kernel and registries

- **R1.** A single plugin API ([§5](#5-architecture)) is the only way built-in and external code extends pi-web; no host code branches on a plugin id (extends the existing AC3 test to all plugins).
- **R2.** Registries exist for slots, components, services, hooks (event/waterfall/bail), routes, commands, keybindings, themes/tokens, i18n, jobs, storage, bridge, tap. Each registration is attributed to a plugin and removable as a group.
- **R3.** Resolution follows [§5.5](#55-resolution-rules) and is exposed read-only to the inspector.
- **R4.** Every extension point has an id, version, schema and stability tag; unknown ids and capability violations fail with errors naming plugin and point.
- **R5.** Plugins may define their own extension points; ids are namespaced and schema-validated.

### 10.2 UI

- **R6.** Slots exist for every region listed in [§5.4.1](#541-ui-extension-points-browser-half); insert `before`/`after` works.
- **R7.** Component keys exist for message, tool call, tool result, working indicator, composer, session row, sidebar sections, file viewer, settings panels, header/footer, each with a `Default` render and fallback on failure.
- **R8.** Plugins can ship pages, commands, keybindings, themes/tokens and locales; conflicts are detected and reported.
- **R9.** The F6 `ctx.ui` no-ops gain web behavior through the extension points above.
- **R10.** `ctx.ui` component kit exists and is themed by the active theme, in all trust tiers.

### 10.3 Logic

- **R11.** Server hooks cover the pipeline points in [§5.4.2](#542-logic-extension-points-server-half-plus-browser-services), invoked from named call sites with timeouts and isolation.
- **R12.** Services can be provided, decorated and replaced; core features resolve through services so they are replaceable.
- **R13.** Plugin routes, bridge, storage (global/project/session) and jobs exist with quotas, authentication and schema validation.
- **R14.** `pi-event tap` exposes a validated, bounded, read-only projection of session events to plugins with the `tap.pi-events` capability.
- **R15.** Parameterized, confirmed actions (the existing `actions` field) are re-expressed as bridge calls with a declared schema; the dashboard action keeps working.

### 10.4 Lifecycle

- **R16.** The state machine of [§6.1](#61-states) is implemented as one module with exhaustive transition tests.
- **R17.** `setup`/`activate`/`deactivate`/`onConfigChange`/`onSessionStart`/`onSessionEnd`/`onDependencyChange` behave per [§6.2](#62-lifecycle-hooks-plugin-facing); disposables are auto-collected from every `ctx.*` registration.
- **R18.** Activation events, lazy stubs, dependency ordering, live enable/disable/reload with rollback, and version-skew handling work per [§6.3–6.6](#63-activation-events-lazy-loading).
- **R19.** Circuit breaker, quarantine, safe mode and the crash-loop guard work and are visible in the UI.
- **R20.** Plugin discovery covers repo `web-plugins/`, `~/.pi/agent/web-plugins/`, `<project>/.pi/web-plugins/` and pi packages' `pi.webPlugins`, with the precedence in [§6.6](#66-dependency-and-compatibility-rules). Enable/disable and settings persist in `~/.pi/agent/web-plugins.json`.
- **R21.** A **Plugin manager** (itself a protected first-party plugin) lists plugins with state, version, source, capabilities, health, settings and enable/disable/reload/quarantine-clear actions.

### 10.5 Security

- **R22.** Trust tiers and capabilities per [§7](#7-trust-and-security); a `trusted` plugin from outside the repo requires explicit, hash-bound operator confirmation.
- **R23.** Protected points ([§7.3](#73-protected-core)) cannot be replaced or vetoed; this is enforced by the registry and tested.
- **R24.** The audit log records grants, denials, quarantines, vetoes and lifecycle transitions.

### 10.6 Developer experience

- **R25.** CLI `new`, `dev`, `check`, `pack`, `catalog`, `reload`, `enable`, `disable`, `list` ([§8](#8-developer-experience)).
- **R26.** Typed SDK with inferred props, test harness, inspector overlay, generated catalog docs, and the example plugins in D8.

## 11. Migration plan

Each phase leaves the app working and all existing tests green.

| Phase | Deliverable | Done when |
| --- | --- | --- |
| 0 | **Spec + contracts.** Manifest schema, extension-point catalog (ids, schemas, stability), capability list, state machine, SDK types. Single source of contracts with generated vendored copy. | Contracts compile; parity/staleness test replaces hand copies; catalog doc generated. |
| 1 | **Lifecycle manager + registries (server).** Discovery from all roots, validation, resolver, state machine, budgets, circuit breaker, safe mode, audit log, `web-plugins.json`. `core.compat` ingests today's `WEB_PLUGINS`. | AC1, AC4, AC9, AC10, AC12; the six existing plugins run through the manager unchanged. |
| 2 | **Logic extension points.** Hook invocation sites in `rpc-manager.ts` and session routes; services; routes; storage; jobs; bridge; pi-event tap. | AC5, AC6, AC11 for server hooks; `ctx.ui` no-ops from F6 still pending. |
| 3 | **Browser runtime.** Loader (trusted ESM first), `<PluginRoot>`, slot and component registries, error boundaries, render budgets, `ctx.ui` kit, theme/token engine, commands, keys, i18n, routes. Server↔browser skew handling. | AC2, AC3, AC7, AC8. |
| 4 | **Dogfood the core.** Wrap upstream components as first-party plugins (`core.chat`, `core.messages`, `core.sidebar`, `core.composer`, `core.files`, `core.settings`, `core.terminal`) with the one-line wrapper per component; wire F6 `ctx.ui` no-ops. | Upstream suite green; fork-diff budget test passes; AC13. |
| 5 | **Sandboxed tier.** Iframe/worker host, structured-clone bridge, CSP, capability proxy. | AC14. |
| 6 | **DX.** SDK package, scaffold/dev/check/pack/catalog CLI, inspector overlay, plugin manager UI, test harness, examples, tutorial. | AC15, AC16. |
| 7 | **Migrate the six plugins** to the SDK (Bubbly as the reference), retire `strategy`-only overrides and parameterless actions, delete obsolete host paths. | AC17; no host reference to plugin ids; docs updated. |

## 12. Acceptance criteria

Each is verifiable by a test or a scripted e2e; none relies on reading code.

- **AC1 (lifecycle order).** A test plugin with `dependsOn` records `setup`, `activate`, `deactivate`, `dispose` calls; order is dependency-first on activate and reversed on deactivate. A cycle yields `unresolved` naming the cycle.
- **AC2 (replace a built-in with no fork edit).** A fixture plugin, added only under `web-plugins/`, replaces `chat.message.assistant`, wraps `chat.tool.bash`, adds a `chat.composer.toolbar` button after `core.chat/attach`, and defines a theme; Playwright sees all four in a live session with no change under `vendor/pi-web/`.
- **AC3 (fallback).** Disabling that plugin, or making its component throw, returns the built-in rendering in the same frame without page reload; the throw trips the circuit breaker and lists a diagnostic.
- **AC4 (quarantine).** A plugin that throws in `activate` three times within the window becomes `quarantined`; other plugins and core stay up; clearing quarantine in the manager re-enables it.
- **AC5 (logic hooks).** A fixture plugin transforms `prompt.before-send`, vetoes `session.before-delete` for pinned sessions with a user-visible reason, and decorates `session.list.sort`; each is observed end-to-end through the real routes.
- **AC6 (routes, storage, bridge).** The fixture serves `GET /api/p/<id>/summary` (authenticated, schema-validated, rate-limited), reads/writes project and session storage, and answers a browser `bridge.call` with a typed response; an unauthenticated or malformed call is rejected.
- **AC7 (live reload).** Editing a fixture's browser file in `plugin dev` updates the page in < 1 s without a full reload; introducing a syntax error keeps the last good version and reports the error.
- **AC8 (insert-between and conflict).** `before`/`after` ordering places a slot contribution between two others; a cycle or an exclusive-replacement conflict is rejected at registration with a named diagnostic.
- **AC9 (capabilities).** A plugin calling an ungranted API receives `CapabilityError` naming plugin and capability, and the denial appears in the audit log. A wildcard grant is shown in the confirmation.
- **AC10 (protected core).** Registering against a `protected` point fails; auth, transport, plugin manager and destructive confirmations cannot be replaced or skipped by a plugin.
- **AC11 (no leaks).** After `disabled` or `disposed`, a leak check finds zero registrations, listeners, timers, routes, jobs and open storage handles for the plugin, across 50 enable/disable cycles.
- **AC12 (safe mode).** `PI_WEB_SAFE_MODE=1` and the crash-loop trigger boot with only `core.*`; the plugin manager is reachable and can re-enable a plugin.
- **AC13 (dogfooding).** Every first-party feature registers through the public SDK only; a lint/test fails if a first-party plugin imports a kernel-private module. The upstream pi-web suite and root `npm run tidy` stay green (only the two documented baseline clipping failures allowed). A size budget on the `vendor/pi-web` fork diff (excluding the kernel and `components/plugins/core/`) is enforced.
- **AC14 (sandbox).** A `sandboxed` plugin renders through `ctx.ui`, cannot read `document.cookie`, `localStorage` or the parent DOM, cannot call routes it was not granted, and its oversized/flooded messages are rejected.
- **AC15 (DX).** From an empty directory, `pi-web plugin new` then `plugin dev` yields a working working-indicator plugin in under 5 minutes by following the tutorial (checked by a scripted run); `plugin check` flags an undeclared capability use and an unknown extension-point id with fix-its.
- **AC16 (inspector).** The overlay lists every slot/component with owner and resolution order; its "disable this plugin" button works live.
- **AC17 (migration).** The six existing plugins run on the SDK; Bubbly has no `strategy`-only override; the dashboard action works through `bridge`; `grep` finds no plugin id in host code.
- **AC18 (compat).** A pre-existing CLI extension using `ctx.ui.setHeader`, `setFooter`, `setEditorComponent` or `addAutocompleteProvider` renders or behaves in the web without modification.
- **AC19 (skew).** A server/browser plugin version mismatch reloads the browser half before any bridge call is accepted; stale bridge calls are rejected.
- **AC20 (docs).** `docs/pi-web.md`, `VENDORED.md`, the generated catalog, the tutorial and the security model are updated and committed; working tree clean.

## 13. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Trusted browser code is local code execution | An enabled malicious plugin owns the machine | Hash-bound explicit grant, loopback only, tiers, audit log, `exec` never auto-granted, safe mode, clear docs. |
| Surface area becomes an unmaintainable API | Every upstream refactor breaks plugins | Stability tags, versioned ids, adapters for one SDK major, catalog generated from code, props schemas as the contract rather than component internals. |
| Fork drift from upstream | Resync becomes painful | Wrapper-only diffs, size budget test, kernel isolated, resync checklist in `VENDORED.md`. |
| Plugin performance on hot paths (render, streaming) | Janky chat | Render budgets, memoized resolution, lazy activation, coalescing, per-contribution latency in the inspector. |
| Hook chains hide behavior | Hard to debug | Resolution order and per-hook timing in the inspector, `ctx.log`, deterministic ordering. |
| Server/browser halves drift | Confusing failures | Version + hash handshake, skew reload, bridge schema validation. |
| Two exclusive replacers fight | Flaky UI | Registration conflict errors, user choice in Settings, explicit priority. |
| Over-building before value | Months without a user-visible win | Phases 1-3 already deliver server hooks and real UI replacement; Phase 4 dogfooding can proceed one component at a time. |

## 14. Open decisions

1. **Browser module format.** Native ESM served by pi-web (no build step, simplest for authors, works with `plugin dev`) versus requiring a bundle. *Recommendation:* ESM with optional esbuild transform for `.tsx`, done by the kernel in dev and by `plugin pack` in release.
2. **Component kit scope.** How much of pi-web's internal component set to expose as `ctx.ui`. *Recommendation:* start with the 10 listed primitives; grow by demand and keep them stable.
3. **React as a plugin dependency.** Share the host's React (singleton, small bundles, version coupling) versus allow a plugin's own. *Recommendation:* host-provided React and the SDK; a plugin that bundles its own is unsupported in `trusted` tier.
4. **Sandbox mechanism.** Iframe versus Worker + offscreen rendering. *Recommendation:* iframe with a structured-clone bridge; revisit if layout integration is too limiting.
5. **Persistence of user choices.** Per browser, per project or global. *Recommendation:* global `web-plugins.json` for enablement and grants, per-project overrides for layout/theme.
6. **Whether any pi-side API is needed.** *Recommendation:* none; keep extensions untouched, and expose plugin features through the web-only SDK, per upstream and repo conventions.
7. **Hook ordering across plugins.** Priority numbers versus `before`/`after` graph. *Recommendation:* numeric priority with optional `before`/`after` for slots only, to keep the model simple.

## 15. Definition of done

The PRD is implemented when AC1-AC20 pass, the six existing plugins run on the SDK, the first-party UI is registered through the public API with the fork diff within its budget, lifecycle, capability and safe-mode behavior are covered by tests, the inspector and plugin manager ship, docs are committed, the working tree is clean, and the root verification gate passes.
