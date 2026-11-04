# PRD: Trusted plugin actions (Phase 5 of the pi-web integration)

> Part of [pi-workflow-extensions](../../README.md). Defines the minimal trusted-action contract for workflow plugins in the vendored pi-web fork: what an action is, who may trigger it, what must be confirmed, and what this design refuses to allow.

| Field | Value |
| --- | --- |
| **Status** | approved for implementation (threat review below is part of this approval) |
| **Owner** | Faiz |
| **Parent PRD** | [fork-pi-web-integration](fork-pi-web-integration.md) §8 Phase 5 |
| **Scope** | `lib/web-plugins/` (contract), `web-plugins/dashboard.ts`, `extensions/dashboard.ts`, the fork host/API/UI (`vendor/pi-web/`), one reference action |

## 1. What an action is

An action is a **named, allowlisted, extension-defined operation** a browser user may request for one hosted session. The web server never executes anything itself: it validates the request, relays it to the owning extension through the session's event bus, and the extension decides what (if anything) to do and republishes its view.

This deliberately matches the repo's trust stance: the browser stays a viewer that may *ask*; the extension — the same trusted code that runs in the parent agent's process — is the only thing that acts.

## 2. Contract

- **A1 (allowlist).** Descriptors may declare `actions: [{ id, title, confirm }]`. `id` matches `^[a-z][a-z0-9-]*$`; `title` is what the button says; `confirm` is the exact string the user must type to submit. A plugin with no `actions` field accepts nothing. Actions are validated by the registry like every other descriptor field; unknown `actionId`s are rejected at the API before any extension sees them.
- **A2 (channel).** Requests travel on a new `web-plugin:action-request` event-bus channel, payload `{ requestId, pluginId, actionId, sessionId }`. The host emits it on the same session bus it already subscribes for views; the owning extension listens with `pi.events.on`. Extensions reply by republishing their view (the existing `publishWebView` path) — there is no separate response channel.
- **A3 (explicit confirmation).** The API rejects any POST whose `confirm` field is not byte-identical to the action's declared `confirm` string (403). The UI renders the declared title and a text input that must match the `confirm` string; there is no checkbox, no pre-filled value, and no way to confirm from the API alone without that string.
- **A4 (auth).** No new auth surface. Requests go through pi-web's existing proxy (password/basic auth, loopback default). The plugin API route family is already gated; the action route adds nothing except a stricter payload check.
- **A5 (host never acts).** The fork host relays; it holds no execution capability. If no extension is listening (for example, a session whose extension does not implement actions), the request is accepted and simply has no effect — the host reports `relayed: false`.
- **A6 (single-use + bounded concurrency).** `requestId`s are generated server-side, single-use, and expire after 60 s. At most **one in-flight action per session**; a second concurrent request is rejected (409). Every accepted request is appended to an audit line (`requestId, sessionId, pluginId, actionId, timestamp`) kept with the plugin store.
- **A7 (extension-side re-validation).** The owning extension must treat the request as untrusted input: re-check that the action applies to current state, and ignore anything it does not recognise. The reference implementation demonstrates the guard.

## 3. Threat review

| Threat | Vector | Mitigation | Refuses |
| --- | --- | --- | --- |
| Drive-by action from a malicious page | Any website open in the browser POSTs to `127.0.0.1:<port>` | pi-web's proxy auth (cookie session required when a password is set; loopback bind by default); the confirm string is per-action and not discoverable without reading the descriptor served by the same origin | cross-origin requests without a session |
| XSS in plugin views triggering actions | A plugin cell contains script | Views are data rendered as text only (established Phase 2, AC6); no HTML path exists, and `dialog`/script injection is asserted in e2e | plugin content executing |
| CSRF from another local process | Non-browser local client POSTs the API | Same auth as every pi-web API route (A4); Basic-auth clients are already a documented upstream surface — this adds no new capability beyond what an authed client could already do by reading sessions | unauthenticated mutation |
| Free-form command execution | Descriptor declares `confirm` but id encodes a shell command | The host relays only `pluginId`/`actionId` (A2); there is no field by which a browser could pass a command, path, or argument — extensions act on their own internal state, never on request payload content (A7) | parameterised execution |
| Replay | Captured request re-sent | Server-generated single-use `requestId` with 60 s expiry (A6) | replayed relays |
| DoS via action storms | Script hammers the endpoint | One in-flight action per session (409 otherwise) + relay is synchronous and cheap (A6) | concurrent action floods |
| Malicious descriptor | A fork descriptor declares a dangerous action | Descriptors live in this repository, are enforcement-tested (R7/R8), and reviewed in PRs; actions follow the same review path as any extension code | third-party descriptor injection |
| Privilege creep | Actions grow into agent-control buttons | This PRD's scope ends at read-only/refresh-type actions; mutation actions (spawn, kill, edit) require a follow-up PRD that names each action and its blast radius | undeclared scope growth |

**Residual risk, stated plainly:** an attacker who can already read the descriptor (same-origin) and holds a valid browser session can trigger allowlisted, extension-defined, refresh-type actions. That is strictly narrower than what the same session can already do (read any session/file the fork exposes). No sandbox is claimed: the extension runs with the parent agent's full authority, which is why actions are allowlisted, confirmed, audited, and limited to the parent agent's own hosted sessions.

## 4. Reference action

`dashboard` plugin gets `request-sync`: id `request-sync`, title `Request fresh snapshot`, confirm string `request sync`. Extension handler: on `web-plugin:action-request` where `pluginId === "dashboard"` and `actionId === "request-sync"`, call the existing `requestDashboardSync` path (already in `lib/dashboard/integration.ts`) so publishers re-emit current state, then the normal view publish follows. This action is read-only, idempotent, and exercises every contract piece (registry, confirm, relay, extension guard, republish) without introducing a mutation.

## 5. Acceptance criteria

- AC1. POST with wrong/missing `confirm` → 403, and nothing is emitted on the bus.
- AC2. Unknown plugin or action id → 404 before any relay.
- AC3. Valid request → exactly one `web-plugin:action-request` on the session bus with a fresh single-use `requestId`; second concurrent request → 409.
- AC4. Extension guard: the dashboard extension ignores requests it does not recognise and re-checks plugin/action id; the handler never acts on payload content beyond the id pair.
- AC5. e2e: dashboard page renders the action button, typing the confirm string submits, the API responds 200 with a `requestId`, and no dialog fires.
- AC6. Gates: root `npm run tidy`, fork `tsc --noEmit`, fork `npm test`, fork `e2e/web-plugins.mjs` all green; known MCP flake per `VENDORED.md` exempt.

## 6. Out of scope

Mutation actions of any kind (spawn/steer/stop agents, edit todos/artifacts, run commands) — Phase 5 ships the transport, confirmation and audit skeleton with one refresh-type reference action; each real mutation action needs a named entry in a follow-up PRD with blast radius.
