# Delegated-work subagent graph

> Part of [pi-workflow-extensions](../README.md). The live graph, artifact views, server bounds and trust model.

| Field | Value |
| --- | --- |
| **Status** | current operator guide |
| **Detail for** | [README § Delegated-work subagent graph](../README.md) |
| **Scope** | `web/plugins/subagent-graph/app/`, `extensions/subagent-graph.ts`, `web/plugins/subagent-graph/lib/` |
| **Verified against** | `tests/subagent-graph-*.test.ts`, `tests/subagent-graph-host-runtime.test.ts` |
| **Related** | [Delegation](delegation.md) |

## Summary

- A local, read-only view of the parent session's graph, its child agents and the workspace artifacts.
- Standalone server is **opt-in** (`PI_SUBAGENT_GRAPH_SERVER=1`); by default, only web plugin views are published to `pi-web`.
- One detached server per OS user when enabled; later sessions join the same page instead of starting another.
- Loopback only, separate producer/browser credentials, no mutation endpoints, projection allowlist (no transcripts, paths or tails).
- Delivery is best-effort and coalesced, so a dead browser cannot block orchestration.

A local, read-only graph of the parent session, its child agents, and workspace artifacts.

## Standalone server opt-in

By default, the standalone subagent graph server does **not** start. Under the single-UI architecture, the vendored `pi-web` fork is the primary web interface, and the subagent-graph extension publishes its delegation graph snapshot directly as web plugin views (see [`docs/pi-web.md`](pi-web.md)).

To run the standalone subagent graph server on port `9177`:

```sh
export PI_SUBAGENT_GRAPH_SERVER=1
```

When `PI_SUBAGENT_GRAPH_SERVER=1` (or `options.server: true`) is configured, the first delegated child launches the standalone background server and Pi displays the subagent-graph URL as before. Regardless of whether the standalone server is enabled, web plugin views continue to publish seamlessly.

## Start (standalone server)

Install the package dependencies and build the local browser assets:

```sh
npm install
npm run build:subagent-graph
```

Reload Pi after updating this package, then delegate work with `agent_spawn`. Pi displays a subagent graph URL the first time a child is registered. Open that URL in a browser on the same machine.

The first parent session starts a separate background server. Later parent sessions reuse that server and appear in its left sidebar—even when they are separate Pi processes or projects. Selecting a new session is explicit: a newly registered session does not steal the current selection.

The URL authorizes access to local session data. Treat it as private. The browser exchanges its access token for an HTTP-only, same-site cookie; producer authentication is separate and is never included in subagent graph state.

The graph server is not started merely by loading the extension: the first delegated child starts it, and a refused spawn starts nothing. A session that already published reconnects on resume/reload.

## What you can see

- The parent agent, its child agents, handoffs, and explicit review/escalation relationships.
- The session's **current goal** as its title. The graph root appends `Manager`
  (`SubagentGraph polish Manager`); the sidebar and topbar show the goal alone and the
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

Switching mode updates the displayed mode but retains observation of existing work. Closing the Pi process disconnects its producer, not other sessions' server. The last observed data can remain visible as disconnected.

The server is independent of the first Pi process. Live producers reconnect and republish full state after a server restart. The server shuts down after an idle grace period when there are no live producers or connected browser streams.

Browser events use `@fastify/sse` with the graph's own client/buffer caps and notification debounce. The first `changed` data frame also carries `retry: 2000`; subsequent keepalives are the library's `: heartbeat` comments at the configured ping interval (zero disables them). Data events remain unnamed JSON. Disconnect and shutdown release the channel through the plugin lifecycle; a slow consumer is disconnected rather than given an unbounded queue.

The HTTP host is Fastify with native routes, cookie/Helmet policy and request schemas. Request ids are always assigned and structured `warn`-level logs go to the runtime's log file (the server's stdout is ignored when detached). The request serializer drops the query string, so a `/bootstrap?token=…` value never reaches the log. The bootstrap token is single-use: once it mints a browser cookie, replaying the URL fails with 403.

This is a current-state viewer, not a durable history database. Offline/disconnected sessions are subject to bounded retention; server restarts do not promise historical session recovery.

## Read-only and local-only

There are no browser actions for spawning, steering, stopping agents, running shell commands, editing artifacts, or browsing arbitrary files. The server binds to loopback and validates local browser requests. Remote access is intentionally unsupported.

Artifact HTML is not executable. Remote embedded resources are restricted, and graph labels/SVG are treated as untrusted. Raw terminal tails, full transcripts, and producer credentials are not part of the subagent graph protocol.

All browser libraries and Graphviz WASM are served locally after the build. No native Graphviz installation or CDN is required. `@fastify/static` serves the root index (falling back to `dist/index.html`) and the `/assets/`/`/dist/` aliases, retaining the graph's extension allowlist, realpath containment, GET/HEAD behavior and HTML-only CSP. Missing builds show the local placeholder; dotfiles and noncanonical traversal paths are rejected instead of normalized into an index request.

## Development

```sh
npm run build:subagent-graph
node --experimental-strip-types --import ./tests/isolate-env.mjs --test tests/subagent-graph-*.test.ts
npm run typecheck
```

Implementation is split between `web/plugins/subagent-graph/lib/` (protocol, server, lifecycle, transport, projection), `extensions/subagent-graph.ts` and the mode/delegation/artifact publishers, and `web/plugins/subagent-graph/app/` (browser UI).

`tests/fixtures/subagent-graph-browser-fixture.ts` supplies explicitly synthetic sessions for manual browser verification; it is never loaded by production extensions. Use a private temporary directory when running it. Its control file changes only fixture state.

SubagentGraph delivery is best-effort: a slow browser or failed server must not block orchestration. Snapshots are coalesced and bounded, and reconnects recover through a complete replacement snapshot rather than an unbounded event log.
