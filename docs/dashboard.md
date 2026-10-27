# Orchestrator web dashboard

> Part of [pi-workflow-extensions](../README.md). The live graph, artifact views, server bounds and trust model.

| Field | Value |
| --- | --- |
| **Status** | current operator guide |
| **Detail for** | [README § Orchestrator web dashboard](../README.md) |
| **Scope** | `web/dashboard/`, `extensions/dashboard.ts`, `lib/dashboard/` |
| **Verified against** | `tests/dashboard-*.test.ts`, `tests/dashboard-host-runtime.test.ts` |
| **Related** | [Orchestrator](orchestrator.md) |

## Summary

- A local, read-only view of the orchestrator graph, its workers and the workspace artifacts.
- One detached server per OS user; later sessions join the same page instead of starting another.
- Loopback only, separate producer/browser credentials, no mutation endpoints, projection allowlist (no transcripts, paths or tails).
- Delivery is best-effort and coalesced, so a dead browser cannot block orchestration.

A local, read-only dashboard for the orchestrator, its subagents, and workspace artifacts.

## Start

Install the package dependencies and build the local browser assets:

```sh
npm install
npm run build:dashboard
```

Reload Pi after updating this package, then enter `/mode orchestrator` (or cycle to Orchestrator with Shift+Tab). Pi displays a dashboard URL. Open that URL in a browser on the same machine.

The first parent session starts a separate background server. Later parent sessions reuse that server and appear in its left sidebar—even when they are separate Pi processes or projects. Selecting a new session is explicit: a newly registered session does not steal the current selection.

The URL authorizes access to local session data. Treat it as private. The browser exchanges its access token for an HTTP-only, same-site cookie; producer authentication is separate and is never included in dashboard state.

The dashboard is not started merely by loading the extension. A refused mode switch and a delegated child session do not start a top-level dashboard entry. An already-Orchestrator session reconnects on resume/reload.

## What you can see

- Parent orchestrator, workers/reviewers, handoffs, and explicit review/escalation relationships.
- The session's **current goal** as its title. The graph root appends `Manager`
  (`Dashboard polish Manager`); the sidebar and topbar show the goal alone and the
  project stays in secondary metadata. Set or change it with the `session_goal`
  tool, `/session-goal <title>`, or Pi's `/name`; it publishes live and persists on
  the active branch. Replacing a todo plan, claiming a task, finishing a review or
  a child session never retitles the parent. The first owned committed plan seeds
  the title once when none exists; internal verification plans cannot overwrite it.
- Observed worker statuses, scope, task, lane files, milestones, budgets, and known artifact associations.
- Distinct producer connection health and last observed worker state. Disconnecting a parent does **not** imply that a worker succeeded or stopped.
- Workspace artifact catalog and safe rendered Markdown/code, metadata, versions, raw view, and live changes.

Relationships come from recorded identifiers, not matching names. Artifact visibility follows the parent session's effective catalog, including scoped-spec sidecars and ingested child artifacts. Changing the selected branch changes the published catalog; abandoned branch entries are not treated as current.

## Lifecycle

Leaving Orchestrator mode updates the displayed mode but retains observation of existing work. Closing the Pi process disconnects its producer, not other sessions' server. The last observed data can remain visible as disconnected.

The server is independent of the first Pi process. Live producers reconnect and republish full state after a server restart. The server shuts down after an idle grace period when there are no live producers or connected browser streams.

This is a current-state viewer, not a durable history database. Offline/disconnected sessions are subject to bounded retention; server restarts do not promise historical session recovery.

## Read-only and local-only

There are no browser actions for spawning, steering, stopping agents, running shell commands, editing artifacts, or browsing arbitrary files. The server binds to loopback and validates local browser requests. Remote access is intentionally unsupported.

Artifact HTML is not executable. Remote embedded resources are restricted, and graph labels/SVG are treated as untrusted. Raw terminal tails, full transcripts, and producer credentials are not part of the dashboard protocol.

All browser libraries and Graphviz WASM are served locally after the build. No native Graphviz installation or CDN is required.

## Development

```sh
npm run build:dashboard
node --experimental-strip-types --import ./tests/isolate-env.mjs --test tests/dashboard-*.test.ts
npm run typecheck
```

Implementation is split between `lib/dashboard/` (protocol, server, lifecycle, transport, projection), `extensions/dashboard.ts` and the mode/orchestrator/artifact publishers, and `web/dashboard/` (browser UI).

`tests/fixtures/dashboard-browser-fixture.ts` supplies explicitly synthetic sessions for manual browser verification; it is never loaded by production extensions. Use a private temporary directory when running it. Its control file changes only fixture state.

Dashboard delivery is best-effort: a slow browser or failed server must not block orchestration. Snapshots are coalesced and bounded, and reconnects recover through a complete replacement snapshot rather than an unbounded event log.
