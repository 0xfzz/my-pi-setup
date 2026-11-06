# Pi Web: vendored web UI operator guide

> Part of [pi-workflow-extensions](../README.md). Installation, local dev server, plugin views, trust boundaries, and update procedures for the vendored pi-web fork.

| Field | Value |
| --- | --- |
| **Status** | current operator guide |
| **Detail for** | [README § Documentation](../README.md) |
| **Scope** | `vendor/pi-web/`, `docs/pi-web.md` |
| **Verified against** | `tests/docs-consistency.test.ts`, `vendor/pi-web/e2e/web-plugins.mjs` |
| **Related** | [Dashboard](dashboard.md), [Fork PRD](prds/fork-pi-web-integration.md), [Plugin Actions PRD](prds/plugin-actions.md) |

- **What it is** — Operator guide for the vendored `pi-web` Next.js fork hosting workflow web plugin views and dashboard state.
- **Why it exists** — Provides a local web interface for inspecting cache statistics, todos, workspace artifacts, subagent checkpoints, and the delegation graph.
- **How it is enforced** — Pure TypeScript contracts in `lib/web-plugins/`, loopback-only Next.js server in `vendor/pi-web/`, and `tests/docs-consistency.test.ts`.
- **What it refuses** — Refuses non-loopback network exposure by default (127.0.0.1 only), unauthenticated access when `PI_WEB_PASSWORD` is configured, and browser-initiated state mutations.
- **What it cannot do** — Cannot run on Node < 22.19.0, cannot execute HTML or scripts inside plugin views, and cannot persist historical sessions without live Pi producers.

---

## Detail

The vendored `pi-web` fork (`vendor/pi-web/`) provides a local, web-based UI for monitoring Pi agent sessions and extensions. It extends upstream `@agegr/pi-web` with support for workflow web plugins while preserving upstream functionality and keeping the fork diff strictly bounded per [`docs/prds/fork-pi-web-integration.md`](prds/fork-pi-web-integration.md).

### Prerequisites

| Component | Minimum Version | Specified In |
| --- | --- | --- |
| Root repository (`pi-workflow-extensions`) | Node.js `>= 22.6.0` | `package.json` (`engines`) |
| Vendored fork (`vendor/pi-web`) | Node.js `>= 22.19.0` | `vendor/pi-web/package.json` (`engines`) |
| Supported browsers | Modern browser | Chrome >= 111, Edge >= 111, Firefox >= 111, Safari >= 16.2 |

The vendored Next.js application requires Node.js `>= 22.19.0`. Ensure your local environment meets this requirement before running the web interface.

### One-time installation

Install dependencies in the root repository first, then install the vendored fork's dependencies:

```sh
# 1. Root repository dependencies and git hooks
npm install

# 2. Vendored pi-web fork dependencies (clean, locked install)
cd vendor/pi-web
npm ci
cd ../..
```

Build outputs (`vendor/pi-web/.next`) and installed packages (`vendor/pi-web/node_modules`) are excluded from version control and must never be committed.

### Serving the build (default)

`/web start` serves the **production build**, not the dev server. It runs the fork's `next build` when there is no build output to serve (or when `/web start --rebuild` is passed), then launches `next start` detached on the loopback interface. A fresh checkout pays the build cost once; later starts reuse `vendor/pi-web/.next/BUILD_ID`.

Build output and dev cache are separate (`\.next/` for the production build, `.next/dev/` for the dev server), but never run a build while a dev server is serving: `/web start` refuses to start when an instance is already healthy, and a manual `npm run build` under a live dev server can still disrupt it.

### Running the dev server

Development mode remains available for working on the fork itself. Start the Next.js development server from inside `vendor/pi-web`:

```sh
cd vendor/pi-web
npm run dev
```

The server binds strictly to the loopback interface on port `30141`:

```text
▲ Next.js 16.4.4
- Local:        http://127.0.0.1:30141
- Network:      (disabled by default)
```

To allow access across a trusted local area network, use `npm run dev:lan`, which binds to `0.0.0.0:30141`. LAN access exposes session views to any host on your subnet; use only on trusted private networks.

### Single-UI decision

The vendored `pi-web` fork (`vendor/pi-web`) is the unified web interface for workflow extensions. To prevent redundant web servers and port confusion, the old standalone dashboard HTTP server (`lib/dashboard/server.ts`, port 9177) is opt-in (`PI_DASHBOARD_SERVER=1`) and disabled by default. The dashboard extension continues publishing its live delegation views directly into `pi-web` via `publishWebView`, preserving complete data parity.

### Process management via `/web`

The `/web` command manages the detached `pi-web` server lifecycle directly from within Pi sessions:

```text
/web start   - Build if needed, then serve the production build; denies if an instance is already healthy
/web start --rebuild - Force a fresh production build before serving
/web stop    - Stop the managed instance, or provide manual pkill instructions if unmanaged
/web status  - Report health, URL, owner session, start timestamp, and state file agreement
```

#### `/web start` decision rules
- **Single-instance denial (managed)**: If loopback health (`GET http://127.0.0.1:30141/api/plugins`) returns HTTP 200 and a valid state file exists (`<agent dir>/web-ui-state.json`), startup is denied with a refusal notice identifying who started it (`startedBy`), when (`startedAt`), and the active URL. No duplicate instance is spawned.
- **Single-instance denial (unmanaged)**: If the health check passes but the state file is missing or corrupt, startup is denied as an unmanaged instance (still serving, but owner cannot be attributed).
- **Stale takeover**: If a state file exists but the health check fails, the stale state file is removed and a fresh instance takes over.
- **Production serve**: When starting, `pi-web` first checks for build output (`vendor/pi-web/.next/BUILD_ID`). If it is missing — or `--rebuild` was passed — it runs the fork's production build and, if that build fails, reports the build error and starts nothing. It then spawns detached from `vendor/pi-web` (`node_modules/next/dist/bin/next start -H 127.0.0.1 -p 30141`) so the server survives the Pi process. It polls health for up to 30 seconds; upon readiness, it writes the state file (`{pid, port, url, startedBy, startedAt}`) and reports the URL. On timeout, the spawned PID is killed and cleaned up. If `vendor/pi-web` is missing, it refuses with `"fork not vendored"`.

#### `/web stop` rules
- **Managed shutdown**: If the state file has a live PID, it sends `SIGTERM` (`process.kill(pid)`), deletes the state file, and confirms stoppage.
- **Unmanaged notice**: If the server is healthy but unmanaged (no state file or dead PID in state), it prunes any stale file and instructs the user to kill it manually with the exact command:
  ```sh
  pkill -f "next.*30141"
  ```
- **Not running**: If the server is not responding and no live PID exists, it confirms `pi-web` is not running.

#### `/web status` rules
- Inspects health and the state file, reporting whether the server is serving, who started it, when it started, its URL, and whether the state file matches reality.

### What you see

Opening `http://127.0.0.1:30141` displays the main application shell with toolbar navigation, sidebar links, and workflow plugin views placed in frontend slots:

| Placement | Plugin | Displays |
| --- | --- | --- |
| Top strip | Cache health | Prompt cache token savings, hit/miss ratios (compact row) |
| Top strip | Intent graph | Active, claimed, and settled tasks (compact row) |
| Chat working indicator | Any extension (e.g. Bubbly spinner) | `ctx.ui.setWorkingMessage` / `setWorkingIndicator` state rendered through the unified UI event stream |
| Center panel | Subagent checkpoints | Delegated worker milestones and checkpoint history (collapsible) |
| Floating widget | Artifact catalog | Plans, specifications, and scratchpads (collapsible corner card) |
| Bottom strip | Cache health | Compact summary row above the chat input |
| Page `/plugins/dashboard` | Delegation dashboard | Parent/child agents, handoffs, reviews, escalations — the settings/whole-pi surface (data parity with standalone dashboard) |

#### Read-only data presentation

Plugin views present structured data in three formats:
- **Key-Value (`kv`)**: Tabular property-value pairs (e.g., cache statistics).
- **List (`list`)**: Ordered items with primary labels, status chips, and metadata details.
- **Status (`status`)**: High-level badge indicators reflecting component state.

All cell contents and labels render as plain text nodes. HTML tags (such as `<script>alert('xss')</script>`) are never interpreted or executed as code. If a session has not published a view yet, or if an unauthenticated request is received, the page displays an empty state banner (`No view published yet`).

#### Realtime updates

Plugin data updates are push-based using Server-Sent Events (SSE). The server exposes `GET /api/plugins/events` streaming `{type:"changed",revision}` notifications whenever any plugin view is recorded or updated. The host store maintains a monotonically increasing revision counter and immediately pushes events to connected browser clients, including 15-second `: ping` heartbeats to maintain connectivity through proxies.

Clients consume a single shared `usePluginData` reactive hook that subscribes to `/api/plugins/events` via browser-native `EventSource`. When a `"changed"` event is received, the client deduplicates in-flight fetches and re-queries `/api/plugins`. If the EventSource encounters repeated connection failures, it automatically falls back to slow 30-second polling until connectivity is restored.

#### Session status markers

The `GET /api/plugins` endpoint provides an authoritative snapshot of session execution states sourced from pi-web's session registry (`rpc-manager`). For each session present in the views store, the API reports `{ running: boolean; awaitingInput?: boolean }`. Sessions without active registry processes strictly report idle (never inferred or guessed).

The UI renders visual status markers next to session-scoped views and sidebar rows:
- **Running session**: Green status dot (`.plugin-status-dot.plugin-status-running`) indicating an active agent turn or background task.
- **Idle session**: Muted gray status dot (`.plugin-status-dot.plugin-status-idle`) indicating a settled or inactive session.

Status markers are rendered in all slot adapters (top/bottom single-row strips, center panels, and floating widget chips), beside the session identifier on plugin detail pages (`/plugins/[id]`), and next to each session in the left sidebar list (`SessionRowView` in `SessionTree.tsx`). The text-only rule strictly applies to view contents; status markers are rendered as styled UI indicators separate from view payload text.

#### Unified UI event stream and declarative placement

All standard `ctx.ui` display calls (`setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator`, `setStatus`, `setWidget`, `setTitle`, editor text, custom panels) are normalized into validated, session-scoped `WebUiEvent` envelopes in `lib/web-plugins/ui-events.ts` and applied by a bounded, revisioned store in `lib/web-plugins/ui-store.ts`. ANSI/OSC control sequences are stripped to structured plain text; markup, script URLs, oversized or flooded payloads are rejected with named diagnostics recorded in the snapshot's `diagnostics` and `metrics` fields. State is asynchronous from the producer's perspective (publishing never blocks an agent turn) and coalesced per session/component/source with monotonic ordering, retention, and snapshot recovery by `epoch`/`revision` over the single SSE channel.

The browser consumes one snapshot plus one SSE stream through `hooks/useWebUiState.ts`. The chat's working indicator renders `ui.working.changed` through the component registry (`components/plugins/UiComponent.tsx`); the layout coordinator (`components/plugins/PluginLayout.tsx`) mounts descriptor contributions at verified anchors (`app.header`, `session.header`, `session.sidebar`, `chat.before`, `chat.after`, `chat.composer`, `chat.working`, `file-panel.header`, `viewport.overlay`) or legacy regions (`top`, `center`, `bottom`, `floating`, `sidebar`), honoring declared order, responsive bounds, mobile fallback, z-index class, collision behavior, and `session`/`project`/`global` scoping. A selected session only ever shows its own state. Runtime placement updates arrive as validated `ui.layout.changed` events for declared contributions and revert to the last valid placement on failure.

Plugins declare UI through the optional `ui` field on their descriptor (`WebPluginUiContribution` in `lib/web-plugins/ui-contract.ts`): a stable component key (e.g. `ui.working-indicator.v1`), an optional view key, a validated placement, an explicit scope, and — only for allowlisted components — an override with `replace`/`wrap`/`hide` mode and a `builtin` fallback. Resolution is deterministic (enabled user choice, then highest-priority replacement, then wrapper chain, then the built-in renderer); a renderer that throws or exceeds its render budget is disabled for that session and the built-in renderer returns. Legacy `slot` surfaces remain supported and are normalized into equivalent region contributions. Host code never branches on a plugin id (enforced by test).

Bubbly Spinner is the reference implementation: it calls only the standard `ctx.ui.setWorkingIndicator`/`setWorkingMessage`, which reach the web working indicator through the event stream; its descriptor wraps `ui.working-indicator.v1` with a compact strategy instead of publishing a duplicate status view.

#### Plugin actions

The dashboard plugin ships one trusted, read-only action — **Request fresh snapshot** — rendered on `/plugins/dashboard`. Submitting it requires typing the exact confirmation string (`request sync`); the fork validates it server-side (403 otherwise), enforces one in-flight action per session, and relays a single-use, audited request to the owning extension over the session event bus. The web server never executes anything itself: the extension re-checks the request and republishes its view through the normal channel. Other plugins ship no actions, and mutation actions are out of scope pending a follow-up PRD. The contract and threat review live in [`docs/prds/plugin-actions.md`](prds/plugin-actions.md).

### Updating and resyncing

The vendored fork tracks upstream `agegr/pi-web` releases. Provenance and fork diff records are maintained in [`vendor/pi-web/VENDORED.md`](../vendor/pi-web/VENDORED.md). To resync with a newer upstream release:

```sh
# 1. Clone target upstream tag into temporary directory
git clone --depth 1 https://github.com/agegr/pi-web /tmp/pi-web

# 2. Synchronize sources while preserving ignored build directories
rsync -a --delete --exclude .git --exclude node_modules --exclude .next --exclude test-results /tmp/pi-web/ vendor/pi-web/

# 3. Re-apply fork diff files listed in vendor/pi-web/VENDORED.md
# (lib/web-plugins-host.ts, app/plugins/[id]/page.tsx, components/plugins/, etc.)

# 4. Install dependencies and run tests in vendor/pi-web
cd vendor/pi-web
npm ci
npm test
node e2e/web-plugins.mjs
cd ../..

# 5. Run root verification gate
npm run tidy
```

### Trust bounds and security model

1. **Loopback binding**: The development server defaults to `127.0.0.1:30141`. Loopback isolation prevents unauthorized incoming connections from local network peers.
2. **Password authentication**: If the `PI_WEB_PASSWORD` environment variable is defined, HTTP Basic authentication is required for all routes. The Next.js middleware in `vendor/pi-web/proxy.ts` gates `/plugins/:path*` and `/api/plugins` under this authentication perimeter.
3. **No mutation endpoints**: There are no HTTP endpoints that accept write payloads to modify agent execution, file systems, or workflow state. Views are unidirectional projections pushed over `pi.events` from extension code running in the Pi process.
4. **Content escaping**: Plugin view renderers enforce strict string coercion and text node rendering, preventing XSS injection even if an untrusted agent session emits markup payloads.

### Troubleshooting

- **Separate build and dev artifacts**: `/web start` serves a production build and writes it to `vendor/pi-web/.next/`; the dev server writes its own cache under `.next/dev/`. Do not run a build while a dev server is serving — stop the dev server first, or use `/web start` (which refuses when an instance is already healthy) so the two modes never overlap. If a build fails, `/web start` reports the compiler output tail and starts no server.
- **`.next/dev/lock` contention**: If a previous development server was terminated abruptly (e.g., `kill -9`), Next.js may leave a stale lock file at `vendor/pi-web/.next/dev/lock`. If the dev server or E2E runner refuses to start with lock contention errors, verify that no `next dev` process is running (`pgrep -f "next dev"`), then remove the lock file:
  ```sh
  rm -f vendor/pi-web/.next/dev/lock
  ```
- **Upstream MCP test flake**: Upstream suite test `lib/mcp-host.integration.test.mjs` ("a stdio server that cannot start is failed with what it wrote to stderr, masked") can occasionally report `connecting` instead of `failed` when running under high parallel CPU contention. As documented in `vendor/pi-web/VENDORED.md`, this is an upstream timing flake. Run the test isolated if a full-suite run reports this failure:
  ```sh
  cd vendor/pi-web
  node --experimental-strip-types --test lib/mcp-host.integration.test.mjs
  ```

## Tests

Documentation consistency and plugin host behavior are covered by the following test suites:

- [`tests/docs-consistency.test.ts`](../tests/docs-consistency.test.ts): Verifies that `docs/pi-web.md` is indexed in `README.md`, contains the required `Part-of` header, and that all relative links resolve.
- [`vendor/pi-web/e2e/web-plugins.mjs`](../vendor/pi-web/e2e/web-plugins.mjs): Standalone Playwright E2E suite verifying:
  - KV table rendering and label display.
  - XSS script payload rendering as inert plain text (AC6).
  - Empty state handling for unpublished sessions.
  - Slot placement rendering for all five registered plugins (top/center/floating/bottom on the home view; dashboard on its page).
  - Home toolbar navigation.
- Dev server smoke test: HTTP `GET http://127.0.0.1:30141/api/plugins` and `GET http://127.0.0.1:30141/plugins/dashboard` returning HTTP 200.

What these tests do **not** cover: They do not test production deployment behind a reverse proxy, public WAN routing, multi-user concurrency under remote network latency, or browser engines older than those listed in the prerequisites.

## Removal

To remove the vendored `pi-web` fork and revert to the standalone TUI and dashboard:

1. Remove the vendored directory:
   ```sh
   rm -rf vendor/pi-web
   ```
2. Delete this guide (`docs/pi-web.md`) and remove its row from the documentation table in `README.md`.

Dependency check: Grepping the codebase (`git grep vendor/pi-web`) confirms that no core extension in `extensions/` or library in `lib/` imports from `vendor/pi-web/`. The extensions publish views over the general `pi.events` bus, which silently drops events when no web listener is subscribed. The CLI, TUI, and core workflow features remain fully functional without the vendored fork.
