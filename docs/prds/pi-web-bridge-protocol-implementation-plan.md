# Technical implementation plan & spec: Pi Web Bridge Protocol

> **Execution disclaimer.** This document is a **derived implementation plan**, not the source of truth. The source of truth is [PRD: Pi Web Bridge Protocol](./pi-web-bridge-protocol.md). For scope, requirements, acceptance criteria and decisions, the PRD wins. If execution reveals a conflict, stop, update the PRD first, then update this plan. Decision gates in §9 were resolved by the owner on 2026-11-17; §9 records the binding answers.

| Field | Value |
| --- | --- |
| **Status** | Active implementation plan — all gates resolved (§9) |
| **Owner** | Faiz |
| **Source of truth** | [docs/prds/pi-web-bridge-protocol.md](./pi-web-bridge-protocol.md) |
| **Builds on** | [web-plugin-architecture](../web-plugin-architecture.md), [pi-web](../pi-web.md), [pi-web-plugin-platform](./pi-web-plugin-platform.md) |
| **Gate** | `npm run tidy` green at the end of every phase; performance checked with `npm run bench:web` |

## 1. Purpose and reading order

1. Read the [PRD](./pi-web-bridge-protocol.md) for *why* and *what*. This document does not restate its goals, risks or non-goals.
2. Read §2–§5 here for *how*: the seam inventory, protocol envelope, catalog, bindings and component contracts.
3. Read §6 for the ordered work packages and §8 for the acceptance traceability.
4. Check §9 before starting work. A phase whose decision is still open is blocked even if the PRD recommends an answer.

Everything in §2 is a statement about the code **today**. Everything from §3 onward is the **target**. Names marked *proposed* are frozen in Phase 0 and may change there without a PRD change; a change after Phase 0 requires updating both documents.

## 2. Current seam inventory

| Seam | Current files / wire | Current shapes | Problem |
| --- | --- | --- | --- |
| Pi API facade | `web/core/shared/pi-api.ts`, `web/core/server/pi-api.ts`, `web/core/pi-api/*`, `POST /api/agent/:id/pi_api` | 15 names: `autocomplete.suggestions`, `commands.builtin`, `settings.read/write`, `settings.models.read/write`, `trust.read/write`, `auth.read/login/state/answer/logout`, `mcp.read/write` | RPC surface has no envelope, version or capability check; contract lives outside the client's seam |
| Session bridge | `web/core/server/bridge.ts`, `extensions/web.ts`, `/api/bridge/:id/attach`, `/api/bridge/:id/events` | Commands: `prompt`, `abort`, `action`, `set_model`, `set_thinking`, `web_command`, `ui_sync`; events include `bridge_attached`, `bridge_resync`, `web_commands`, `web_models`, `web_tree`, `plugin_state` | Two jobs in one extension: session attach plus command/API/registry hosting |
| Web commands | `web/core/plugin-contracts/web-commands.ts` | `web-plugin:commands`, `web-plugin:web-command` | Bus-specific names, not protocol messages; extension identity is implicit |
| Extension UI | `web/core/plugin-contracts/ui-event-models.ts`, `publisher.ts` | `web-ui:event` with `ui.working.changed`, `ui.status.changed`, `ui.widget.changed`, `ui.custom.changed`, `ui.title.changed`, `ui.editor.changed`, `ui.view.changed`, `ui.layout.changed`, `ui.session.lifecycle`, `ui.plugin.action-requested`, `ui.notify` | Already a good event vocabulary, but only one transport and no protocol version/capability |
| Views and actions | `web/core/plugin-contracts/view.ts`, `actions.ts`, `web/core/shared/plugin-state.ts` | `web-plugin:view`, `web-plugin:action-request`, `plugin_state` snapshot; caps such as `VIEW_MAX_BYTES = 65536`, 200 rows, 16 action values | Declarative only; no browser code path |
| Plugin capabilities | `web/core/plugin-contracts/kernel/capabilities.ts`, `manifest.ts` | `kind[:argument]` grammar, `CapabilityError`, `AUTO_GRANTED`, `TRUSTED_ONLY = ui.css`; manifest rejects `main.browser` | Grammar can be extended; no protocol-call gate yet |
| Import boundary | `tests/web-boundaries.test.ts` | Zone allowlists for `client`, `shared`, `server`, `extensions`, `web/plugins`, `pi-api`, `plugin-contracts` | Needs new protocol/adapter/plugin-project zones |

## 3. Target architecture

### 3.1 Package layout (proposed, frozen in Phase 0)

| Path | Owns | Import rule |
| --- | --- | --- |
| `web/core/protocol/` | Envelope, message schemas, handshake, errors, cursor, capability names, conformance suite | Pure: no pi runtime, no browser code, no server code |
| `web/core/protocol/bindings/` | HTTP+SSE, in-process and session-attach bindings | Imports `protocol/` and binding transport only |
| `web/core/adapters/` | Pi-side adapters: settings, trust, auth, MCP, commands, sessions, history, autocomplete, UI | Imports pi packages and `protocol/`; never the web client or plugins |
| `web/core/client/protocol-client.ts` | Typed browser client: `invoke`, `query`, `subscribe`, `snapshot` | Imports `protocol/` and pure contracts only |
| `extensions/web.ts` | Session attach lifecycle only, after CB5 | Imports pi API and `protocol/` bindings; no command dispatcher or `pi_api` host |
| New bridge extension (name frozen in Phase 0) | Observes other extensions and publishes protocol messages | Imports pi API and `protocol/`; never web internals or plugin projects |
| `web/plugins/web-bridge/` | First-party web-side adapter for the bridge extension | Imports `protocol/` client and pure view contracts |
| Plugin projects | Manifest, server half, browser half, assets, styles, tests, own build | Import public protocol client/adapters and declared npm deps; never `web/core/*` internals |

Generated artifacts: `docs/bridge-protocol-catalog.md` (message catalog) and `docs/bridge-protocol-parity.md` (baseline parity matrix). Both are generated from schemas and checked in.

### 3.2 Dependency direction

```
plugin project ─► protocol client ─► protocol schema ─► core adapter ─► pi built-in
                                            ▲
                                            └─ transport binding (HTTP+SSE / in-process / attach)
```

The core client consumes the same protocol client as a plugin project. A private path from client to pi is a protocol defect, not an exception. Update `tests/web-boundaries.test.ts` with zones for `web/core/protocol/`, `web/core/adapters/`, the bridge extension and plugin projects in the same commit that creates them.

## 4. Protocol specification

### 4.1 Envelope

Every crossing carries one envelope. Transport bindings may frame it differently, but the object is identical across bindings.

```ts
interface BridgeEnvelope {
  protocol: "pi-web-bridge";
  version: number;                 // major version; additive changes are capabilities
  kind: "command" | "query" | "event" | "capability";
  name: string;                    // catalog name, e.g. "settings.write"
  messageId: string;               // correlation id for command/query
  sessionId?: string;
  source: { type: "core" | "extension" | "plugin" | "browser" | "host"; id: string };
  target?: { type: "core" | "extension" | "plugin" | "browser" | "host"; id: string };
  timestamp: number;
  sequence?: number;               // monotonic per session + channel
  cursor?: string;                 // opaque resume token
  payload: unknown;
  error?: BridgeError;
}
```

`source.id` is the extension or plugin id. It is mandatory for `extension` and `plugin` sources and is the basis of EB3 attribution. Legacy events that only carry `sourceKey` are adapted at the boundary; the adapter fills `source.id`.

### 4.2 Message kinds

| Kind | Semantics | Correlation | May mutate pi state? |
| --- | --- | --- | --- |
| `command` | Do something; may be rejected by capability or confirmation | `messageId` reply with result or `error` | Yes, after revalidation |
| `query` | Read state or request a snapshot; takes an abort signal | `messageId` reply | No |
| `event` | Stream; may be replayed from a cursor | `sequence` + `cursor` | No |
| `capability` | Handshake/declaration only | `messageId` reply | No |

A command with side effects never becomes an event to bypass confirmation. A destructive action follows the existing confirm-string and audit path (`web/core/plugin-contracts/actions.ts`).

### 4.3 Message catalog (initial mapping)

Names below are *proposed*. Legacy names stay as thin aliases until Phase 7. The full generated catalog is the Phase 0 deliverable.

| Current wire | Protocol name | Kind |
| --- | --- | --- |
| `autocomplete.suggestions`, `commands.builtin`, `settings.read`, `settings.models.read`, `trust.read`, `auth.read`, `auth.state`, `mcp.read` | same name | `query` |
| `settings.write`, `settings.models.write`, `trust.write`, `auth.login`, `auth.answer`, `auth.logout`, `mcp.write` | same name | `command` |
| bridge `prompt` / `abort` | `session.prompt` / `session.abort` | `command` |
| bridge `action` | `plugin.action.submit` | `command` |
| bridge `set_model` / `set_thinking` | `session.set-model` / `session.set-thinking` | `command` |
| bridge `web_command` | `web-command.dispatch` | `command` |
| bridge `ui_sync`, `web-plugin:ui-sync`, `bridge_resync` | `ui.snapshot` / `session.resync` | `query` |
| `web-plugin:commands` | `extension.commands.changed` | `event` |
| `web-plugin:web-command` | `extension.web-command.dispatch` | `command` |
| `web-ui:event` `ui.*` types | same `ui.*` names | `event` |
| `web-plugin:view`, `plugin_state` | `ui.view.changed`, `plugin-state.snapshot` | `event` |
| `web-plugin:action-request` | `plugin.action.requested` | `event` |
| `web-plugin:models-changed` | `models.changed` | `event` |
| attach `web_commands`, `web_models`, `web_tree`, `bridge_attached` | `session.attach.attached` with snapshot payloads | `event` |
| new: header/footer/editor/autocomplete provider | `ui.header.changed`, `ui.footer.changed`, `ui.editor-component.changed`, `ui.autocomplete-provider.changed` | `event` |

Unknown future pi built-ins keep the current pass-through rule: no name in the catalog, dispatch as prompt text, no web change.

### 4.4 Handshake and versioning

1. The client opens a binding and sends a `capability` message `bridge.hello` with `version`, supported bindings, client id and requested capabilities.
2. The host answers `bridge.hello-ack` with its `version`, granted capabilities, `sessionId` and the current `cursor`.
3. A major-version mismatch returns `VERSION_MISMATCH` before any command is accepted. Additive changes are new capability names; a capability the host does not implement is reported as unsupported, never silently ignored.
4. Only after a successful handshake are command/query messages admitted. Events may be buffered by the binding until then and delivered as a snapshot after the ack.

### 4.5 Error shape

```ts
interface BridgeError {
  code: "VERSION_MISMATCH" | "CAPABILITY_DENIED" | "VALIDATION_FAILED"
      | "RATE_LIMITED" | "UNKNOWN_MESSAGE" | "UNSUPPORTED_BINDING"
      | "ADAPTER_UNAVAILABLE" | "SESSION_NOT_FOUND" | "INTERNAL";
  message: string;                 // sanitised with webUiText; no stack, token or header
  retryable: boolean;
  details?: Record<string, string | number | boolean | null>;
}
```

Adapters return `ok/error`; they never throw across the seam. `CAPABILITY_DENIED` names the plugin and capability in `details` and is audited. `VALIDATION_FAILED` names the message and field. Transport-level errors stay in the binding and map to `UNSUPPORTED_BINDING` or `INTERNAL`.

### 4.6 Bounded and inert payloads

- Envelope and ordinary payload: 65,536 bytes of JSON, max nesting depth 8, finite JSON only.
- Text: sanitised with `webUiText`; keys `__proto__`, `constructor` and `prototype` are rejected, as in `validateWebUiEvent`.
- Declared detail fields reuse the current view limits: `VIEW_MAX_DETAIL_CHARS = 20_000`, `VIEW_MAX_DETAIL_BYTES = 524_288`, 200 rows / 500 chars per cell, 100 graph nodes / 200 edges, 12 dialog fields.
- Actions keep `MAX_ACTIONS = 8`, `MAX_ACTION_VALUES = 16`, `MAX_ACTION_VALUE_CHARS = 4000`.
- Per-binding rate and byte-pressure caps remain in the binding; they are not part of a message schema. Exceeding one returns `RATE_LIMITED`.
- HTML is never inline. The host renders declared markdown through its sanitising renderer.

### 4.7 Capabilities

- Keep the existing `kind[:argument]` grammar, `grantCovers` globbing, `assertGranted`, `CapabilityError` and audit behavior from `web/core/plugin-contracts/kernel/capabilities.ts`.
- Reuse existing kinds where they fit: `ui.publish`, `ui.replace`, `ui.slots`, `commands`, `keys`, `routes`, `session.read`, `session.write`, `tap.pi-events`, `events.subscribe`.
- Add `protocol.invoke:<message-name>` in Phase 0 as the generic gate for plugin-originated messages without a domain capability. Argument may be a name or glob; `exec` remains never-auto-granted.
- A message schema declares its required capability. The binding checks it before dispatch. A denial is `CAPABILITY_DENIED` plus an audit entry, not a dropped message.
- A `declarative` plugin cannot declare a browser half. A `trusted` browser half requires explicit operator confirmation showing id, version, source path, content hash and requested capabilities; a hash change revokes the grant.

### 4.8 Ordering, replay and resync

- Per `(sessionId, channel)` sequences are monotonic. Bindings may coalesce rebuildable deltas but never reorder state-bearing events.
- A consumer that detects a gap sends `session.resync` with its last `cursor`. The host returns a snapshot plus a new cursor. This replaces `bridge_resync` and `web-plugin:ui-sync` internally.
- The snapshot is built from the same stores the live events update. Transcript resync must produce no duplicate or missing entries (AC16).
- Deltas that are rebuildable from a snapshot are marked droppable under byte pressure; state-bearing events are not.

### 4.9 Transport bindings

| Binding | Transport | Scope |
| --- | --- | --- |
| In-process | Direct adapter calls plus session event bus | Headless-hosted sessions |
| Session attach | Existing `/api/bridge/:id/attach` SSE + command channel | TUI-owned sessions; renamed in docs per D4, path alias kept |
| HTTP+SSE | Existing `/api/agent/:id/*` routes and session event stream | Browser client |

A binding owns framing, heartbeats, byte-pressure policy, reconnects and the mapping between legacy wire names and protocol envelopes. Message schemas never contain HTTP status codes, SSE event names or route paths.

### 4.10 Conformance suite

`web/core/protocol/testing/conformance.ts` runs one table-driven suite against every binding. For each catalog row it asserts: accepted shapes, rejected shapes, capability gate, error code, sequence/cursor behavior and snapshot equivalence. Phase 1 runs it against in-process and session-attach; Phase 2 adds HTTP+SSE. Any new message ships with its conformance cases in the same commit.

## 5. Component specifications

### 5.1 Core adapters

Each adapter exports a typed function with `(ctx, params, signal) => Promise<Result<T, BridgeError>>`. It wraps a pi built-in by calling it, never copying its behavior. Adapters own validation of browser-originated input; the owning extension revalidates behavior requests (EB5). Session ownership stays unchanged (CB3).

### 5.2 Bridge extension

- Registered in `package.json` `pi.extensions` as its own entry.
- Observes commands, tool calls/results, message renderers, `ctx.ui.*`, custom events and published views from other extensions without requiring their cooperation.
- Adds envelopes for `setHeader`, `setFooter`, `setEditorComponent` and `addAutocompleteProvider`, which are no-ops in the web today.
- Publishes a typed opt-in API from `web/core/protocol/`, replacing imports of `web/core/plugin-contracts/publisher.ts`.
- Carries `source.id` on every message; disabling it removes only its bridged surfaces.

### 5.3 Pi Web Bridge Plugin

First-party web plugin that maps bridged envelopes to host surfaces under existing placement ceilings. It renders text/data, never raw HTML, and uses the host's validated view renderer. It is the only browser-side consumer of the bridge extension's channel.

### 5.4 Browser plugin runtime

- Extend `validateManifest` to accept `main.browser` only for `trust: "trusted"`; reject it for `declarative` (D1 gate).
- Extension points: region/component replace or wrap, pages/routes, commands, keybindings, themes/tokens and protocol hooks (PL2).
- Mount contract: `mount(el: HTMLElement, ctx: WebPluginContext): () => void`. `ctx` exposes the protocol client, read-only host state, theme tokens, logger and safe DOM helpers. No `web/core` internals.
- Loader records id, version, source path, content hash and granted capabilities in the audit log. A hash change forces re-confirmation.
- Error boundary per contribution: a render error restores the built-in region in the same frame and increments the breaker. Safe mode loads Pi Web Core only, with the plugin manager reachable.

## 6. Work packages

Each package is its own commit with `npm run tidy` green. Old routes stay as aliases until Phase 7.

| Phase | Work | Primary files | Exit check |
| --- | --- | --- | --- |
| **0. Spec** | Resolve D4/D5; freeze envelope, version, catalog and manifest extension; generate catalog doc; add boundary zones | `web/core/protocol/*`, `packages/*` if a separate schema package is chosen, `docs/bridge-protocol-catalog.md`, `tests/web-boundaries.test.ts` | Schemas compile; catalog maps every §2 wire; PRD decisions recorded |
| **1. Core adapters** | Move 15 `pi_api` names, bridge commands and web commands behind adapters; split `extensions/web.ts`; keep aliases | `web/core/adapters/*`, `web/core/pi-api/*`, `extensions/web.ts`, `web/core/server/routes.ts`, `web/core/protocol/testing/*` | CB1–CB5; conformance green on in-process + attach; bridge/web tests green |
| **2. Core client** | Introduce `protocol-client.ts`; migrate first-party UI; generate parity matrix; forbid direct pi routes | `web/core/client/**`, `web/core/client/protocol-client.ts`, `docs/bridge-protocol-parity.md`, `tests/web-boundaries.test.ts` | CL1–CL3; AC1, AC2, AC4, AC5, AC16 |
| **3. Bridge extension/plugin** | Add bridge extension, bridge plugin and header/footer/editor/autocomplete envelopes; typed publisher | new extension entry, `web/plugins/web-bridge/*`, `web/core/protocol/publisher.ts` | AC6, AC7 with an unchanged fixture extension |
| **4. Browser runtime** | Trusted loader, extension points, error boundaries, fallback; gate on D1/D6 | `web/core/plugin-contracts/kernel/manifest.ts`, browser loader, `web/plugins/*` | AC8, AC9, AC11, AC12, AC13, AC14 in Playwright |
| **5. Template & dev loop** | Scaffold from empty folder, `check` import scan, reload without server restart; gate on D2 | template repo/scaffold, `check` script | AC10, PL7 |
| **6. Prove it** | Migrate Files, then Artifacts and Router, out of the core bundle | `web/plugins/files/*`, `web/plugins/artifacts/*`, `web/plugins/router/*`, `web/app.tsx`, `web/plugins/panels.tsx` | AC15; no core reference to migrated plugins |
| **7. Retire** | Remove aliases and side-effect panel registration; update docs and catalog; final gate | routes, `web/plugins/panels.tsx`, `docs/pi-web.md`, `docs/web-plugin-architecture.md` | AC17; tree clean |

## 7. Test strategy

- **Unit:** every validator, adapter and error mapping; malformed envelopes and hostile keys.
- **Conformance:** one suite, all bindings, all catalog rows (§4.10).
- **Boundary:** extend `tests/web-boundaries.test.ts` with protocol, adapter, bridge-extension and plugin-project zones; a client or plugin import of a pi route fails CI.
- **Parity:** generated matrix fails CI when a §7.5 PRD baseline row loses an adapter or a passing test.
- **Browser:** Playwright for replacement/fallback in the same frame, trust confirmation, hash revocation, safe mode and protected-core registration failures.
- **Security:** capability denial is audited; browser-originated actions revalidated; no raw HTML; no token in error details.
- **Resilience:** dropped stream resync, no duplicate/missing transcript entries, reload without killing sessions.
- **Performance:** `npm run bench:web`; keep coalescing, byte caps and frame batching in bindings.

## 8. Acceptance traceability

| PRD criterion | Covered by |
| --- | --- |
| AC1 one seam | §7 boundary tests; Phase 2 |
| AC2 protocol contract | §4.10 conformance suite; Phases 1–2 |
| AC3 version handshake | §4.4; Phase 0/1 |
| AC4 baseline parity | generated parity matrix; Phase 2 |
| AC5 unknown built-in | dispatch fallback test; Phase 2 |
| AC6 unchanged extension | bridge extension fixture; Phase 3 |
| AC7 extension isolation | `source.id` assertions and disable test; Phase 3 |
| AC8 independent plugin project | fixture project + Playwright; Phase 4 |
| AC9 fallback | error-boundary and breaker test; Phase 4 |
| AC10 import scan | plugin `check`; Phase 5 |
| AC11 no plugin in core | core source grep/boundary; Phase 4 |
| AC12 trust | confirmation/hash audit test; Phase 4 |
| AC13 protected core | registration refusal test; Phase 4 |
| AC14 safe mode | safe-mode boot test; Phase 4 |
| AC15 dogfood | Files migration; Phase 6 |
| AC16 resync | snapshot + cursor test; Phase 2 |
| AC17 gate | `npm run tidy`; every phase, final in Phase 7 |

## 9. Decision gates

Resolved by the owner on 2026-11-17; these are the binding answers, not assumptions.

| Decision | Needed before | Binding answer |
| --- | --- | --- |
| D1 browser code allowed | Phase 4 | Yes — `trusted` only, with hash-bound operator confirmation |
| D2 plugin project locations | Phase 5 | Anywhere trusted; first-party exemplars stay in repo |
| D3 sandboxed tier | Not in scope | Out of scope |
| D4 naming ("session attach") | Phase 0 | Rename docs, keep path alias |
| D5 transport | Phase 0 | Keep HTTP+SSE; new transport is a later binding |
| D6 UI framework | Phase 4 | Host-provided React plus `mount(el, ctx)` escape hatch |
| D7 one bridge extension | Phase 3 | One first-party extension |
| D8 meaning of "Pi Web" | Phase 2 | Any frontend; first-party UI is the reference consumer |

### 9.1 Frozen in Phase 0

- Protocol name `pi-web-bridge`, major version `1`; additive changes are new capability names and new catalog rows.
- Catalog rows in `docs/bridge-protocol-catalog.md` are generated from `web/core/protocol/catalog.ts`; every §2 wire has exactly one row. Legacy names are aliases until Phase 7.
- Binding names are `in-process`, `session-attach` and `http-sse`. Naming follows D4 in docs; `/api/bridge/:id/*` paths are aliases until Phase 7.
- Plugin browser half is `main.browser: ./…`, allowed only with `trust: "trusted"`; the mount contract is `mount(el: HTMLElement, ctx: WebPluginContext): () => void`. Kernel/manifest adoption lands in Phase 4; the frozen shape lives in the protocol package.
- `protocol.invoke:<message-name>` is a sensitive capability (operator grant required outside the host tree); domain capabilities take precedence where declared.

## 10. Delivery rules and rollback

- One phase per commit; no mixed behavior/refactor commits. Revert the phase commit rather than forward-patching an alias.
- Legacy names are aliases only; new code never introduces a new side door. Alias removal is Phase 7, not a cleanup in an earlier phase.
- Session ownership rules do not change during the `extensions/web.ts` split.
- No plugin-specific CSS, component, id branch or import in `web/core/`.
- If a phase reveals a requirement change, update the PRD, then this plan, then resume.
- Definition of done is [PRD §14](./pi-web-bridge-protocol.md#14-definition-of-done): AC1–AC17 pass, Files is independent, parity is green, docs are committed and the tree is clean.

## Related

- [PRD: Pi Web Bridge Protocol](./pi-web-bridge-protocol.md)
- [Web plugin architecture](../web-plugin-architecture.md)
- [PRD: pi-web plugin platform](./pi-web-plugin-platform.md)
- [Pi Web documentation](../pi-web.md)
