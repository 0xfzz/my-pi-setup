# PRD: Fork pi-web as the workflow web dashboard

> Part of [pi-workflow-extensions](../../README.md). Product requirements for a browser front end built on a fork of [agegr/pi-web](https://github.com/agegr/pi-web), with a plugin system so every workflow extension can contribute to it.

| Field | Value |
| --- | --- |
| **Status** | draft, Phase 0–1 in progress on `feat/pi-web-integration` |
| **Owner** | Faiz |
| **Upstream** | `agegr/pi-web` @ `main` (v0.15.0 at time of writing) |
| **Scope** | `lib/web-plugins/`, `web-plugins/`, the pi-web fork (new repo), reusing the existing `web/dashboard/`, `lib/dashboard/` and `extensions/dashboard.ts` as its base |
| **Acceptance** | pi-web's own Playwright suite (`e2e/`) must stay green on the fork, plus the new plugin contract tests |

## 1. Problem

The workflow in this repo (todo graph, delegation and checkpoints, artifacts, modes, cache stats, VCC, Antigravity routing) is operated almost entirely from the pi TUI. Two gaps follow:

1. **No full browser surface.** The existing `dashboard` extension is a read-only graph of delegated children and artifacts. It cannot browse sessions, resume a conversation from a browser, manage models and providers, or inspect files. pi-web already does all of that well.
2. **No general plugin seam for the web.** Each new workflow extension would need bespoke browser code. pi-web has no way for a pi extension to add a panel: its only browser hooks are a session-row context-menu event and a liveness registry. Without a seam, each extension author has to edit the web app.

The goal is a single browser UI, based on pi-web, in which every workflow extension appears by declaring itself to one plugin system, and nothing else needs to change.

## 2. Goals

- G1. **Use pi-web as the base.** Session workspace, Models, Files, Git, terminal and settings come from upstream. The fork tracks upstream and keeps its diff small.
- G2. **Stay compatible with the current workflow.** Sessions, `~/.pi/agent` config, extensions, delegation and the TUI keep working unchanged. Running the web UI must not change what the TUI does, and the TUI must not depend on the web UI being present.
- G3. **Pluggable by contract.** Adding a workflow extension means adding one descriptor file and one line in `web-plugins/index.ts`. The host renders it without any change to pi-web. A repository test fails if an extension is neither registered nor explicitly opted out.
- G4. **Safe by default.** Plugin output is data, never HTML or script. The browser never receives transcripts, terminal tails, or producer credentials beyond what pi-web already exposes.
- G5. **Reuse the existing dashboard as the base.** The fork builds on `web/dashboard/` and `lib/dashboard/` (wire contract, server, producer, lifecycle, browser shell, icons, build) instead of writing a second host. The dashboard keeps working throughout, and its graph becomes a plugin page.

## 3. Non-goals

- Replacing the pi TUI or its sidebar. The TUI stays the primary surface; the web UI is an additional view.
- Plugins that run arbitrary browser JavaScript or ship their own React components. Plugins describe views; the host renders them.
- Plugin-driven mutations (buttons that spawn agents, edit todos, or run shell commands) in Phase 1–2. Actions are a Phase 3 decision with its own trust review.
- A hosted or multi-user deployment. pi-web stays loopback-bound unless a password is set, as upstream documents.
- Upstreaming the workflow plugin system to agegr/pi-web. It may be proposed later.

## 4. Current state (grounded)

| Area | This repo (`pi-workflow-extensions`) | pi-web (`agegr/pi-web`) |
| --- | --- | --- |
| Runtime | pi extensions, loaded by pi through `package.json` → `pi.extensions` (21 files in `extensions/`) | Next.js 16 app that hosts pi `AgentSession`s in-process (`lib/rpc-manager.ts`) |
| Extension loading | Explicit list in `package.json`, pinned by `tests/extension-loader.test.ts` | Loads the same pi packages, so pi extensions already run inside the web server |
| Existing browser UI | `extensions/dashboard.ts` + `web/dashboard/` + `lib/dashboard/`: read-only graph, artifacts, loopback, separate producer and browser tokens | Full workspace: sessions, files, Git, models, MCP, skills, terminals |
| Existing event seam | `pi.events` channels `workflow-ui:section`, `workflow-ui:refresh`, `dashboard:*` | `window` event `pi-web:session-row-contextmenu`; `globalThis[Symbol.for("@agegr/pi-web/session-liveness/v1")]` |
| Sidebar sections | `offerSection()` in `lib/sidebar/sidebar-channel.ts` offers `todo`, `artifacts`, `mode`, `subagents`, `account`, `cache` to the TUI | Has its own sidebar; no section API |
| Trust model | Dashboard artifact HTML is not executable; no mutation endpoints | Password auth optional; Basic auth for API clients; loopback default |
| Tests | `npm run tidy` = typecheck + oxlint + `node --test` tiers (~87 suites) | `npm test` (node test over `lib/**`) + Playwright `e2e/run.mjs` (5,000-message fixtures, sidebar, models, themes, terminal) |

Consequences:

- pi-web already runs pi extensions. The plugin system does not need a second process; it needs a host that reads what extensions publish.
- The dashboard already has the hard parts of a host: a versioned wire protocol (`lib/dashboard/protocol.ts`), validation, a loopback server with separate producer and browser credentials, lifecycle and projection, and a built browser bundle. The fork reuses these rather than rebuilding them.
- The `workflow-ui:section` channel shows the pattern this repo already uses: extensions emit on `pi.events`, and a host decides how to show it. The web plugin system follows the same pattern, so extensions do not import pi-web code.

## 5. Users and stories

- **Operator (you)**: "I want to open the browser, see every session in every project, see the todo graph and the delegated children for a session, read the artifacts, and see cache health, without switching windows."
- **Extension author (you, later)**: "I add `extensions/foo.ts`. I want to write one file that says what the web should show for `foo`, and nothing else."
- **Reviewer of the fork**: "I want the fork's diff against upstream to be small, obvious and rebased cleanly."

## 6. Requirements

### 6.1 Plugin contract (`lib/web-plugins/`)

R1. A plugin is a descriptor with `id`, `extension`, `title` and at least one **surface**. `id` matches `^[a-z][a-z0-9-]*$`. `extension` must name an existing file `extensions/<extension>.ts`.

R2. Surfaces (Phase 1 set):
- `sidebar`: a titled section with a view, shown in the web sidebar. Mirrors `SidebarSection` so the same data can feed both the TUI and the web.
- `page`: a route `/plugins/<id>` (or a sub-path), with the title shown in navigation.

R3. Views are data. Phase 1 view types: `kv` (label/value rows), `list` (strings), `status` (tone plus one line). Each has size limits: at most 200 rows, 500 characters per cell, and a total of 64 KB serialised. Anything over the limit is truncated with a visible `…` marker, not dropped silently.

R4. Producers publish with one function, `publishWebView(pi, pluginId, view)`. It validates the view, emits on the `web-plugin:view` channel of `pi.events`, and never throws into the extension (a bad view is reported as a warning and skipped).

R5. The host keeps the last valid view per plugin. A plugin that has never published shows an empty state, not an error.

R6. Registry validation rejects, with a message naming the plugin: duplicate ids, duplicate page paths, unknown surface or view kinds, an unknown `extension`, and a plugin with zero surfaces.

### 6.2 Discovery and enforcement

R7. `web-plugins/index.ts` exports `WEB_PLUGINS` (the descriptors) and `WEB_PLUGIN_OPT_OUT` (`extension name → reason`). Every file in `extensions/` must appear in exactly one of them.

R8. A test (`tests/web-plugins.test.ts`) fails when:
- an extension file is in neither list, or in both;
- an opt-out names a file that does not exist (stale opt-outs are removed, not kept);
- a descriptor fails validation.

This is the "whenever I add an extension it calls the plugin system" guarantee. It fails the build; it does not rely on memory.

### 6.3 pi-web fork

R9. The fork is vendored inside this repository under `vendor/pi-web/` (decided), taken from upstream `main` (v0.15.0), with upstream kept as the reference remote for future syncs. It reuses the dashboard foundation (`lib/dashboard/`, `web/dashboard/`) and adds nothing parallel to it. Its diff against upstream is limited to:
- a plugin host built on `lib/dashboard/` (protocol, validation, producer): a loader that imports `WEB_PLUGINS` from this package, a subscription to `web-plugin:view` on each hosted session, and a store for last views;
- a sidebar section renderer and a generic `/plugins/[id]` page, built from `kv`, `list` and `status` only, using the dashboard's shell and renderers in `web/dashboard/src`;
- a navigation entry for each plugin page.

R10. The fork does not change pi-web's existing behaviour, routes, storage or settings. Its Playwright suite (`e2e/run.mjs`) must pass unchanged, plus one new e2e check for a plugin page.

R11. The fork keeps upstream's CLI (`pi-web`, `npx @agegr/pi-web`) working. Packaging the fork under a new name is a Phase 4 decision.

### 6.4 Compatibility with the current workflow

R12. The TUI is unaffected. `workflow-ui:section` and the existing `dashboard:*` events keep their shapes. `web-plugin:view` is a new channel and nothing listens to it in the TUI.

R13. The existing dashboard (`extensions/dashboard.ts`, `lib/dashboard/`, `web/dashboard/`) is the base of the fork, not a separate app to retire. Its delegation graph and artifact views become a `dashboard` plugin page. A parity test pins that the page shows the same children, handoffs, reviews and artifacts before the standalone route is removed.

R14. The web host does not start a second copy of any extension. It reads what the sessions it already hosts publish. A session that pi-web does not host (for example, a TUI session) is visible only through its persisted state, as upstream does now.

R15. Authentication is unchanged: pi-web's password and Basic auth gate the plugin pages too. Plugin views are never served to an unauthenticated client.

### 6.5 Non-functional

R16. A view publish is at most 64 KB and must not block the agent turn. Publishing is synchronous and cheap; the host coalesces updates.
R17. The plugin layer adds no runtime dependency to this package. The contract module is pure TypeScript with no pi or Next.js import, so it is loadable by both.
R18. Every new file passes `npm run tidy` (typecheck, oxlint with the smell gate, the tiered test runner).

R19. The dashboard's wire contract is not forked. Plugin views travel over the dashboard protocol in `lib/dashboard/protocol.ts`. `DASHBOARD_PROTOCOL` is bumped only when a shape the browser depends on changes, so an open tab from the previous version is rejected loudly rather than rendering stale data.

## 7. Architecture

```
  pi extension (any process)             pi-web fork (Next.js, loopback)
  ─────────────────────────              ───────────────────────────────
  extensions/foo.ts                      plugin host
     │  publishWebView(pi, "foo", view)     │ subscribes web-plugin:view per session
     ▼                                      ▼
  pi.events.emit("web-plugin:view") ──► validate (lib/web-plugins) ──► store (last view)
                                                                      │
  web-plugins/foo.ts  (descriptor) ──► WEB_PLUGINS ──► sidebar section + /plugins/foo page
```

- **Contract** (`lib/web-plugins/`): types, validation, registry, the publisher and the view limits. Pure TypeScript.
- **Descriptors** (`web-plugins/*.ts`): one per extension; declares surfaces only.
- **Index** (`web-plugins/index.ts`): the list the host imports and the list the enforcement test reads.
- **Host** (fork): reuses the dashboard foundation: `lib/dashboard/` for the wire contract, validation, producer and lifecycle, and `web/dashboard/` for the browser shell, renderers, icons and bundle. It loads the index, owns the store, and renders the three view types.

Why events and not direct calls: pi extensions run inside pi-web's process today, but a TUI session runs in a different process with no web host. An event on `pi.events` works in both, and it is the channel this repo already uses for the sidebar.

## 8. Phases

| Phase | Deliverable | Done when |
| --- | --- | --- |
| **0. PRD** | This document, branch `feat/pi-web-integration` | Committed; reviewed |
| **1. Contract** | `lib/web-plugins/`, `web-plugins/index.ts`, enforcement test, one reference descriptor (`cache-stats`), opt-outs for every other extension with a reason | `npm run tidy` green; the test fails when an extension is added without an entry |
| **2. Fork + host** | `vendor/pi-web/`: plugin host built on the reused `lib/dashboard/` and `web/dashboard/` foundation, sidebar section, `/plugins/[id]` page, one e2e check | Upstream e2e green; the cache section and page render from a real `publishWebView` call; no second copy of the dashboard protocol |
| **3. Port surfaces** | Descriptors for `todo`, `artifacts`, `subagent-checkpoints`; the dashboard graph becomes the `dashboard` plugin page | Dashboard parity test green; the graph and artifacts render from the plugin page with the same data |
| **4. Packaging** | Install docs, `pi-web-workflow` CLI or documented upstream install, update flow | A fresh machine can follow `docs/` and see the plugins |
| **5. Actions (optional)** | Trusted plugin actions with explicit confirmation | Separate PRD and threat review |

Phase 1 is the only phase in this branch's current scope. Phases 2–4 need the fork repository, which is a decision for you (see §10).

## 9. Acceptance criteria

- AC1. `npm run tidy` passes on the branch, with the two documented clipping failures as the only accepted baseline.
- AC2. Adding `extensions/x.ts` without a registry entry or opt-out fails `tests/web-plugins.test.ts` with a message naming `x`.
- AC3. A `kv`, `list` or `status` view over 200 rows or 64 KB is truncated, and the truncation is visible in the output.
- AC4. An invalid view (unknown type, non-string cell) is rejected with a warning and does not throw inside the publisher.
- AC5. Once the fork exists: upstream `e2e/run.mjs` passes unchanged, and a plugin page renders a published view.
- AC6. No plugin output reaches the browser as HTML or script. Verified by a test that a `<script>` cell renders as text.
- AC7. The fork imports the dashboard's protocol and producer from `lib/dashboard/`. A search finds no second definition of `DASHBOARD_PROTOCOL` or of the wire types in the fork.

## 10. Open questions and decisions

1. **Fork location (decided: vendored).** The fork lives at `vendor/pi-web/`, following the `vendor/antigravity/` precedent (`VENDORED.md` records provenance and how to resync). Builds stay out of git (`node_modules/`, `.next/`). Syncing a new upstream release means re-applying the fork diff, kept small per R9.
2. **Dashboard base (decided: reuse).** The fork reuses `web/dashboard/` and `lib/dashboard/`. Open: whether the fork's Next.js app mounts the dashboard's browser bundle as a route, or the dashboard server keeps its own port and the fork links to it. Decide in a Phase 2 spike.
3. **Actions in Phase 5.** Not decided. Needs a threat review before any plugin can mutate state from the browser.
4. **Upstream contribution.** Whether the `web-plugin` host should be proposed upstream. Not needed for the first version.

## 11. Risks

| Risk | Mitigation |
| --- | --- |
| Upstream moves fast (v0.15.0, many releases) and the fork drifts | Keep the diff to the plugin host; rebase on each upstream release; the e2e suite is the drift alarm |
| Event delivery differs between TUI and web sessions | Plugins publish the same view either way; the web host only reads what its own sessions emit (R14) |
| Plugin views become a back door for untrusted content | Views are data with fixed types and limits; no HTML rendering path exists (AC6) |
| An extension is added and nobody registers it | Enforcement test (R8, AC2) fails the build |
| Two dashboards disagree during the transition | Parity test before retirement (R13) |
| The dashboard server (`lib/dashboard/server.ts`, ~1,400 lines) is inherited with its loopback and token model | Reuse its auth and projection unchanged; any change must keep `tests/dashboard-*.test.ts` green; never widen its allow-list silently |
| Next.js build interferes with dev server (upstream AGENTS.md warns) | Phase 2 work happens in its own checkout; never run `next build` in the dev checkout |

## 12. Out of scope for this branch

- Re-applying the fork diff to newer upstream releases (Phase 4 maintenance).
- Any change to the TUI sidebar. `extensions/dashboard.ts`, `lib/dashboard/` and `web/dashboard/` are the fork's base, but are not modified in Phase 1.
- Descriptors for extensions other than the reference one (Phase 3). They are opted out with reasons until then.

## Related

- [Dashboard](../dashboard.md): the current read-only graph this plugin system will eventually subsume.
- [Sidebar](../sidebar.md): the TUI section channel that the web sidebar mirrors.
- [Verification](../verification.md): the suites the gate runs.
