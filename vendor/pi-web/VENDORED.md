# Vendored: pi-web

Fork base for the workflow web dashboard, per
[`docs/prds/fork-pi-web-integration.md`](../../docs/prds/fork-pi-web-integration.md).

| Field | Value |
| --- | --- |
| **Upstream** | [agegr/pi-web](https://github.com/agegr/pi-web) @ `f130910` (v0.15.0, MIT) |
| **Vendored at** | source tree only: no `.git`, no `node_modules/`, no `.next/`, no `test-results/` |
| **License** | MIT (upstream `LICENSE` kept in place) |
| **Builds** | never committed: `vendor/pi-web/node_modules`, `vendor/pi-web/.next` stay out of git |
| **Smell gate** | this tree is upstream verbatim, so `lint-staged` ignores `vendor/pi-web/**` and `npm run lint:smell` does not scan it; upstream warnings are upstream's, and editing them away would break resync. New fork files written by us ARE held to the gate when touched in a commit that also touches our files — the ignore is per-path, not per-rule |

## Fork diff policy

The tree above is upstream verbatim. The fork diff (plugin host, sidebar section,
`/plugins/[id]` page, one e2e check) is added in commits after this one and must
stay limited to what the PRD's R9 allows. Keep every fork file listed here:

- `VENDORED.md` — provenance and resync documentation
- `lib/web-plugins-host.ts` — plugin view store on globalThis, monotonic revision counter, change notification subscriptions, session event subscription, action relaying, in-flight tracking, and test fixture seeding
- `lib/web-plugins-host.test.mjs` — unit tests for the plugin view store, revision tracking, change subscriptions, session subscription, action relay, and in-flight tracking
- `app/api/plugins/route.ts` — modified GET to return workflow plugins (including declared actions), views, and per-session running status derived from rpc-manager when called without `?cwd`, preserving package manager behavior
- `app/api/plugins/events/route.ts` — GET SSE endpoint streaming change notifications `{type:"changed",revision}` with 15s heartbeats on view recording
- `app/api/plugins/web-plugins-route.test.mjs` — route test verifying workflow plugins and views response
- `app/api/plugins/action/route.ts` — POST endpoint for trusted plugin actions with validation, byte-identical confirm check, in-flight concurrency lock, and audit logging
- `app/api/plugins/action/route.test.mjs` — route unit tests for action endpoint covering AC1, AC2, and AC3
- `app/plugins/[id]/page.tsx` — plugin detail page rendering latest view as plain text, session status markers, handling empty state, and reactive updates via `usePluginData`
- `components/plugins/PluginActions.tsx` — client component rendering confirmed action buttons without dialogs
- `components/plugins/PluginViewRenderer.tsx` — text-only renderer components for kv, list, and status views, `SessionStatusDot` component, and re-export of the shared `useWebUiState` hook as `usePluginData` for compatibility
- `components/plugins/PluginNav.tsx` — header and toolbar navigation links for page-enabled plugins
- `components/plugins/slots/SlotHost.tsx` — legacy slot API as a compatibility adapter over the shared layout coordinator; session-aware view resolution without cross-session borrowing
- `components/plugins/slots/TopSlotAdapter.tsx` — compact single-row top strip below header rendering descriptor-ordered plugin summaries and status chips
- `components/plugins/slots/BottomSlotAdapter.tsx` — compact single-row bottom strip above chat input rendering descriptor-ordered plugin summaries
- `components/plugins/slots/CenterSlotAdapter.tsx` — collapsible panel above chat area rendering descriptor-ordered plugin views
- `components/plugins/slots/FloatingSlotAdapter.tsx` — collapsible corner widget chip/card at bottom-right rendering descriptor-ordered plugin views
- `components/plugins/plugins.css` — styles for plugin detail pages, views, action components, slot regions, session status dots, and the shared web-ui anchor/overlay/working-indicator layout
- `components/AppShell.tsx` — additive sidebar toolbar navigation entry for page plugins and slot regions for top/bottom/center/floating surfaces, using shared `usePluginData` hook
- `components/SessionTree.tsx` — additive sidebar session running/idle dot marker next to session row sourced from `usePluginData` and upstream running state without changing row behaviour
- `e2e/web-plugins.mjs` — Playwright e2e test verifying kv rendering, XSS non-execution, empty state, dashboard action flow, slot regions, session status markers, unified ui snapshot working state, sidebar running marker, and realtime view push without page reload
- `e2e/run.mjs` — calls checkWebPlugins during e2e suite run
- `lib/rpc-manager.ts` — hook in registerRpcWrapper to attach web plugin listener on session creation; extension UI context projects `setWorkingMessage`/`setWorkingVisible`/`setWorkingIndicator` and all display requests into the unified session UI store instead of no-ops
- `lib/web-ui-bridge.test.mjs` — bridge test proving the RPC working methods emit validated working state with reset defaults (PRD AC1)
- `hooks/useWebUiState.ts` — shared reactive UI snapshot hook: validated snapshot adoption, single EventSource on `/api/plugins/events` with epoch/revision recovery, online refetch, named local diagnostics; the only transport owner
- `components/plugins/UiComponent.tsx` — registry-driven renderer: deterministic replace/wrap/hide resolution over validated immutable models, error boundaries disabling failed contributions back to the builtin renderer, host-owned strategies (default/compact/card), chat working indicator consuming `ui.working.changed`
- `components/plugins/PluginLayout.tsx` — layout coordinator: verified anchors (`app.header`, `session.*`, `chat.*`, `file-panel.header`, `viewport.overlay`) and legacy regions render validated contributions in declared order with bounded overlays, responsive mobile fallback, collision behavior, and session/project/global scoping
- `next.config.ts` — outputFileTracingRoot kept at configDir; agentRules disabled so next dev stops regenerating AGENTS.md; `turbopack.root` REMOVED: widening the watch root to the repo made Turbopack watch its own .next output, causing recompile/hot-reload loops under page traffic (outer contracts load via jiti at runtime instead)
- `proxy.ts` — matcher updated to include `/plugins/:path*` for password auth gating (R15)
- `tsconfig.json` — allowImportingTsExtensions: true to allow importing outer workflow contracts

## Known upstream test flakes

- `lib/mcp-host.integration.test.mjs` "a stdio server that cannot start is failed with what it wrote to
  stderr, masked" is load-dependent: under heavy parallel full-suite load it occasionally reports the
  spawn state as `connecting` instead of `failed` (~1 in 3 runs on this machine), while it passes
  consistently standalone. The file is upstream verbatim — rerun that file alone before diagnosing a
  full-suite failure. First observed at fork base v0.15.0.

## Resyncing a newer upstream

1. `git clone --depth 1 https://github.com/agegr/pi-web /tmp/pi-web` at the target tag.
2. `rsync -a --delete --exclude .git --exclude node_modules --exclude .next --exclude test-results /tmp/pi-web/ vendor/pi-web/`
3. Re-apply the fork diff from the file list above; conflicts mean the PRD's R9
   boundary leaked into upstream files — shrink the diff instead of growing it.
4. Run the upstream suite (`npm ci && npm test` in `vendor/pi-web`; `e2e/run.mjs`
   for the browser suite) and this repo's `npm run tidy`.
