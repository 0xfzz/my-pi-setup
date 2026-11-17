# PRD: Pi Web Bridge Protocol

> **Source of truth.** This PRD defines the product requirements, scope, decisions and acceptance criteria for the Bridge Protocol. The [technical implementation plan & spec](./pi-web-bridge-protocol-implementation-plan.md) is derived execution guidance; if the two disagree, this PRD wins. Change this document first, then update the plan.

| Field | Value |
| --- | --- |
| **Status** | Draft, for review |
| **Owner** | Faiz |
| **Source** | Migrated from the workspace artifact `pi-web-bridge-protocol-prd` v1 |
| **Derived plan** | [Technical implementation plan & spec](./pi-web-bridge-protocol-implementation-plan.md) |
| **Scope** | `web/core/` (protocol, core adapters), `extensions/web.ts` (split), a new bridge extension, `web/plugins/` (first-party plugins become exemplars), plugin project template |
| **Builds on** | [minimal-pi-web](./minimal-pi-web.md), [pi-web-plugin-platform](./pi-web-plugin-platform.md), [web-plugin-architecture](../web-plugin-architecture.md), [pi-web](../pi-web.md) |
| **Amends** | The `declarative only, no plugin client code` constraint in minimal-pi-web. See §9 and Decision D1. |

---

## 1. Summary

Pi Web gets one **Bridge Protocol**: a versioned, typed contract that is the only seam between pi and anything that renders it.

It is used at two levels:

| Level | Connects | Result |
| --- | --- | --- |
| **Core level** | Pi Core built-ins → Bridge → Pi Web | Every built-in pi capability is available to the web through the protocol. This is **Pi Web Core**. |
| **Extension level** | Pi Extension → Bridge extension → Pi Web Bridge Plugin → Pi Web | Any pi extension can surface in the web without importing web code. A web-side bridge plugin adapts it. |

On top sits two layers:

- **Core layer.** Ports the whole pi baseline into the web using the protocol, and nothing else.
- **Plugin layer.** Independent plugin **projects** reuse the same protocol and core feature adapters to change Pi Web itself. All view, styling and logic live in the plugin project. The core is never edited.

## 2. Problem

Today a plugin can *position host-rendered data*. It cannot *change Pi Web*. Four concrete causes, all verified in the repo:

| # | Finding | Evidence |
| --- | --- | --- |
| P1 | **The seam is not one thing.** The web talks to pi through at least five unrelated channels: `/api/agent/:id/*` routes (26 call sites in client and plugins), the `pi_api` facade (15 api names), the `web_command` channel, `web-plugin:*` event-bus events, and the TUI attach SSE stream. Contracts are split across `web/core/shared/` and `web/core/plugin-contracts/`. | `web/core/shared/pi-api.ts`, `web/core/shared/commands.ts`, `web/core/plugin-contracts/*`, `web/core/server/bridge.ts` |
| P2 | **`extensions/web.ts` does two jobs.** It is the session bridge (attach, event relay) *and* the built-in command dispatcher *and* the `pi_api` host *and* the web command registry. 1,665 lines in one extension. | `extensions/web.ts` |
| P3 | **Plugins cannot ship browser code.** The manifest has `main.server` only, and trust tiers are `declarative \| trusted` (server half). Bespoke panels (Files, Artifacts, Router) are React compiled into the same bundle through the composition root, so they are in-repo, not independent. | `web/core/plugin-contracts/kernel/manifest.ts`, `web/app.tsx`, `web/plugins/panels.tsx` |
| P4 | **Overrides are declarative views.** A region override renders a `kv`/`list`/`status`/`graph`/`dialog` view. A plugin cannot restyle the transcript, replace the composer with its own component, or change app logic in the browser. `wrap` renders *beside* the built-in. | `web/core/plugin-contracts/view.ts`, `ComponentOverrideHost.tsx`, `docs/pi-web.md` |

Consequence: to change how Pi Web looks or behaves beyond a declared view, you edit `web/core/`. Behavior and interface keep leaking into each other, which is exactly what the architecture rule is meant to prevent.

## 3. Vision and principles

> **Nothing the web shows or does about pi is reachable except through the Bridge Protocol. Nothing in the core knows what a plugin looks like.**

1. **One seam.** Every pi capability the web uses crosses the Bridge Protocol. No side doors.
2. **Core is a protocol client, not special.** The first-party web client consumes the same protocol and adapters a plugin project does. If core needs a private path, the protocol is wrong; extend the protocol.
3. **Interface in the plugin, behavior in pi.** Keeps the existing rule: if it changes what pi does it is a pi extension; if it changes what the web shows it is a web plugin. The protocol is the only thing that crosses.
4. **Core never imports a plugin.** Dependency stays one-way (plugin → protocol → pi). Already enforced by `tests/web-boundaries.test.ts`; extended here.
5. **Failure is contained.** A broken plugin project falls back to the built-in web. Never takes the app down.
6. **Compatible by default.** Unchanged pi extensions keep working. Unknown future pi built-ins pass through.

## 4. Goals and non-goals

### Goals

- **G1.** A single, versioned Bridge Protocol specification covering commands, queries, events and capabilities between pi and the web.
- **G2.** Pi Web Core reaches **parity with the pi baseline** (built-in commands, settings, sessions, tools, auth, trust, MCP, history) using only the protocol.
- **G3.** An extension can reach the web **without importing web code** and without being edited, via a dedicated bridge extension.
- **G4.** A **plugin project** can live outside this repo's `web/core/`, ship its own views, styling and logic, and change Pi Web without a core edit.
- **G5.** Core and plugin layers are separated by an enforced boundary, with tests that fail on a violation.
- **G6.** First-party plugins are migrated to this model so the model is proven, not just promised.

### Non-goals

- Changing what pi itself does (system prompt, tool semantics, session file format).
- Replacing pi's own extension API. The bridge extension *uses* it.
- A plugin marketplace, remote auto-install or auto-update. Install stays local and explicit.
- Multi-user hosting. Pi Web stays single-operator.
- Pixel parity between the TUI and the web.
- Replacing authentication, transport integrity or destructive-action confirmation (stay protected core, see §8).

## 5. Terms

| Term | Meaning |
| --- | --- |
| **Pi Core** | pi's built-ins: `AgentSession`, built-in slash commands, `SettingsManager`, trust store, `ModelRuntime`, session files, MCP config. |
| **Pi Extension** | Any pi extension in `extensions/*` or an external pi package. Behavior. |
| **Bridge Protocol** | The versioned contract between pi-side and web-side: message shapes, ordering, errors, versioning, capabilities. Transport-neutral. |
| **Core adapter** | A pi-side implementation of one protocol feature over a pi built-in (e.g. `settings`, `trust`, `autocomplete`, `session.history`). Today's `web/core/pi-api/*` modules are the seed. |
| **Bridge extension** | A **new pi extension** that bridges *other* extensions to the web through the protocol. It is not the session bridge. |
| **Pi Web Bridge Plugin** | The **web-side** adapter for the bridge extension: turns what the protocol delivers from an extension into web surfaces. |
| **Pi Web Core** | The first-party web client plus server host, built only on the protocol. |
| **Plugin project** | An independent project (own folder or repo, own `package.json`, own build) that depends on the protocol client and owns its views, styling and logic. |
| **Pi Web** | The assembled product the user sees: Pi Web Core plus enabled plugin projects. |

> **Naming caution.** The repo already calls the TUI attach channel "the session bridge" (`/api/bridge/:id/attach`, `web/core/server/bridge.ts`). This PRD uses **Bridge Protocol** for the new seam. See Decision D4.

## 6. Architecture

### 6.1 Core level: built-ins to Pi Web Core

```
 Pi Core  ──►  Bridge Protocol (core level)  ──►  Pi Web
 (built-ins)   core adapters, typed, versioned     (Pi Web Core)
```

- Adapters sit pi-side, one per feature, over pi's own built-ins. They call pi, they never copy it (existing rule: *called, not copied*).
- Web-side, the **core client** exposes the same features as typed calls and streams.
- The first-party UI (transcript, composer, sidebar, dialogs) is a consumer of that client only.

### 6.2 Extension level: extensions to Pi Web

```
 Pi Extension ─► Bridge extension ─► Pi Web Bridge Plugin ─► Pi Web
 (unchanged)     (new, pi-side)        (web-side adapter)
```

- The **bridge extension** observes and, where the extension opts in, receives from other extensions: registered commands, tools, message renderers, `ctx.ui` calls (status, widget, title, header, footer, editor), custom events and published views.
- It re-expresses them as protocol messages. The extension imports **no** `web/` code.
- The **Pi Web Bridge Plugin** maps those messages to web surfaces under the host's rules (placement, ceilings, safe rendering).
- Extensions that want richer control use a small typed opt-in API from the protocol package (the successor of `publishWebView`).

### 6.3 Layers

| Layer | Owns | May use |
| --- | --- | --- |
| **Core layer** (Pi Web Core) | Porting the full pi baseline into the web, the protocol, the core adapters, the host, auth, transport, safe mode | Protocol only for anything pi-related |
| **Plugin layer** (plugin projects) | **All** view, styling and logic of the customization | Protocol client and core adapters. Never core internals. |

The Bridge Protocol sits **between** the two layers (the overlap on the whiteboard): the core layer *implements and exposes* it, the plugin layer *consumes* it.

### 6.4 Boundary rules (enforced on the import graph)

| From | May import | May not import |
| --- | --- | --- |
| Core client / server | protocol, core adapters, pi packages (server and adapters only) | any plugin, any plugin project |
| Core adapters | pi packages, protocol types | web client, plugins |
| Bridge extension | pi API, protocol | web client, plugin projects, descriptors |
| Pi extension (any) | pi API, optionally the protocol package | web core internals, plugin projects |
| Plugin project | protocol client, core adapters (public surface), its own code, declared npm deps | `web/core/*` internals, other plugins' internals |

## 7. Requirements

### 7.1 The protocol (BP)

- **BP1.** One specification document and one schema package define every message. Every message has a name, a payload schema, an error shape and a version.
- **BP2.** Four message kinds: **command** (do something), **query** (read state), **event** (stream), **capability** (declare what is supported).
- **BP3.** Versioned. A handshake exchanges protocol version and capabilities. A mismatch fails with a named error, never silently degrades.
- **BP4.** Transport-neutral. It must run over today's HTTP plus SSE, and over the detached session host. Transport details live in bindings, not in message definitions.
- **BP5.** Bounded and inert. Payload size, depth and rate caps. Text is data, never HTML. Reuses the existing validation rules (`webUiText`, `__proto__` guards).
- **BP6.** Replay and resync. After a gap a consumer converges from a snapshot plus cursor (carry over the existing cursor history and `bridge_resync` behavior).
- **BP7.** A protocol conformance suite that any binding and any adapter can run.

### 7.2 Core-level bridge (CB)

- **CB1.** Every web feature that touches pi maps to a protocol message. No direct call into pi from `web/core/client`.
- **CB2.** Core adapters exist for the baseline in §7.5. Each wraps a pi built-in, takes an abort signal, returns `ok/error`, never throws across the seam.
- **CB3.** Session ownership model unchanged: one live `AgentSession` is the source of truth; TUI-owned, headless-owned and in-process sessions all appear identically at the protocol.
- **CB4.** The existing `pi_api` facade, `web_command` channel, bridge attach and `web-plugin:*` events are re-expressed as protocol messages. Old routes stay as thin aliases until removed.
- **CB5.** `extensions/web.ts` is split: lifecycle and session attach stay; command dispatch, `pi_api` hosting and the web command registry move to core adapters.

### 7.3 Extension-level bridge (EB)

- **EB1.** The bridge extension is a separate pi extension, listed in `package.json` `pi.extensions`, that needs no cooperation from the extensions it bridges.
- **EB2.** It surfaces, at minimum: commands, tool calls and results, `ctx.ui.setStatus/setWidget/setTitle/setWorkingIndicator`, published views and extension events. The `ctx.ui` calls that are no-ops in the web today (`setHeader`, `setFooter`, `setEditorComponent`, `addAutocompleteProvider`) gain protocol messages.
- **EB3.** Per-extension identity. Every message carries its source extension id. A consumer can filter, and the web can attribute it.
- **EB4.** Opt-in rich API for extensions: the typed publisher in the protocol package (replaces importing `web/core/plugin-contracts/publisher.ts`).
- **EB5.** Behavior stays pi-side. Browser-originated requests (actions, commands) arrive as untrusted input and are re-validated by the owning extension, as in the existing action contract.
- **EB6.** The Pi Web Bridge Plugin is first-party, ships with Pi Web, and renders bridged surfaces with the host's placement ceilings.

### 7.4 Plugin layer (PL)

- **PL1.** A plugin project is **one self-contained project**: manifest, optional server half, **browser half**, assets, styles, tests, its own build. No file of it lives under `web/core/`.
- **PL2.** It can change Pi Web by contributing to named extension points: replace or wrap a region or component, add pages and routes, commands, keybindings, themes and tokens, and add or override logic via protocol hooks.
- **PL3.** It reaches pi **only** through the protocol client and the public core adapter surface. A static check fails the build on any import of `web/core/*` internals.
- **PL4.** All its view, styling and logic ship inside the project. The core carries no plugin-specific CSS, component or branch on a plugin id (extends the existing "no host code branches on a plugin id" rule).
- **PL5.** It can be installed from a directory, a pi package (`pi.webPlugins`), or a user/project root, with the existing precedence (project > user > package > repo) and enable/disable/quarantine lifecycle.
- **PL6.** Replacement is total and reversible: disabling, a failed load or a render error returns the built-in view in the same frame (existing breaker and safe-mode behavior extended to the browser half).
- **PL7.** A scaffold produces a working plugin project from an empty folder. A dev loop reloads it without restarting the server.

### 7.5 Core layer: baseline parity (CL)

The core layer ships when every row below works through the protocol. Source: `docs/pi-web.md`, `web/core/shared/commands.ts`, `web/core/pi-api/`.

| Area | Baseline | Today |
| --- | --- | --- |
| Built-in slash commands (24) | Web-ported (13): `settings`, `model`, `thinking`, `scoped-models`, `export`, `copy`, `session`, `changelog`, `hotkeys`, `trust`, `login`, `logout`, `resume`. Through core registry (11): `tree`, `import`, `share`, `bug`, `name`, `fork`, `clone`, `new`, `compact`, `reload`, `quit`. | Done, ad-hoc channels |
| Unknown future built-ins | Pass through as prompt text, unflagged | Done |
| Settings and scoped models | `settings.read/write`, `settings.models.read/write` | Done (`pi_api`) |
| Trust | `trust.read/write` | Done |
| Auth and login | `auth.read/login/state/answer/logout` | Done |
| MCP | `mcp.read/write` | Done |
| Autocomplete | `autocomplete.suggestions` (pi's own provider, `@` mentions) | Done |
| Sessions | Directory stream, search, create, resume, delete (vetoable), rename, live/idle | Done |
| Transcript | Cursor history, live append, tool results, images, bash executions | Done |
| Model and thinking | Picker, apply, thinking level, context usage | Done |
| Compaction | Server-owned and bridge-forwarded | Done |
| Realtime and resilience | SSE, backpressure caps, resync, reload without killing sessions | Done |
| Tree, fork, clone | Searchable tree picker, fork dialog answerable from either frontend | Done |
| Extension UI | status, widget, title, editor, notify, working indicator | Partial (`setHeader`, `setFooter`, `setEditorComponent`, autocomplete provider are no-ops) |

- **CL1.** Each row is exposed as protocol messages and covered by the conformance suite.
- **CL2.** The first-party client uses no pi-related route outside the protocol bindings.
- **CL3.** Parity is tracked in a generated matrix (protocol feature to adapter to test) that fails CI when a baseline row loses coverage.

## 8. Security and trust

- **SC1.** **Browser plugin code is local code execution.** A script in the Pi Web origin carries the operator's session, and pi can run shell commands. The browser half of a plugin project is therefore `trusted` only, enabled by explicit operator action showing id, version, source path, content hash and requested capabilities. A changed hash revokes the grant. This follows the existing platform PRD §7 stance.
- **SC2.** **Capabilities** (existing grammar, extended) gate every protocol call a plugin makes. A call outside the grant raises `CapabilityError` naming plugin and capability, audited.
- **SC3.** **Protected core** stays non-replaceable and non-vetoable: signed-session auth, loopback binding, transport integrity, capability gate and audit log, plugin manager and safe-mode entry, destructive-action confirmations (observe and add, never skip).
- **SC4.** Bridge routes accept only the bridge token. A browser session cannot impersonate a session owner. Unchanged.
- **SC5.** Messages from the browser to extensions are untrusted input (existing action rules: allowlist, single-use ids, bounded concurrency, extension-side revalidation).
- **SC6.** **Safe mode** boots Pi Web Core only, with no plugin projects, and keeps the plugin manager reachable.
- **SC7.** No parameterized execution crosses the seam unless a message schema declares it and the extension re-validates it. `exec`-class capability is never auto-granted.

## 9. Changes to current decisions

| Decision | Today | This PRD |
| --- | --- | --- |
| Plugin client code | Never executed. Overrides are declarative views. | Allowed for `trusted` plugin projects. Declarative path stays first-class and the default. |
| Trust tiers | `declarative`, `trusted` (server half only) | `trusted` gains a browser half. A `sandboxed` tier stays out of scope (see D3). |
| Where bespoke UI lives | Compiled into the core bundle via `web/app.tsx` | In the plugin project, loaded by a browser module loader. |
| `extensions/web.ts` | Session bridge plus command dispatcher plus `pi_api` host plus registry | Split along §7.2 CB5. |
| Extension to web | Extension imports `web/core/plugin-contracts/publisher.ts` | Extension uses the bridge extension, or the protocol package's typed publisher. |

## 10. Phasing

Each phase leaves the app working and `npm run tidy` green.

| Phase | Deliverable | Done when |
| --- | --- | --- |
| **0. Spec** | Protocol spec, message catalog, handshake and versioning, naming decision (D4), generated catalog doc | Spec reviewed. Schemas compile. Existing routes and events mapped to messages in a table. |
| **1. Core adapters** | Move `pi_api`, `web_command` and bridge messages behind protocol definitions. Split `extensions/web.ts`. Old routes become aliases. | CB1–CB5 pass. Conformance suite green against the in-process and bridged bindings. |
| **2. Core client on the protocol** | First-party client uses only the protocol client. Parity matrix generated. | CL1–CL3 pass. Boundary test forbids direct pi routes in the client. |
| **3. Bridge extension and bridge plugin** | EB1–EB6. `ctx.ui` no-ops gain messages. Typed publisher in the protocol package. | A third-party extension unchanged shows status, widget, header and footer in the web. |
| **4. Browser runtime** | Trusted browser module loader, extension points for regions/components/pages/commands/keys/themes, error boundaries, fallback to built-in. | PL2, PL6 pass in Playwright. |
| **5. Plugin project template and dev loop** | Scaffold, `check` (import-boundary scan), dev reload, template repo | PL7 passes from an empty folder. |
| **6. Prove it** | Move Files out of the core bundle into an independent plugin project. Then Artifacts and Router. | The migrated plugins run from outside `web/core/` with no core change. Core bundle has no reference to them. |
| **7. Retire** | Remove aliases and `panels.tsx` side-effect registration. Update docs. | No pi-related route outside bindings. Docs and catalog updated. Tree clean. |

## 11. Acceptance criteria

Each is checked by a test or a scripted run.

- **AC1 (one seam).** A boundary test fails if `web/core/client` or any plugin project calls a pi-related route, imports a pi package, or imports `web/core/server` outside the protocol bindings.
- **AC2 (protocol contract).** A conformance suite exercises every message against the in-process, bridged and headless-host bindings with identical results.
- **AC3 (version handshake).** A client and server with mismatched protocol versions fail with a named error before any command runs.
- **AC4 (baseline parity).** The generated parity matrix lists every row in §7.5 with an adapter and a passing test. Removing coverage for one row fails CI.
- **AC5 (unknown built-in).** A future pi built-in unknown to the web dispatches as prompt text and appears in the palette, with no web change.
- **AC6 (unchanged extension).** A fixture extension that calls `ctx.ui.setStatus`, `setWidget`, `setTitle`, `setHeader` and `setFooter` and imports no web code shows all five in the web through the bridge extension.
- **AC7 (extension isolation).** The bridge extension carries the source extension id on every message. Disabling the bridge extension removes those surfaces and nothing else.
- **AC8 (independent plugin project).** A fixture plugin project in a separate folder, with its own `package.json` and build, replaces the composer, restyles the transcript, and adds a page and a command. No file under `web/core/` changes. Playwright asserts all four.
- **AC9 (fallback).** Disabling that plugin project, or making its component throw, restores the built-in region in the same frame without a reload. A throw is counted toward the breaker.
- **AC10 (import scan).** `check` fails a plugin project that imports `web/core/*` internals, and names the import.
- **AC11 (no plugin in core).** `grep` finds no first-party plugin id, no plugin CSS and no plugin component in `web/core/`.
- **AC12 (trust).** A `trusted` browser half from outside the repo does not load until the operator confirms, and a changed content hash revokes the grant. Verified in the audit log.
- **AC13 (protected core).** A plugin cannot replace auth, transport, the plugin manager or a destructive confirmation. Registration fails with a named error.
- **AC14 (safe mode).** `PI_WEB_SAFE_MODE=1` and the crash-loop trigger boot Pi Web Core with no plugin projects. The plugin manager can re-enable one.
- **AC15 (dogfood).** Files runs as an independent plugin project with the same protocol client and no private core import. The core bundle no longer references it.
- **AC16 (resync).** After a dropped stream, a consumer converges via snapshot plus cursor with no duplicated or missing transcript entries.
- **AC17 (gate).** `npm run tidy` passes at every phase. Docs, catalog and PRD are committed. Working tree is clean.

## 12. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Browser plugin code is local code execution | An enabled malicious plugin controls the machine | Trusted only, hash-bound operator grant, loopback default, capability gate, audit log, safe mode, clear docs. |
| The protocol becomes a large API that is hard to change | Every pi upgrade breaks plugin projects | Versioned messages, additive-only within a major, compatibility adapters for one major, conformance suite, pass-through for unknown built-ins. |
| Big-bang rewrite stalls | Months with no user-visible win | Phases 1–2 are refactors behind aliases. Each phase ships green. Phase 3 and 6 deliver visible value. |
| `extensions/web.ts` split regresses TUI and web sync | Lost or duplicated turns | Split behind the existing bridge tests (`bridge.test.ts`, web-bridge tests). Do not change the session ownership rules in the same commit. |
| Bridge extension misrepresents an extension's UI | Confusing or unsafe rendering | Host ceilings, text-only rendering, source attribution, per-extension off switch. |
| Naming collision between "session bridge" and "Bridge Protocol" | Docs and code confusion | Decide in Phase 0 (D4). |
| Performance on hot paths (streaming, render) | Janky chat | Keep coalescing, byte-pressure caps and frame batching inside the binding. Add a protocol latency bench to `npm run bench`. |
| Two plugins replace the same region | Flaky UI | Existing rule: last registration wins with a visible diagnostic. Add user choice in the plugin manager. |

## 13. Decisions needed

| # | Question | Recommendation |
| --- | --- | --- |
| **D1** | Allow plugin browser code at all? | Yes, `trusted` only. The plugin layer as drawn is impossible without it. The platform PRD already lifted the rule on paper but never built the loader. |
| **D2** | Where do plugin projects live? | Anywhere: a folder under `~/.pi/agent/web-plugins`, a project root, or a pi package (`pi.webPlugins`). A separate repo per plugin is allowed. First-party ones can stay in this repo as exemplars as long as they obey the same import rule. |
| **D3** | Sandboxed tier (iframe or worker) for untrusted plugins? | Out of scope here. Add later. |
| **D4** | Rename today's "session bridge"? | Yes. Call the TUI attach channel **session attach**, and treat it as one transport binding of the Bridge Protocol. |
| **D5** | Transport: keep HTTP plus SSE, or add a new one? | Keep. Formalize the contract and version it. A new transport is a later binding. |
| **D6** | UI framework for plugin projects | React from the host (singleton, small bundles, version coupling) or any framework behind a mount function. Recommend host-provided React plus a framework-neutral `mount(el, ctx)` escape hatch. |
| **D7** | Is the bridge extension one extension or a generic mechanism others can host? | One first-party extension. Keep the mechanism small. |
| **D8** | Does "Pi Web" in the core-level diagram mean the default UI, or any frontend? | Any frontend. The first-party UI is just the reference consumer. |

## 14. Definition of done

Done when AC1–AC17 pass, Files runs as an independent plugin project, the parity matrix is green, the first-party client has no side door to pi, docs (`docs/pi-web.md`, `docs/web-plugin-architecture.md`, a protocol spec) are updated and committed, the working tree is clean, and `npm run tidy` passes.

## 15. Reading of the whiteboard (for review)

Where this PRD interpreted rather than copied the whiteboard. Please confirm or correct.

| Whiteboard text | Interpretation |
| --- | --- |
| "Builtin stuff to Pi Web Core" | Core-level bridge carries pi's built-ins only. It defines Pi Web Core. |
| "Extension to Web Plugin" | Extension-level bridge carries extension surfaces. It defines how plugins get fed. |
| "Bridge (Protocol) new extension that bridge extension and web" | A **new pi extension** (the bridge extension) that connects arbitrary extensions to the web. Not the existing session bridge. |
| "Pi Web Bridge Plugin" | The web-side adapter for that bridge extension. |
| "Port all builtin pi baseline into web using the bridge protocol" | Baseline parity (§7.5), through the protocol only. |
| "Independent plugin project that reuse all the core feature adapter (bridge protocol)" | A plugin project consuming the same protocol client and core adapters as the core client. |
| "modify the pi web itself without modifying the core" | Replace or extend regions, components, pages, themes and logic from outside `web/core/`. |
| "All view, all styling, all the logic should live in the plugin project itself" | PL1 and PL4: nothing plugin-specific in core. This implies browser code (D1). |
