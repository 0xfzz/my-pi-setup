# PRD: Realtime session directory (kill the `/api/sessions` poll)

> Part of [pi-workflow-extensions](../../README.md). Replaces the left sidebar's 2-second HTTP poll of the session list with one push stream of running/idle transitions and membership changes, so a running dot reacts on the event instead of on the next poll tick.

| Field | Value |
| --- | --- |
| **Status** | draft |
| **Owner** | Faiz |
| **Parent** | [minimal-pi-web](minimal-pi-web.md) (the `web/` client), [pi-web-pluggable-ui](pi-web-pluggable-ui.md) (plugin surfaces) |
| **Scope** | `web/server/` (directory emitter + SSE route), `web/client/use-session.ts` (replace the poll), `web/server/*.test.ts` |

## 1. Problem

`web/client/use-session.ts` refreshes the session list every 2000 ms:

```ts
const timer = setInterval(() => void refreshSessions(), 2000);  // GET /api/sessions
```

That is 30 requests/minute, and a running/idle dot can lag a real transition by up to 2 s. The poll exists only because the sidebar shows state for **every** session while the realtime channel (`GET /api/agent/:id/events`) is **per selected session** — unfocused sessions have no stream, so their `running` flag can only be learned by asking.

This is the wrong trade. `running` is already derivable from lifecycle events the server sees (`agent_start` / `agent_settled` / `session_shutdown`), so it can be pushed the moment it changes instead of being re-read.

## 2. Goal

One long-lived stream that carries the session list as **transitions**, not snapshots:

- **G1. No polling.** Remove the `setInterval` on `/api/sessions`; the list self-heals via stream reconnect (the same model the per-agent stream already uses).
- **G2. Transitions only.** Push `running`/`idle` flips, session added, and session removed. The full list is sent once on connect, then only deltas.
- **G3. Same transport discipline.** Reuse the existing SSE skeleton: 30 s heartbeat (`AGENT_EVENT_HEARTBEAT_MS`), droppable high-water-mark and backlog-limit guards, cleanup on `req`/`res` close.
- **G4. Two states, event-driven.** `running` flips on `agent_start`; `idle` flips on `agent_settled`/`session_shutdown`. A running tool call (bash, waiting for a tool result) stays `running` for the whole turn — this is pi's own `isStreaming` semantics, not something the directory re-derives.

## 3. Non-goals

- Transcript, plugin views, model/context state over this stream — those stay on the per-selected-session stream.
- On-disk membership watching via `fs.watch`. Disk-only sessions are always `running: false`; their appearance/deletion is learned from the initial snapshot and stream reconnect. (Revisit with `fs.watch` only if a real workflow needs instant cross-process discovery of new files.)
- Changing how `/api/sessions` computes `running` for live sessions (`core.getState().isStreaming` stays the truth).

## 4. Design

### 4.1 Server: a directory emitter

In `web/server/sessions.ts`, add a small subscription surface independent of browser streams:

```ts
export type SessionDirectoryEvent =
  | { type: "session_running"; id: string; running: boolean }
  | { type: "session_added"; session: SessionInfo }
  | { type: "session_removed"; id: string };

export function subscribeSessionDirectory(listener): () => void;
```

Hooks:

- On **register** (`register()`), emit `session_added` (including the replace path) and seed the running bit from `core.getState().isStreaming`.
- On **unregister/dispose** (`unregisterSession()`, `core.dispose()`), emit `session_removed`.
- On **lifecycle events**, tap `core.subscribe` once per live session — not once per browser stream — and emit `session_running` only when the running state flips:
  - `agent_start` → `running: true`
  - `agent_settled` → `running: false`
  - `session_shutdown` → `running: false` + `session_removed`

The tap is per-*session*, registered once in `register()`. It is cheap and bounded: one subscription per live session, transition-only emissions. Bridged (TUI-owned) sessions get the same treatment through the existing bridge core, whose `agent_start`/`agent_settled` forwarding already feeds `session_state`.

### 4.2 Server: the stream

New `GET /api/sessions/events` → `attachSessionsEventStream(req, res)` in `web/server/event-stream.ts` (or a sibling `session-directory-stream.ts`):

- Same `writeHead` + `text/event-stream` preamble as `attachAgentEventStream`.
- On connect: `{ type: "sessions_snapshot", sessions }` with the exact `/api/sessions` body (`listLiveSessions()` + deduped `listDiskSessions()`).
- Forward `session_running` / `session_added` / `session_removed` as they arrive; heartbeats every 30 s.
- Backpressure: transition frames are rare, but retain the droppable/limit guards so a pathological burst cannot wedge the socket.

### 4.3 Client

In `use-session.ts`, delete the `setInterval` and replace with:

```ts
const source = new EventSource("/api/sessions/events");
```

- `sessions_snapshot` → `setSessions(...)` (also seed the running map).
- `session_running` / `session_added` / `session_removed` → patch the list and running map in place.
- On `error`, let `EventSource` reconnect (it does by default); the next `sessions_snapshot` re-syncs, so a missed frame during a gap self-heals — the same recovery the per-agent stream already relies on.

Silence is **not** treated as `idle`; the running bit comes only as an explicit `session_running` frame. A session that dies without emitting `session_removed` is reconciled by the next snapshot after reconnect (and by `session_removed` from `dispose`/`unregister` in the normal case).

## 5. Requirements

- **R1.** No `setInterval` or `setTimeout` drives the session list refresh after this change (grep-enforced in `web/client/use-session.ts`).
- **R2.** `/api/sessions` remains (one-shot callers, tests, and the `sessions_snapshot` producer reuse it or its projection), but the client no longer calls it on a timer.
- **R3.** `session_running` is emitted only on a state flip; two consecutive `agent_start`s emit once.
- **R4.** A session's full turn — including bash execution and waiting for tool results — counts as `running` (pi's `isStreaming`, already the source for `listLiveSessions`).
- **R5.** `session_added`/`session_removed` fire on registry replace and on bridge takeover/`dispose`, not just spawn/resume.
- **R6.** The stream heartbeats and closes exactly like `attachAgentEventStream` (guard reuse, not a second implementation).

## 6. Acceptance criteria

- **AC1.** `web/client/use-session.ts` contains no runnable timer against `/api/sessions` (test or grep assertion).
- **AC2.** Unit test: `session_running` transitions are emitted on `agent_start` (true) and `agent_settled` (false), and suppressed on repeated same-state events.
- **AC3.** Unit test: `register`/`unregister`/`dispose` emit `session_added`/`session_removed`, including the replace path.
- **AC4.** `sessions_snapshot` on connect carries the same shape as `GET /api/sessions` (parity test against `listLiveSessions` + `listDiskSessions`).
- **AC5.** Root `npm run tidy` green (the two documented TUI clipping failures are the only accepted baseline); `web` server tests green.

## 7. Out of scope

- `fs.watch`-based discovery of new on-disk sessions from other processes.
- Moving transcript/plugin/model state onto this stream.
- Any change to how `running`/`isStreaming` is computed. This PRD moves its *delivery*, not its meaning.

## Related

- [minimal-pi-web](minimal-pi-web.md) — the `web/` client and its realtime design.
- [pi-web-pluggable-ui](pi-web-pluggable-ui.md) — the per-session `plugin_state` running flag this generalises into a global directory.
- `web/server/event-stream.ts` — the SSE skeleton and lifecycle-event wiring reused here.
- `web/server/sessions.ts` — the live registry, which already owns the running truth.