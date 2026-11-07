# PRD: Fully pluggable, event-driven pi-web UI

> Follow-up to [Fork pi-web integration](./fork-pi-web-integration.md). This PRD fixes the current plugin UI limitation: a plugin can select only one of four host-owned slots, and pi-web silently ignores several standard `ctx.ui` display APIs. The result is that the ported Bubbly Spinner text changes in the TUI but does not change the corresponding web working UI.

| Field | Value |
| --- | --- |
| **Status** | proposed |
| **Owner** | Faiz |
| **Scope** | `lib/web-plugins/`, `web-plugins/`, `extensions/`, `vendor/pi-web/` |
| **Related** | [fork-pi-web-integration](./fork-pi-web-integration.md), [plugin-actions](./plugin-actions.md) |
| **Follow-up** | [pi-web-plugin-platform](./pi-web-plugin-platform.md) — audits this PRD's limits and extends it to a full plugin platform |

## 1. Problem

The current integration has two separate UI paths:

1. `publishWebView()` sends a small data view through `web-plugin:view`; the host renders it with built-in React components and a fixed `top`, `center`, `bottom`, or `floating` slot.
2. Standard extension UI calls are handled by pi-web's RPC adapter. `setStatus`, widgets, dialogs, and custom UI have partial support, but `setWorkingMessage()`, `setWorkingVisible()`, and `setWorkingIndicator()` are no-ops in `vendor/pi-web/lib/rpc-manager.ts`.

The Bubbly Spinner therefore updates the TUI through `ctx.ui.setWorkingMessage()` and `ctx.ui.setWorkingIndicator()`, while separately publishing a status chip that pi-web special-cases with `plugin.id === "bubbly-spinner"`. The web UI does not receive the actual working-message state or the animation frames. This is a contract failure, not a Bubbly Spinner-specific styling issue.

The fixed-slot model also prevents a plugin from choosing a freeform position, anchoring a view to a host region, replacing a built-in component, or composing a new surface from existing UI primitives. Adding a new placement currently requires editing the fork and often adding plugin-specific rendering logic.

## 2. Goals

- **G1. One event-driven UI contract.** Every extension UI change, including standard `ctx.ui` calls, enters a typed event stream. The web host derives its state from those events.
- **G2. Freeform placement.** A plugin can place a view in a named host anchor, a layout region, an overlay layer, or an absolute/anchored position within an explicitly permitted container. Position is descriptor data, not a hard-coded plugin branch.
- **G3. Component override.** Every pi-web component that is exposed through the plugin contract has a stable component key and can be replaced, wrapped, hidden, or configured by a plugin. Most-specific active override wins deterministically.
- **G4. No special cases.** Bubbly Spinner, dashboard, cache, todos, and future plugins use the same descriptor, event, placement, and rendering contracts. The host must not test plugin IDs to decide how to render.
- **G5. Preserve pi compatibility.** Existing extensions continue to work through standard `ctx.ui` APIs. No pi-web-only API is required for a plugin to display a working message.
- **G6. Safe extensibility.** Plugins receive data and declared capabilities, not arbitrary browser execution or unrestricted DOM access. HTML, scripts, CSS injection, and event spoofing remain prohibited by default.
- **G7. Upstream-friendly fork.** The implementation remains a small host layer around pi-web and does not fork every page or duplicate the session protocol.

## 3. Non-goals

- Arbitrary third-party JavaScript or React bundles executing in the browser.
- Replacing pi's extension API or changing TUI behavior.
- Unbounded absolute positioning that can cover authentication controls, the browser viewport, or another plugin without a host policy.
- Allowing plugins to invoke shell commands or mutate workflow state through UI events. Actions remain governed by [plugin-actions](./plugin-actions.md) and future action PRDs.
- Guaranteeing identical pixels across TUI and web. The contract guarantees equivalent semantic state and a plugin-controlled web presentation.

## 4. User stories

- **Extension author:** "When I call `ctx.ui.setWorkingMessage('Ratiocinating...')`, the selected pi-web session shows that message in its working indicator without publishing a second, special view."
- **Extension author:** "I can place a card beside the chat composer, anchor a badge to the session header, or render a floating panel without editing `AppShell.tsx`."
- **Plugin author:** "I can override the default working indicator or status renderer for my plugin without a `plugin.id` conditional in host code."
- **Operator:** "A plugin view can be moved or disabled by changing its descriptor/configuration, and live updates appear without a page reload."
- **Maintainer:** "A malformed or conflicting plugin cannot break the core UI, steal an anchor, execute markup, or make event delivery synchronous with an agent turn."

## 5. Product requirements

### 5.1 Unified descriptor

**R1.** Extend `WebPluginDescriptor` with declarative UI contributions:

```ts
interface WebPluginUiContribution {
  id: string;
  component: string;
  view?: string;
  placement: WebPluginPlacement;
  priority?: number;
  visibleWhen?: WebPluginVisibility;
  override?: { target: string; mode: "replace" | "wrap" | "hide" };
}

type WebPluginPlacement =
  | { kind: "anchor"; anchor: WebUiAnchor; order?: number }
  | { kind: "region"; region: WebUiRegion; order?: number }
  | { kind: "overlay"; anchor?: WebUiAnchor; inset?: Partial<Record<"top" | "right" | "bottom" | "left", number>>; order?: number };
```

Initial anchors include `app.header`, `session.header`, `session.sidebar`, `chat.before`, `chat.after`, `chat.composer`, `chat.working`, `file-panel.header`, and `viewport.overlay`. Initial regions include `top`, `center`, `bottom`, `floating`, and `sidebar`. The list is versioned by the host and validated; plugins cannot invent an arbitrary DOM selector.

**R2.** `placement` replaces the current `surfaces`-only placement model but remains backward-compatible. Existing `slot` surfaces are normalized to equivalent region contributions during migration.

**R3.** Placement supports responsive constraints: minimum/maximum width and height, mobile fallback anchor, z-index class (`base`, `raised`, `overlay`), and collision behavior (`stack`, `shrink`, or `hide`). The host owns the final safe-area and viewport bounds.

**R4.** A plugin may declare an override only for an allowlisted component key. It must declare a fallback behavior and cannot override authentication, authorization, transport, session selection, or destructive-action confirmation components.

**R5.** Registry validation rejects unknown anchors, unknown component keys, invalid dimensions, duplicate contribution IDs, unsafe override targets, invalid priorities, and conflicting exclusive replacements. Errors name the plugin and contribution.

### 5.2 Component registry and override resolution

**R6.** pi-web exposes a typed component registry. Each host-controlled extension point has a stable key, version, input schema, and default renderer. Examples: `ui.working-indicator.v1`, `ui.extension-status.v1`, `ui.plugin-view.v1`, `ui.session-sidebar-row.v1`, `ui.chat-before.v1`, and `ui.floating-layer.v1`.

**R7.** Plugins override through descriptors and registered render strategies, never by importing internal `AppShell` components. The host resolves in this order: enabled user override, plugin `replace` by priority, plugin `wrap` chain by priority, then built-in renderer.

**R8.** A renderer receives an immutable, validated model and host callbacks with declared capabilities. It cannot read arbitrary session state, access `window` globals, inject HTML, or dispatch an undeclared command.

**R9.** Component failures are isolated. If an override throws, exceeds its render budget, or fails schema validation, pi-web records an error event, disables that contribution for the current session, and renders the built-in fallback.

**R10.** Component keys and input schemas are versioned. A major incompatibility disables the override with a visible developer diagnostic; it never silently renders stale props.

### 5.3 Event-driven UI state

**R11.** Define a versioned event envelope:

```ts
interface WebUiEvent<T = unknown> {
  version: 1;
  eventId: string;
  sessionId: string;
  source: "extension" | "host" | "browser";
  type: string;
  timestamp: number;
  payload: T;
}
```

All extension UI updates are normalized into this envelope. At minimum, support `ui.working.changed`, `ui.status.changed`, `ui.widget.changed`, `ui.custom.changed`, `ui.title.changed`, `ui.editor.changed`, `ui.view.changed`, `ui.session.lifecycle`, and `ui.plugin.action-requested`.

**R12.** The event bus is append-only from the producer perspective, typed, bounded, and asynchronous from the host perspective. Publishing must not block an agent turn. The host coalesces high-frequency visual events by `(sessionId, componentKey, sourceKey)` while preserving lifecycle and interaction events.

**R13.** Events are scoped to a hosted session and include source metadata. The browser receives a server-projected state snapshot plus SSE change notifications. The browser never publishes an extension event directly; browser actions use the existing authenticated action relay.

**R14.** Event ordering is monotonic per session and component. Reconnects replay from a revision/cursor or return a complete snapshot. Stale events cannot overwrite a newer state. Events older than the configured retention window are compacted into state.

**R15.** The host exposes a single subscription path for React components (`useWebUiState` or equivalent). Components must not independently poll `/api/plugins` or subscribe to separate per-plugin intervals.

### 5.4 Standard pi UI bridge

**R16.** Replace the current no-op web implementations of `setWorkingMessage`, `setWorkingVisible`, and `setWorkingIndicator` with event emission. The event payload preserves message text, visibility, frames, interval, and session identity after validation.

**R17.** Existing `setStatus`, `setWidget`, `custom`, `setTitle`, and editor events are migrated onto the same event envelope without changing their public pi semantics. Existing dialog response behavior remains intact.

**R18.** The built-in chat working indicator consumes `ui.working.changed` through the component registry. A plugin may replace its renderer or wrap it, but the default renderer remains available when no override is active.

**R19.** Bubbly Spinner becomes the reference implementation. Its `ctx.ui.setWorkingIndicator(BUBBLY_INDICATOR_OPTIONS)` and `ctx.ui.setWorkingMessage(...)` update the web working indicator. Its web descriptor may choose an alternate placement or renderer, but no host code may contain a Bubbly-specific conditional or duplicate status publication requirement.

**R20.** ANSI-colored values are normalized for the web: safe supported styling tokens may be represented as structured spans, while unsupported control sequences are stripped. Raw HTML and executable CSS are never accepted.

### 5.5 Freeform layout behavior

**R21.** The host provides a layout coordinator that mounts contributions at verified anchors and maintains stacking, ordering, responsive fallback, focus management, and pointer-event boundaries.

**R22.** `overlay` contributions may be visually freeform within the `viewport.overlay` or an approved anchor container. They must declare bounds, avoid protected UI zones, remain keyboard reachable, and expose a close/minimize affordance unless marked persistent by the host policy.

**R23.** Plugins can update placement at runtime only by publishing a validated `ui.layout.changed` event or through an explicitly declared configuration action. Layout changes are observable, revisioned, and reverted to the last valid placement on failure.

**R24.** Placement must work for multiple simultaneous sessions. A contribution must declare whether it is `session`, `project`, or `global` scoped. Session-scoped UI may not accidentally display the latest view from another session.

## 6. Architecture

```text
pi extension / ctx.ui API
          |
          v
  normalize + validate WebUiEvent
          |
          v
  session event bus -> host reducer/store -> revisioned snapshot + SSE
                                      |
                                      v
                         layout coordinator
                                      |
                 component registry + override resolver
                                      |
              built-in renderer or plugin renderer/wrapper
```

### Layers

1. **Contract:** pure TypeScript types, event schemas, anchor/component registry, placement validation, and capability definitions in `lib/web-plugins/`.
2. **Producer bridge:** pi-web's RPC/session adapter emits normalized events for every supported `ctx.ui` operation. Extensions remain unaware of React or Next.js.
3. **Host store:** one reducer applies events, tracks per-session state, revisions, cursors, diagnostics, and contribution health.
4. **Layout coordinator:** resolves descriptors into safe anchors/regions/overlays and renders contributions in deterministic order.
5. **Component registry:** resolves default, wrapped, replaced, and disabled renderers against versioned input models.
6. **Browser transport:** one API snapshot plus one SSE stream; React consumes a shared hook and never owns transport lifecycle per plugin.

## 7. Security and resilience

- Render all plugin text as text nodes or safe structured tokens; no `dangerouslySetInnerHTML`, arbitrary stylesheet text, script URL, or event-handler string.
- Validate event size, frequency, frame count, animation interval, dimensions, z-index, and nesting depth.
- Keep the existing loopback/password authentication boundary. Browser-originated actions remain authenticated, allowlisted, confirmed where required, audited, and relayed to the owning extension.
- Treat plugin events as untrusted even when produced by repository extensions; validate again at host and browser boundaries.
- Prevent clickjacking/overlay abuse with protected zones and pointer/focus rules.
- Add a per-plugin circuit breaker for repeated renderer errors and a host diagnostic panel for rejected events, disabled overrides, and placement conflicts.

## 8. Migration plan

| Phase | Deliverable | Done when |
| --- | --- | --- |
| 0 | Contract and registry | Types, schemas, anchors, component keys, and validation tests exist. |
| 1 | Event normalization | All currently supported extension UI requests become normalized events; no behavior regression. |
| 2 | Working UI bridge | `ctx.ui` working message/visibility/indicator are no longer no-ops; pi-web renders them in the default working component. |
| 3 | Shared store and transport | One revisioned store, one SSE channel, snapshot recovery, and `useWebUiState` replace per-plugin polling. |
| 4 | Layout coordinator | Existing top/center/bottom/floating surfaces are compatibility adapters over anchors/regions; freeform bounded overlays work. |
| 5 | Component overrides | At least working indicator, plugin view, extension status, and one sidebar/chat anchor support replace/wrap/hide with fallback. |
| 6 | Bubbly migration | Bubbly Spinner uses only standard `ctx.ui` events for its web working UI; remove the Bubbly-specific top-slot branch and duplicate status publication. |
| 7 | Plugin adoption | Dashboard, todo, artifacts, cache, and checkpoints migrate descriptors; e2e covers multiple sessions, placement changes, and an override. |

## 9. Acceptance criteria

- **AC1:** A test proves `setWorkingMessage`, `setWorkingVisible`, and `setWorkingIndicator` emit validated events and are not no-ops.
- **AC2:** A live/e2e test starts a hosted session, emits Bubbly's standard working UI calls, and observes the changed text/frames in pi-web without a page reload.
- **AC3:** No pi-web source contains a plugin-ID-specific renderer branch for Bubbly Spinner or another plugin.
- **AC4:** A fixture plugin places one contribution at `chat.composer`, one at `session.header`, and one bounded overlay; all render in the declared locations on desktop and mobile fallback.
- **AC5:** A fixture plugin replaces and wraps `ui.working-indicator.v1`; the resolver order is deterministic and the built-in renderer returns after disablement or failure.
- **AC6:** Two sessions publish different working messages and views; each selected session displays only its own scoped state.
- **AC7:** Reconnect/replay tests prove no event loss causes stale state and no out-of-order event overwrites newer state.
- **AC8:** Invalid anchors, dimensions, overrides, event payloads, markup, ANSI controls, and oversized/flooded updates are rejected with named diagnostics.
- **AC9:** Existing plugin slot/page e2e tests and pi-web's upstream suite remain green. Root `npm run tidy` remains green, with only the two documented baseline clipping failures permitted.
- **AC10:** The implementation and docs explain how an extension author registers a descriptor, chooses placement, overrides a component, and listens/emits through the event contract without editing pi-web core.

## 10. Observability and documentation

Record event rejection, dropped/coalesced event counts, active contribution count, placement conflicts, override resolution, renderer failures, circuit-breaker state, and event-to-paint latency. Add a developer-facing `/plugins` diagnostics view that is authenticated and disabled in production unless explicitly enabled.

Update `docs/pi-web.md`, `vendor/pi-web/VENDORED.md`, and the plugin author documentation with the event schema, anchor catalog, component registry, override rules, migration compatibility, and a complete Bubbly Spinner example.

## 11. Open decisions

1. Whether plugin renderers are declarative schemas only or a separately bundled, sandboxed component format. The first implementation should use host-owned renderers and structured models; arbitrary bundles are not required.
2. Whether user layout preferences should be stored globally, per project, or per session. The initial default is per browser user and per project, with descriptor defaults taking precedence only when no user choice exists.
3. Whether freeform overlay dragging is needed in the first release. The contract must support it later, but Phase 4 may ship descriptor-defined bounded positions first.
4. Which component keys are stable enough for public plugin use. The registry must mark keys as experimental until their schema and fallback behavior are tested.

## 12. Definition of done

The PRD is implemented when the event bridge, shared store, freeform layout coordinator, registry-based overrides, compatibility adapters, and Bubbly reference migration meet AC1–AC10; documentation and tests are committed; the working tree is clean; and the root verification gate passes.
