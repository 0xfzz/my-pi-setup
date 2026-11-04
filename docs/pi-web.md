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

### Running the dev server

Start the Next.js development server from inside `vendor/pi-web`:

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

### What you see

Opening `http://127.0.0.1:30141` displays the main application shell with toolbar navigation and sidebar links to registered workflow plugin pages:

| Page Route | Plugin | Displays |
| --- | --- | --- |
| `/plugins/cache-stats` | Cache health | Prompt cache token savings, cache-control breakpoints, and hit/miss ratios |
| `/plugins/todo` | Intent graph | Active, claimed, and settled tasks with leases, dependencies, and verified evidence |
| `/plugins/artifacts` | Artifact catalog | Workspace plans, specifications, and scratchpads with metadata and text rendering |
| `/plugins/subagent-checkpoints` | Subagent checkpoints | Delegated worker milestones, active child tasks, and checkpoint history |
| `/plugins/dashboard` | Delegation dashboard | Parent and child agents, handoffs, reviews, and escalations (data parity with standalone dashboard) |

#### Read-only data presentation

Plugin views present structured data in three formats:
- **Key-Value (`kv`)**: Tabular property-value pairs (e.g., cache statistics).
- **List (`list`)**: Ordered items with primary labels, status chips, and metadata details.
- **Status (`status`)**: High-level badge indicators reflecting component state.

All cell contents and labels render as plain text nodes. HTML tags (such as `<script>alert('xss')</script>`) are never interpreted or executed as code. If a session has not published a view yet, or if an unauthenticated request is received, the page displays an empty state banner (`No view published yet`).

#### Plugin actions

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

- **Never run `next build` in a dev checkout**: Executing `npm run build` or `next build` inside `vendor/pi-web/` compiles production bundles into `.next/`, clobbering development server cache artifacts and causing runtime conflicts with active `next dev` instances. Always use `npm run dev` for local development.
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
  - Route availability and page titles for all five registered plugins (`cache-stats`, `todo`, `artifacts`, `subagent-checkpoints`, `dashboard`).
  - Home toolbar navigation.
- Dev server smoke test: HTTP `GET http://127.0.0.1:30141/api/plugins` and `GET http://127.0.0.1:30141/plugins/cache-stats` returning HTTP 200.

What these tests do **not** cover: They do not test production deployment behind a reverse proxy, public WAN routing, multi-user concurrency under remote network latency, or browser engines older than those listed in the prerequisites.

## Removal

To remove the vendored `pi-web` fork and revert to the standalone TUI and dashboard:

1. Remove the vendored directory:
   ```sh
   rm -rf vendor/pi-web
   ```
2. Delete this guide (`docs/pi-web.md`) and remove its row from the documentation table in `README.md`.

Dependency check: Grepping the codebase (`git grep vendor/pi-web`) confirms that no core extension in `extensions/` or library in `lib/` imports from `vendor/pi-web/`. The extensions publish views over the general `pi.events` bus, which silently drops events when no web listener is subscribed. The CLI, TUI, and core workflow features remain fully functional without the vendored fork.
