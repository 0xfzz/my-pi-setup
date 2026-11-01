# Pi Workflow browser dashboard

A dependency-light, read-only browser view of the local Pi workflow. The runtime
serves it at `/` on the dashboard port; this directory only contains static UI
sources and the build output.

The layout is a sessions nav plus one content area. There are two tabs — **Work**
and **Artifacts** — and a detail drawer that slides over the content when you
click something.

## What you see

### Names: people, documents and an authority

Every worker is a person: `Bima · Skeleton Builder`. The label is composed from
a **Javanese given name** plus a role noun derived from the handoff's purpose and
scope. The dictionary is vendored offline in [`src/names.javanese.mjs`](src/names.javanese.mjs)
(278 names, CC BY-SA 4.0, see [`NAMES.md`](NAMES.md)); no network, no font, no
dependency is involved.

- Assignment is **deterministic**: `fnv1a(child.id)` picks a slot in the sorted
  dictionary and probes forward past names already claimed by the session, over
  the child ids **sorted**, so the same id keeps the same name across reloads,
  restarts and resumes, and adding a sibling cannot reshuffle the others.
- An **explicit human name** chosen by the author of `agent_spawn` (or stored on an
  older registry row) always wins. A slug such as `api-worker` is never shown as a
  person: it is replaced by a dictionary name. Historical registry rows are not
  rewritten — the projection maps slugs to names on read.
- Non-people stay non-people: a handoff is **`Spec · Repo Skeleton`**, a review is
  **`Rangga · Review`** (or `API Review` when the reviewer child is unknown), a
  spec review is **`Spec Review · Auth`**, an escalation is
  **`Escalation · API`**.
- The session title follows the **current user goal** (`Dashboard polish`). The
  orchestrator is an authority, not a peer worker: its graph label is
  **`Dashboard polish Manager`**. Project remains secondary metadata. UUIDs,
  generic names, child stamps and hex blobs are rejected; project/`Workflow`
  are fallbacks, never a randomly chosen worker name.
- Set a new objective with the `session_goal({ title })` tool, `/session-goal Title`,
  or Pi's `/name Title`. Updates stream live without replacing the session.
  A branch-owned title survives restarts and completed tasks. An explicit Pi name
  or the first owned committed plan seeds it once when none exists; later
  verification plans, status updates, scratch plans and child goals cannot rename
  it. A new overall objective should use `session_goal`, not todo bookkeeping.
  Native renames are captured via `session_info_changed`, never by reading chat.
  Clearing the native name clears the goal and restores the project fallback.
- `scope` is never renamed: it is the isolation key and stays a slug in the
drawer, tooltip and status messages.

### Sessions nav

The left rail lists every known session by its current goal title plus mode/branch,
with its connection state and worker summary. Connected sessions sort first, then
by most recent activity. Below the mobile breakpoint the nav collapses behind a
single toggle button. Selecting a session clears whatever was open for the
previous one, so a stale artifact or drawer never leaks across sessions.

### Work tab

The toolbar holds a **List / Graph** toggle, a "Hide completed" checkbox and a
one-line summary of the current session. Both views describe the same work items
and share the selection, so switching between them does not lose your place.

- **List** groups work into *Needs attention* (blocked workers, workers waiting
  on a pending question, open escalations), *In progress* (running workers and
  collecting reviews) and *Finished* (completed, failed and closed items). Empty
  groups are skipped. Each row carries a **kind chip** (glyph + word) next to the
  status badge, so "what it is" never has to be inferred from "how it is doing".
- **Graph** renders the same items as a Graphviz layout, with zoom, fit and a
  legend split into *Nodes*, *Edges* and *State*. The graph only draws a handoff
  node for an explicit `handoffId` reference.

#### Kind is the primary encoding, status is second

| Kind | DOT shape | Border | Label |
| --- | --- | --- | --- |
| Orchestrator (session) | `box3d` | solid, accent-tinted | `{Goal} Manager` |
| Worker | `box, rounded` | solid, status paint | `Bima · Skeleton Builder` |
| Spec / handoff | `note` | **dashed**, neutral paper | `Spec · Repo Skeleton` |
| Review | `hexagon` | solid, verdict paint | `Rangga · Review` |
| Spec review | `folder` | solid | `Spec Review · Auth` |
| Escalation | `octagon` | **dashed**, amber | `Escalation · API` |

Shape, border style, label prefix and the legend all differ, so a handoff cannot
be mistaken for a running agent even in greyscale. The encoding lives in one
table (`NODE_KIND_STYLE` in `src/graph.mjs`), and `graph-dom.mjs` keeps
`kind-*`/`data-node-kind` plus an aria-label that names the kind in words
(`"Spec · API — Spec, Blocked. Open details."`).

Edges are encoded the same way: `spawn` solid, `delivers` (worker → spec)
dotted with an arrow, `verdict` hairline, `escalation` amber dashed.

### Detail drawer

Clicking a work item row or a graph node opens one drawer over the content
instead of a separate column. For a handoff it shows the full goal and every
acceptance criterion exactly as the handoff provides it — there is no
per-criterion completion status, because the API does not carry one. Worker,
review, escalation and spec-review selections show their own fields plus links
to the related items they point at.

`Esc`, the close button and the backdrop all close the drawer and return focus to
whatever opened it. Opening the drawer never changes tabs. The drawer header
names the kind in words (with its icon), shows the composed display name as the
title and the role/scope/status beneath it; the raw `scope` stays a slug there.

### Motion

Motion is **class-driven CSS**, never inline style or SMIL — the CSP stays
`style-src 'self'` and the SVG sanitizer still strips `<style>`/`<animate>`.
`src/motion.mjs` is a pure planner (`planGraphMotion(prev, next, { reducedMotion })`)
that decides *what* changed; `app.mjs` only adds/removes classes:

| Moment | Class | Duration |
| --- | --- | --- |
| Topology relayout | SVG `viewBox` tween (JS, `requestAnimationFrame`) | 320 ms |
| New node | `.is-entering` staggered 18 ms, capped at 12 nodes | 220 ms |
| New edge | `stroke-dasharray/offset` presentation attributes → `transition` | 360 ms |
| Running worker | `.is-live` stroke-opacity pulse | 2400 ms |
| Edge touching running work | `.is-active-edge` dash drift (not on `delivers`) | 1800 ms |
| Status change in place | `.is-updated` brightness flash | 600 ms |

Guardrails:

- **`prefers-reduced-motion: reduce` is a full kill switch.** The JS planner
  returns empty entry/edge/update lists, the ambient classes are not applied at
  all, and the CSS block removes every remaining animation/transition, so the
  graph is static *and* equally readable.
- Status-only updates never relayout: animation classes are applied after render
  and are excluded from `topologySignature()`, so `buildDot()` is not re-run.
- `getTotalLength()` is guarded (jsdom returns 0), so draw-in degrades to "appear"
  instead of leaving a broken dash pattern; the attributes are removed afterwards
  so hover/focus and the DOT dash pattern are unaffected.
- Nothing animates while the document is hidden, and there is no JS polling loop —
  the ambient motion is declarative CSS.

### Artifacts tab

The catalog on the left lists every artifact in the session with a search box
over title, id, tag and scope. Selecting one loads its body from
`/api/artifact` with the catalog version attached. Markdown bodies go through the
sanitizer described below; the artifact's own source is inserted as plain text.
If the catalog moved while an artifact was open, the request answers `409` and the
view keeps what it has behind a "Load latest" action rather than silently
replacing the body.

## Routes (served by `lib/dashboard`)

| Path | File |
| --- | --- |
| `/` | `index.html` |
| `/style.css` | `style.css` |
| `/dist/app.js` | built bundle (gitignored) |

The UI reads the same-origin API described in `lib/dashboard/protocol.ts`:

- `GET /api/sessions` → `{ sessions }`
- `GET /api/session?id=…` → `{ session }`
- `GET /api/artifact?session=…&id=…&version=…` → `{ artifact }`
- `GET /api/events` SSE with `data: {"type":"changed"}` → one coalesced refresh

There is no mutation UI. Every request is a read. Artifact bodies are only
served on an exact version match; a mismatch is a `409`, an unknown entity is a
`404`, and every error is JSON `{ error }`.

## Build

```bash
npm install
npm run build:dashboard
```

Output: `web/dashboard/dist/app.js` (~1.5 MiB, mostly the embedded Graphviz
WebAssembly payload). `dist/` is gitignored, so a fresh checkout needs the build
before `/` serves the real UI; the runtime otherwise shows a fallback page, and
the preview server answers `/dist/app.js` with a "Not built" error.

The build is fully local and works offline after `npm install`. `esbuild`
bundles:

- `@viz-js/viz` — Graphviz WASM with the wasm embedded in JS (no CDN, no native
  graphviz binary, no extra `.wasm` asset route)
- `marked` + `dompurify` — Markdown rendering and HTML sanitization
- `highlight.js` core with a small language subset (JS/TS, JSON, bash, Python,
  Markdown, XML, CSS, YAML)

## Tests

```bash
node --experimental-strip-types --import ./tests/isolate-env.mjs \
  --test tests/dashboard-naming.test.ts tests/dashboard-web.test.ts tests/dashboard-integration.test.ts
```

Covers the vendored name list (278, unique, ASCII, sorted, frozen, digest),
deterministic/collision-safe assignment, explicit-name precedence, manager
rejection of UUIDs/tmp, role nouns, kind shapes in DOT, kind classes on a status
repaint, the motion plan (including the reduced-motion kill switch), graph
projection/provenance, topology stability, DOT escaping, a real Graphviz render of
a malicious label, SVG allowlisting, Markdown link/image policy, session-selection
retention, request-race/version guards, SSE coalescing, drawer state transitions
and API error mapping.

## Local preview (development only)

```bash
npm run build:dashboard
node scripts/dev-dashboard.mjs --port 4789
```

The preview server has a mock API and no authentication; keep it on localhost.
It is not used by the runtime. It prints the preview URL on start and serves the
same four routes as the runtime, with a heartbeat on the event stream so the
connection pill stays live.

The fixtures are there to exercise the drawer without a live session. Worker
names in the fixture are slugs on purpose: the preview proves that the projection
replaces them with dictionary names instead of printing `api-worker` as a person.

- **Alpha implementation** (`pi-workflow-extensions`) is connected and running.
  Three handoffs carry real acceptance criteria and goals long enough to wrap in
  the drawer, with workers linked by `handoffId`: two running (one waiting on a
  pending question), one completed, one blocked, one completed review and one
  closed predecessor. It also has an approved review, a changes-requested review,
  a waiting escalation, and spec reviews in `ready` and `collecting` states.
  Artifacts are linked to the workers that produced them, with one
  session-scoped artifact that has no worker.
- **Docs refresh** (`docs-site`) is paused and offline with empty collections, so
  the empty states for the work list, graph and artifact catalog are reachable.
  It lives in a second project so the preview shows two distinct manager labels.

## Security model

Artifact bodies, session/worker names and DOT labels are untrusted. Names are
composed from a fixed dictionary and an explicit human name is only accepted when
it is not a slug, uuid or markup, so `</text><script>` in a registry row becomes a
dictionary name instead of a label.

- Markdown HTML is pre-cleaned before it touches a DOM (Chrome loads `<img>` even
  inside `<template>`), then sanitized with an allowlist. Images are replaced by a
  text placeholder, unsafe links (`javascript:`, `data:`, `file:`, scheme-relative)
  are unwrapped, and safe links get `rel="noopener noreferrer nofollow"`.
- DOT labels are escaped and Graphviz SVG passes an allowlist that removes
  scripts, event handlers, `foreignObject`, external references and `style`.
- Artifact source is inserted with `textContent`, never `innerHTML`.
- CSP: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'` (WASM compile is
  required for Graphviz), images none, no forms or inline handlers.
- The dashboard API itself is read-only and same-origin; it never accepts a
  mutation, and the dev preview is bound to localhost only.

## Known limitations

- The graph is optimistic about creating a handoff node only for explicit
  `handoffId` references; scope alone never implies ownership.
- Missing handoff/spec-review records referenced by a worker are not synthesized.
- The drawer shows acceptance criteria as the handoff supplies them; it cannot
  report which ones are done because that state is not published.
- Artifact contents live-update only when the catalog version changes; a `409`
  surfaces a "Load latest" action rather than silently replacing what is open.
- Bundle size is dominated by Graphviz WASM; this is the cost of rendering
  without a CDN or native dependency.
