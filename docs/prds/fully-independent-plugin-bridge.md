# Technical implementation plan: Fully independent bridge-backed web plugins

> Part of [pi-workflow-extensions](../../README.md). Plan for making plugin projects externally installable, protocol-only consumers with optional extension bridges.
>
> **Execution disclaimer.** The source of truth for the shipped bridge is [PRD: Pi Web Bridge Protocol](./pi-web-bridge-protocol.md); the earlier increment is recorded in [its implementation plan](./pi-web-bridge-protocol-implementation-plan.md). This document records the independent-plugin increment: all decision gates in §8 were resolved before code, and §12 records the committed implementation, including the completed first-party migration.

| Field | Value |
| --- | --- |
| **Status** | Implemented — Phases 0–6 complete; all first-party browser halves load from their own manifests |
| **Owner** | Faiz |
| **Builds on** | [bridge protocol PRD](./pi-web-bridge-protocol.md), [web plugin architecture](../web-plugin-architecture.md), [pi-web](../pi-web.md), [plugin platform PRD](./pi-web-plugin-platform.md) |
| **Gate** | `npm run tidy` green at every phase; browser-runtime e2e green when browser loading changes |
| **Target** | A plugin can be installed from an arbitrary trusted directory and depend only on a standalone bridge SDK |

- **What it is** — the next increment that turns “independent plugin project” from an in-repo convention into an externally installable runtime contract.
- **Why it exists** — current plugins are protected from core internals by import rules, but their browser halves are still wired through repository composition roots and the protocol catalog cannot yet carry plugin-specific messages.
- **How it is enforced** — a standalone SDK, manifest-declared bridge slices, manifest-driven browser-half loading, namespaced message validation, and a temp-directory e2e that forbids repository edits.
- **What it refuses** — plugins cannot import `web/core/*`, redefine core messages, replace protected core points, or run browser code without a trusted, hash-bound operator grant.
- **What it cannot do** — browser halves remain local code execution. A sandboxed/untrusted tier is out of scope.

---

## 1. Purpose

The shipped bridge solved **how** the web talks to Pi: one versioned envelope, generated catalog, capability checks, adapters, bindings, and a first-party client that consumes the same protocol a plugin can consume. It did not fully solve **where a plugin lives and how it is installed**.

The target is:

> A plugin project owns its browser half, optional Pi extension half, schemas, styles, tests and build. It declares the slice of the bridge it needs. It imports only the bridge SDK. Installing it requires no edit to `web/core/`, `web/app.tsx`, `web/plugins/`, or any other repository file.

Two bridge paths must work:

1. **Core slice** — the plugin consumes selected built-in protocol messages (`session.list`, `session.events`, `session.prompt`, and so on) through the SDK.
2. **Extension bridge** — the plugin ships a Pi extension that publishes plugin-owned messages through the same SDK; the plugin's browser half subscribes to them and sends actions back through the protocol.

These are complementary. A plugin that only reads core state needs no Pi extension. A plugin with behavior of its own ships both halves.

## 2. Current state

Everything in this section describes the code at the time this plan was written.

| Capability | Current state | Evidence |
| --- | --- | --- |
| Versioned protocol and bindings | Implemented: `pi-web-bridge` v1, 60 catalog messages, HTTP/SSE, in-process and session-attach bindings | `web/core/protocol/`, `docs/bridge-protocol-catalog.md` |
| Baseline core parity | Implemented and generated | `web/core/pi-api/`, `web/core/adapters/`, `docs/bridge-protocol-parity.md` |
| Extension-to-web bridge | Implemented for existing UI event catalog messages | `extensions/bridge.ts`, `web/core/protocol/publisher.ts` |
| Trusted browser runtime | Implemented: grants, hash checks, breaker, safe mode, protected-point refusal | `web/core/client/plugin-system/browser-*` |
| External discovery | Implemented for manifests, descriptors and server halves | `web/core/plugin-contracts/kernel/discovery.ts`, `web/core/server/plugin-host.ts` |
| External browser-half loading | Missing: `main.browser` is validated but the server loader reads only `main.server` | `web/core/plugin-contracts/kernel/manifest.ts`, `web/core/server/plugin-host.ts` |
| Static first-party wiring | Still present: browser halves and several pages are imported by composition roots | `web/app.tsx`, `web/plugins/browser-halves.ts`, `web/plugins/pages.tsx` |
| Standalone SDK | Missing: protocol code is under `web/core/protocol/` and merely allowlisted as a public import | `lib/plugin-project.ts`, `web/core/protocol/index.ts` |
| Plugin-specific messages | Missing: `publishBridgeMessage()` rejects any name absent from the frozen catalog | `web/core/protocol/publisher.ts`, `web/core/protocol/catalog.ts` |
| Message cherry-picking | Missing: plugins import the general client rather than declaring and granting a message slice | `web/core/client/protocol-client.ts` |

The practical consequence is that a plugin can be **architecturally independent** today, but a browser-UI plugin is not yet **installation independent**.

## 3. Target architecture

### 3.1 Independent project layout

Every new plugin project has this shape. Names are proposed and frozen in Phase 0.

```text
my-plugin/
├── package.json              # depends only on @pi-web/bridge (+ declared build deps)
├── pi-web-plugin.json        # manifest: browser, optional extension, bridge slice
├── browser/
│   └── index.ts              # export function mount(el, ctx): () => void
├── extension/
│   └── index.ts              # optional Pi extension half
├── schema/
│   ├── state.json            # plugin-owned message payload schemas
│   └── action.json
├── styles/
│   └── plugin.css
├── test/
└── build.mjs                 # produces a single browser bundle and extension entry
```

A plugin may omit `extension/`, `schema/`, or `styles/`. It may not add a file under `web/core/` or import one.

### 3.2 Dependency direction

```text
                         ┌─ core adapters ────────────────┐
Pi built-ins ────────────┤                                │
                         └─ extension bridge publisher ───┤
                                                          ▼
                                                   Bridge Protocol
                                                          │
                                                          ▼
                                          @pi-web/bridge SDK (public)
                                                          │
                                                          ▼
                                      plugin browser half / extension half
```

`web/core/protocol/` becomes a thin re-export of the standalone SDK. Core and plugins therefore compile against one implementation, but only the SDK is installable by a plugin.

### 3.3 Component responsibilities

| Component | Owns | Must not own |
| --- | --- | --- |
| `@pi-web/bridge` | envelope, version, errors, capabilities, client factory, publisher, schemas, browser/extension mount types | transport servers, pi imports, React components, plugin-specific code |
| Core bridge host | catalog, capability grants, bindings, message validation, relay | plugin-specific components, CSS, IDs, behavior |
| Plugin browser half | views, styling, browser logic, subscriptions, owner-scoped registrations | pi behavior, core internals, security decisions |
| Plugin extension half | behavior, state production, custom message publishing, action handling | browser code, web descriptors, core imports |
| Generic bridge extension | relay validated extension messages with source attribution | interpreting plugin-specific payloads |

### 3.4 Proposed manifest additions

```json
{
  "id": "my.plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "trust": "trusted",
  "main": {
    "browser": "./dist/browser.js",
    "extension": "./dist/extension.js"
  },
  "capabilities": [
    "session.read",
    "events.subscribe:session",
    "ui.publish",
    "ui.replace:chat.composer"
  ],
  "bridge": {
    "core": {
      "messages": ["session.list", "session.events", "session.prompt"]
    },
    "extension": {
      "messages": [
        {
          "name": "my.plugin.state.changed",
          "kind": "event",
          "schema": "./schema/state.json"
        },
        {
          "name": "my.plugin.action.submit",
          "kind": "command",
          "schema": "./schema/action.json"
        }
      ]
    }
  }
}
```

Rules:

- A `bridge.core` name must exist in the frozen protocol catalog.
- A `bridge.extension` name must begin with the plugin id followed by `.`.
- Plugin messages cannot shadow core names, protected points, or another plugin's namespace.
- A message not declared in `bridge` is rejected on both client and server, even if the capability would allow it.
- A changed schema or browser bundle changes the operator-visible hash and revokes the existing grant.

## 4. Message behavior

### 4.1 Core slice

The SDK client is created from the declared slice:

```ts
const bridge = createPluginBridge({
  pluginId: "my.plugin",
  core: ["session.list", "session.events", "session.prompt"],
});
```

The browser half can only invoke, query or subscribe to those names. The host independently enforces the same slice; a hand-edited browser bundle cannot call an undeclared core message.

### 4.2 Extension bridge

A plugin's Pi extension half publishes through the SDK:

```ts
publishBridgeMessage(pi, source, "my.plugin.state.changed", state, messageId);
```

The flow is:

1. The generic bridge extension observes the SDK's event channel.
2. It verifies that the source id owns the message namespace.
3. It validates the payload against the registered plugin schema.
4. It stamps the source and forwards the envelope through the existing bridge.
5. The plugin browser half receives it over `ctx.protocol.subscribe()`.
6. Browser actions return through `plugin.action.submit` or a declared plugin command message.

`publishBridgeMessage()` must replace its current catalog-only `lookupMessage(name)` check with a lookup over the frozen catalog **plus** registered, validated plugin messages.

### 4.3 Capability mapping

| Operation | Required capability |
| --- | --- |
| Reading a declared core query | declared core message capability, for example `session.read` |
| Subscribing to a declared core event | `events.subscribe:<domain>` |
| Publishing a plugin event | `ui.publish` or `events.publish:<plugin-id>` |
| Invoking a plugin command | `protocol.invoke:<plugin-id>.<command>` |
| Replacing or wrapping a region | `ui.replace:<point>` or `ui.wrap:<point>` |
| Registering a page, command, key, theme or token | matching declared capability |

Capabilities are granted by the existing operator flow. Adding a message declaration never silently widens a capability.

## 5. Work packages

Each package is one commit with `npm run tidy` green. Revert the package commit rather than forward-patching a partial implementation.

### Phase 0 — Freeze decisions and names

**Work**

- Resolve §8 decision gates.
- Freeze SDK package name, manifest fields, plugin-message namespace rule, and browser bundle format.
- Write conformance cases before implementation.

**Exit check**

- Decisions recorded in §8.
- No code required; PRD/plan test green.

### Phase 1 — Standalone bridge SDK

**Work**

- Create `packages/pi-web-bridge` (or the location chosen in D1).
- Move or generate the pure protocol modules into the SDK: envelope, version, errors, catalog types, capability types, client factory, publisher, manifest extension and browser/extension mount contracts.
- Make `web/core/protocol/` re-export the SDK so existing imports keep working.
- Add an SDK boundary test: no import of `web/core/*`, pi packages, React DOM, Fastify, or Node-only modules.
- Add `@pi-web/bridge` as the allowed import in new plugin projects; keep `PUBLIC_PROTOCOL_PATHS` as a deprecated compatibility list until Phase 5.

**Exit check**

- A throwaway project outside the repo can import the SDK and type-check.
- Existing bridge conformance tests still pass unchanged.

### Phase 2 — Manifest-driven browser-half loading

**Work**

- Add a server route that serves a validated, bundled `main.browser` asset from a discovered plugin directory. Reject path traversal, non-JavaScript MIME types and files outside the plugin root.
- Expose discovered browser halves through an authenticated metadata list: id, version, source path, capability declarations, asset URL and hash.
- Extend the client composition root to combine static compatibility halves with discovered halves.
- Feed each discovered half through the existing grant, safe-mode, breaker and protected-point rules.
- Ensure disabling, quarantining, or removing a plugin unmounts its half and restores built-ins.

**Exit check**

- A plugin under a temporary external discovery root mounts without any repository edit.
- Hash change prompts again; safe mode blocks it; disable removes only its contributions.

### Phase 3 — Declared core message slices

**Work**

- Parse and validate `bridge.core` in the manifest and kernel descriptor compiler.
- Derive per-plugin allowed message sets from the declaration.
- Restrict the SDK client factory and server bindings to that set.
- Emit a named `BRIDGE_MESSAGE_DENIED` error for an undeclared message; audit it.
- Keep the first-party client on the full internal catalog.

**Exit check**

- A plugin declaring `session.list` can use it and cannot call `session.delete`.
- A hand-edited browser bundle cannot exceed the declared slice.

### Phase 4 — Plugin-owned extension bridge

**Work**

- Parse `bridge.extension.message` declarations and schemas.
- Register namespaced messages at plugin activation; unregister them on deactivate.
- Update `publishBridgeMessage()` and `extensions/bridge.ts` to validate and relay registered custom names.
- Add source ownership and payload-size checks.
- Add a typed SDK helper so both halves derive message names from one shared schema.
- Route browser actions back through existing action/command messages.

**Exit check**

- An external plugin's Pi extension publishes a custom event and receives a submitted action with no edit to `web/core/` or `extensions/`.
- A plugin cannot publish under another plugin's namespace or a core name.

### Phase 5 — Dogfood and remove static wiring

**Work**

- Move one existing browser plugin to an external discovery root while keeping its repository package as the install artifact.
- Remove its import from `web/plugins/browser-halves.ts` and any plugin-specific page registration.
- Repeat for Files, Artifacts, Router, Web Bridge, Plugin Manager and MCP Manager once the first migration is stable.
- Generate the browser import map from one host-module registry; keep `index.html` a template with a placeholder.
- Move plugin-owned CSS out of the shared client stylesheet and into each plugin's bundle.
- Narrow `PUBLIC_PROTOCOL_PATHS` to the SDK for new projects; first-party browser halves use the SDK plus the generated `@pi-web/host-ui` runtime module.

**Exit check**

- Each first-party plugin activates from its own manifest and bundled `main.browser` asset.
- `web/core/` and composition roots contain no migrated plugin ID, component or CSS.
- Browser half metadata marks repo-owned halves as core plugins for grant and safe-mode decisions.

### Phase 6 — Documentation and retirement

**Work**

- Update `docs/pi-web.md`, `docs/web-plugin-architecture.md`, and the generated catalog/parity references.
- Record the external plugin installation command and trust prompt.
- Document the temporary compatibility path and its removal condition.
- Add the new docs to the README documentation table if they are top-level notes.

**Exit check**

- `npm run tidy` green.
- Browser-runtime and new external-plugin e2e green.
- Working tree clean.

## 6. Acceptance criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC1 | An external plugin imports only `@pi-web/bridge` | SDK boundary test and plugin import check |
| AC2 | A browser half mounts from an arbitrary trusted directory with no repository edit | temp-directory Playwright e2e |
| AC3 | A hash change revokes the browser grant until reconfirmed | browser-runtime e2e |
| AC4 | Safe mode and disable/quarantine remove only that plugin's contributions | browser-runtime e2e |
| AC5 | A plugin can use only its declared core messages | client and server denial tests |
| AC6 | Plugin extension messages are namespaced and schema-validated | publisher conformance test |
| AC7 | A plugin cannot shadow core, protected points, or another plugin's namespace | registration refusal test |
| AC8 | An extension-published custom event reaches the plugin browser half | Playwright e2e |
| AC9 | A browser action reaches the plugin extension half | action round-trip e2e |
| AC10 | A render failure restores the built-in and counts toward the breaker | browser-runtime e2e |
| AC11 | `web/core/` contains no plugin-specific ID, CSS, component or branch | boundary grep/test |
| AC12 | Existing first-party plugins keep working through the compatibility path | current web test suite |
| AC13 | At least one real plugin is installed externally in Phase 5 | dogfood e2e |
| AC14 | `npm run tidy` passes after each phase | CI and local gate |

## 7. Risks and rollback

| Risk | Mitigation |
| --- | --- |
| Serving plugin assets widens the HTTP attack surface | Single bundled file, path containment, fixed MIME, auth, hash, size cap |
| Dynamic message registration weakens the frozen catalog | Namespaced names, schemas, capability gate, core names remain immutable |
| Custom messages become a side door around capabilities | Check declarations at client, relay, and host; audit denied calls |
| Browser code remains local code execution | Trusted tier only, hash-bound operator confirmation, safe mode, breaker |
| Static compatibility path duplicates discovery logic | Removed: all first-party browser halves now load from manifests |
| SDK extraction creates two protocol implementations | SDK is the single implementation; `web/core/protocol/` only re-exports |

Each phase is committed separately. Rollback is `git revert <phase-commit>`; dynamic registrations, routes and manifest fields disappear with their phase. Existing grants remain in operator state and are simply unused after rollback.

## 8. Decision gates

Resolved 2026-11-18. The recommendation in each row is now the binding decision.

| ID | Question | Decision |
| --- | --- | --- |
| D1 | Where does the standalone SDK live and what is its package name? | New top-level `packages/pi-web-bridge`, published as `@pi-web/bridge`; `web/core/protocol/` re-exports it |
| D2 | Should plugin-specific messages be first-class catalog extensions? | Yes: namespaced `<plugin-id>.*` messages with plugin-owned schemas |
| D3 | Should a browser half ship one bundle or arbitrary relative assets? | One bundled ES module per plugin initially; add an asset manifest later if needed |
| D4 | One generic bridge extension or one bridge extension per plugin? | Keep the generic `extensions/bridge.ts` relay; each plugin ships only a normal Pi extension half |
| D5 | Which plugin is the Phase 5 dogfood? | Start with a small page/command plugin, then migrate Files and Router |
| D6 | Is sandboxed/untrusted browser code in scope? | No; remains a later platform increment |

## 9. Tests

Existing suites that must remain green:

- `tests/plugin-project.test.ts`
- `tests/bridge-protocol-catalog.test.ts`
- `tests/web-plugin-browser-runtime.test.ts`
- `web/core/protocol/bindings/bindings.test.ts`
- `web/core/e2e/browser-runtime.e2e.mjs`
- `npm run tidy`

New coverage required by this plan:

- SDK import-boundary test.
- External browser asset serving and containment test.
- Manifest bridge-slice validation test.
- Custom message namespace/schema tests.
- Temp-directory external plugin e2e covering core slice, extension bridge, browser replacement, action round-trip, and zero repository edits.

Not covered: untrusted/sandboxed plugin execution, arbitrary multi-file browser asset graphs, and hot reload with state preservation.

## 10. Removal

Disabling a plugin stops its browser half, unregisters its custom messages, and restores built-in regions. Removing a plugin leaves its operator grant entry behind unless the plugin manager explicitly forgets it; a stale grant cannot load a missing bundle. The static browser registrations are gone; declarative descriptors remain as shadowed compatibility candidates while manifests are authoritative.

## 11. Definition of done

Done when AC1–AC14 pass, all §8 decisions are resolved, at least one real plugin runs entirely from an external discovery root, the compatibility path is documented, generated docs are updated, `npm run tidy` is green, and the working tree is clean.

## 12. Implementation record

| Phase | Commit | Result |
| --- | --- | --- |
| 0 | `0614c40` | Decisions D1–D6 resolved from the plan's recommendations. |
| 1 | `9caacd1` | `packages/pi-web-bridge` owns the pure protocol; `web/core/protocol/` re-exports it. |
| infrastructure | `67c3bf4` | Default per-file test timeout raised to 60s for load-sensitive suites. |
| 3 | `09b3bfa` | Manifest-declared core slices are enforced by client, bindings and host with named denials and audit. |
| 2 | `bfe5011` | External browser halves load from authenticated, hash-bound, contained asset routes. |
| 4 | `f8a59b8` | Plugin-owned namespaced messages flow through the SDK registry, kernel lifecycle, bindings, action bus and generic bridge relay. |
| 5 | `f14185c` | The fixture plugin loads from an external discovery root and new projects import only `@pi-web/bridge`; static halves were deprecated compatibility shims at this point and are superseded by the completion row. |
| 5 (completion) | `9275162` | All first-party browser halves and pages load from manifest-declared bundles; the import map and host runtime shims are generated from one registry. |

**Verified.** `npm run tidy` and `npm run lint:dead` pass; both `web/core/e2e/browser-runtime.e2e.mjs` and `web/core/e2e/browser-loading.e2e.mjs` pass with the external fixture; generated protocol catalog and parity docs are unchanged.

**External install.** Put a trusted plugin package under a directory listed in `PI_WEB_PLUGIN_ROOTS` (colon-separated absolute paths). Its `package.json` may declare `pi.webPlugins`; its `pi-web-plugin.json` declares `main.browser` as a bundled `.js`/`.mjs` entry. The plugin starts disabled: enable it from the plugin manager, then confirm the hash-bound browser-code prompt. `--experimental-strip-types` is required only for SDK source consumers in this repository; shipped plugin bundles are ordinary JavaScript.

**Shared browser runtime.** First-party bundles import React, the JSX runtime, the SDK, icons and file-viewer packages through the generated import map. `web/registry.config.ts` is the single registration file: it names plugin descriptors, browser specifiers, bundles, budgets and plugin-owned assets. `web/build-host-modules.mjs` emits the registered runtime/shims, `web/build-plugin-halves.mjs` externalizes them for plugin bundles, and `web/build.mjs` writes the import map into the built `index.html`. The composition root starts only the discovery runtime. Plugin-owned CSS is injected by each half and removed on unmount.

**Compatibility path.** Declarative descriptors remain in `WEB_PLUGINS` as compatibility candidates, but real manifests sort ahead of them and contribute the descriptor used by the host. Sandboxed/untrusted browser code, multi-file browser asset graphs and hot reload with state preservation remain out of scope.
