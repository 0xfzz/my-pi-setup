# Compatibility audit — pi-workflow-extensions

| Field | Value |
| --- | --- |
| **Status** | historical audit (Pi 1.3.0) |
| **Detail for** | [README § Input modes](../README.md) |
| **Scope** | `extensions/modes.ts`, `extensions/providers.ts`, `lib/tool-policy.ts` |
| **Verified against** | reproductions against the real runtime at the time; not re-verified |
| **Related** | [Baseline](BASELINE.md) |

## Summary

- Five findings ranked by severity; the two that matter are Plan-mode bash hardening being silently discarded and the editor slot being clobbered.
- Each finding names the evidence, the failure mode and the smallest fix that removes it.
- What is already correct is listed too, so a later change does not "fix" working behaviour.
- Portability and a suggested order of work close the document.

Audited against **Pi 1.3.0** (`@earendil-works/pi-coding-agent`) and the 9 packages
actually installed in `~/.pi/agent/settings.json`.

Verification: reproductions ran against the real runtime (`createAgentSession` +
`bindExtensions`), not mocks. Existing suite: **479 tests, 477 pass, 0 fail**.

---

## 1. CRITICAL — Plan-mode bash hardening is silently discarded

**Where:** `extensions/modes.ts:207`

```ts
if (event.toolName === "bash") {
  const command = readOnlyShellCommand(event.input?.command);
  if (command === undefined) return { block: true, reason: "..." };
  return { input: { ...event.input, command } };   // <-- never applied
}
```

Pi 1.3 changed `ToolCallEventResult` to `{ block?, reason?, terminate? }` — there is
no `input` field. The docs are explicit:

> `event.input` is mutable. Mutate it in place to patch tool arguments before execution.

`agent-loop.js` copies `args: validatedArgs` into the event and, after the hook,
executes **the original `validatedArgs`**. `beforeResult.input` is never read.

**Consequence:** `lib/plan-shell.ts` hardening is entirely defeated. All of it —
`git -c core.hooksPath=/dev/null`, `--no-ext-diff`, `--no-textconv`, `rg --no-config`,
argument re-quoting — is computed and thrown away. Plan mode executes raw model text.

**Reproduced** with a repo containing `diff.external`:

| step | result |
|---|---|
| hook return | `{"input":{"command":"'git' '--no-pager' … '--no-ext-diff' '--no-textconv'"}}` |
| args after hook | `"git diff"` (unchanged) |
| execute raw `git diff` | repo's `diff.external` program **ran** (`PWNED` file created) |

So a cloned repo's `.git/config` gets arbitrary command execution while the user
believes they are in a read-only mode. Unsafe commands are still *blocked*
(that path works), but every *allowed* command runs unhardened.

**Why tests pass:** `tests/plan-mode.test.ts:186` asserts on the handler's return
value, which the runtime ignores. The test validates the mock contract, not Pi's.

**Fix:** mutate in place, keep the block path:

```ts
if (event.toolName === "bash") {
  const command = readOnlyShellCommand(event.input?.command);
  if (command === undefined) return { block: true, reason: "..." };
  event.input = { ...event.input, command };   // or: event.input.command = command
  return;
}
```

Then add a test that drives `agent.beforeToolCall` (or a real session) instead of
inspecting the return value.

---

## 2. HIGH — `modes.ts` clobbers the editor slot instead of composing

**Where:** `extensions/modes.ts:174` — `ctx.ui.setEditorComponent((tui, theme, keybindings) => …)`

There is a single editor factory slot. Two other loaded extensions claim it:

- `npm:pi-paster` (`customEditor.enabled` defaults to `true`) — installs a
  `PasterEditor` for inline image paste.
- `~/.pi/agent/extensions/prompt-history.ts` — wraps the *previous* factory so
  Up/Down history survives.

`modes.ts` never calls `ctx.ui.getEditorComponent()`. Load order is global
extensions first, then `settings.packages` in order, so this package (last) wins
and the ModeEditor replaces both.

**Reproduced:** with a paster-like extension installed first, after
`modes` `session_start` the slot contains MODES, and the earlier editor is gone.

`prompt-history`'s shutdown only restores if `getEditorComponent() === installedFactory`,
so it will not restore either. Net effect: image paste silently stops working and
editor history stops working whenever this package is loaded.

**Fix:** wrap, exactly as `prompt-history.ts` does:

```ts
const previous = ctx.ui.getEditorComponent();
ctx.ui.setEditorComponent((tui, theme, keybindings) => {
  const base = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
  return new ModeEditor(tui, theme, keybindings, base);
});
```

`ModeEditor` must delegate to `base` rather than extend `CustomEditor` directly.

---

## 3. MEDIUM — Duplicate Antigravity provider; the failover guard does not apply

Both are loaded in this install:

| source | provider id | account failover guard |
|---|---|---|
| `npm:pi-antigravity` | `antigravity` | **not read** |
| this package | `antigravity-1…N` | `ANTIGRAVITY_NO_ACCOUNT_FAILOVER=1` |

`vendor/antigravity/stream/stream.ts:1663` reads the env var; the npm copy has no
reference to it anywhere. On a `429 Quota reached`, the npm `antigravity` provider
still calls `failoverToNextAccount()`, which **rewrites `auth.json`'s
`activeAccountId`** — precisely the mutation the vendored patch exists to prevent.

This matters here specifically because `~/.pi/agent/account-router.json` sets:

```json
"pools": { "ag": { "provider": "antigravity", "source": "antigravity-accounts", … } }
```

`catalogProviderFor()` (account-router.ts:326) tries
`getProvider("antigravity")` **first** and finds the npm copy. So router-pooled
requests dispatch through the *unpatched* stream, which rotates the shared
`antigravity-accounts.json` on 429 while the router is independently rotating it.
Two managers, one store, and the router's `recordFailure` accounting is bypassed.

Both copies are pinned to upstream 0.11.0, so their catalogs match today but will
drift independently.

**Fix (pick one):**
- Drop `antigravity` from the pool and point it at the account family
  (`antigravity-1`), or
- remove `npm:pi-antigravity` from `settings.packages` since this package vendors it, or
- make the router refuse to front `antigravity` while per-account providers exist,
  and warn instead of silently preferring the exact match.

---

## 4. LOW — `PLAN_TOOLS` contains dead names and ignores annotations

`lib/plan-mode.ts:49` hardcodes names instead of using the `annotations` Pi exposes:

- `web_fetch`, `web_enable` — **no installed extension registers these.**
  `pi-web-access` registers `fetch_content`, not `web_fetch`.
- `google_search` is allow-listed by name but carries no `readOnlyHint`, so the
  `isPlanTool` fallback would reject it — the hardcoded entry is the only reason it works.
- `fetch_content` / `source_check` are blocked (annotated `readOnlyHint: false`),
  which is defensible for a "read" tool that writes page caches and clones repos.

Verified matrix: `web_search` ALLOW · `fetch_content` BLOCK · `get_search_content` ALLOW ·
`source_check` BLOCK · `google_search` ALLOW · `ffgrep`/`fffind`/`vcc_recall` ALLOW · `browser` BLOCK.

**Fix:** drop the dead entries; keep the explicit allowlist as the trust anchor but
add a startup assertion (or a test) that every name in `PLAN_TOOLS` resolves in
`pi.getAllTools()`, so renames surface immediately instead of silently narrowing Plan mode.

---

## 5. LOW — Bash-mode routing allowlist is incomplete

`lib/modes.ts:19` prefixes anything not matching `/^\/(?:mode|plan|sidebar|reload|quit)/`
with `!!`, so it runs as a **shell command**:

```ts
route: text => !text.trim() || text.startsWith("!!") ||
  /^\/(?:mode|plan|sidebar|reload|quit)(?:\s|$)/.test(text.trimStart()) ? text : `!!${text}`
```

This package registers 9 commands. Six break in Bash mode:
`workflow-todos`, `subagents`, `artifacts`, `provider`, `smart-timeout`, `workflow`.

Every other loaded package breaks too: `pi-vcc`, `pi-vcc-recall`, `mcp-auth`,
`browser-visibility`, `paste-image`, `prompt-history`, `clear-images`, `fff-mode`,
`fff-rescan`, `fff-health`, and all seven `antigravity.*` commands.

**Fix:** don't enumerate. In Bash mode, route through only when the text does not
start with `/`, and otherwise ask Pi's own command list:

```ts
// pi.getCommands() returns SlashCommandInfo[] (pi 1.3), not a Map.
route: text => {
  const t = text.trimStart();
  if (!text.trim() || text.startsWith("!!")) return text;
  const name = t.startsWith("/") ? t.slice(1).split(/\s+/)[0] : undefined;
  if (name && pi.getCommands().some(command => command.name === name)) return text;
  return `!!${text}`;
}
```

---

## Interactions that are correct (no action)

These are genuinely well-built and worth preserving as the pattern:

- **`offerSection()` handshake** (`lib/sidebar-channel.ts`) — synchronous
  ownership transfer via a mutable `handled` flag, with each widget clearing
  itself when the sidebar takes over. No polling, no duplicate rendering.
- **Event-bus namespacing** — `workflow-ui:section`, `workflow-ui:refresh`,
  `sidebar:register_animation`, `*:open-dialog`. No collisions with any of the
  9 installed packages.
- **No tool or command collisions.** Verified the full union: this package's 6
  tools (`workflow_todo`, `ask_user`, `artifact_save/recall/list`,
  `subagent_progress`, `subagent_history`) and 9 commands are unique.
  `alt+w` does not shadow any core keybinding (`shift+tab` does — `modes.ts` consumes it
  deliberately, before `CustomEditor`).
- **`appendEntry` types are versioned** (`workflow-todo:v1`, `input-plan-mode:v1`,
  `subagent-checkpoint:v1`) and branch-derived via `recordsFromBranch`, never
  rebuilt from raw file entries.
- **Herdr child isolation** in `todo.ts` `restore()` — `ownerSessionId` plus a
  timestamp tie-break for legacy entries is the right treatment for forked sessions.
- **`subagent_ping` / `subagent_result` custom types match Herdr's** actual
  emitters, so `ask-user`'s parent guidance gates correctly.
- **`before_agent_start` composes** — `todo.ts` writes only
  `toolGuidelines[TOOL]`, `modes.ts` only `sections.input_mode` / `sections.plan_mode` /
  `selectedTools`, and modes deliberately does *not* override `selectedTools` in
  Normal mode. No extension replaces another's prompt.
- **`turn_end` boundary entries aggregate** — `runner.emitBoundary()` threads
  `entries` / `continue` across handlers, so `todo.ts`'s continuation and
  `auto-compact.ts` coexist. `todo.ts` caps itself at one reminder (`retries >= 1`)
  and `auto-compact.ts` bails on mixed staged entries, so neither can loop the other.

---

## Portability

`lib/vcc-subagent-adapter.ts:30` hardcodes
`/home/faiz/.pi/agent/npm/node_modules/pi-vcc`. An `VCC_ROOT` override exists, but
the first candidate is machine-specific. Resolve from `getAgentDir()` instead.

---

## Suggested order of work

1. **§1** — one-line fix, removes an arbitrary-code-execution path. Do first.
2. **§2** — restores image paste and editor history for every user of this package.
3. **§3** — decide who owns `antigravity-accounts.json`.
4. §4, §5, portability — hygiene.

---

# Status: applied

All findings above are fixed. Verification: **484 tests, 482 pass, 0 fail, 2 skipped**
(`npm test`) and `tsc --noEmit` clean.

| § | Fix | Regression test |
|---|---|---|
| 1 | `modes.ts` mutates `event.input.command` in place instead of returning `{ input }` | `tests/plan-bash-mutation-runtime.test.ts` — real Pi session; asserts external diff no longer executes |
| 2 | `modes.ts` composes `ctx.ui.getEditorComponent()` (instance-level `handleInput` patch) instead of replacing the slot | `tests/mode-editor-compose.test.ts` |
| 3 | `npm:pi-antigravity` removed from `settings.packages`; `vendor/antigravity/{index,features/*}.ts` added to `pi.extensions` | `tests/antigravity-vendor-parity.test.ts` |
| 4 | Dead names (`web_fetch`, `web_enable`) dropped; added `missingPlanTools()` drift warning on `session_start` | `tests/plan-shell.test.ts` |
| 5 | Bash mode routes via `pi.getCommands()` instead of a hardcoded allowlist | `tests/modes.test.ts` |
| Portability | Both hardcoded `/home/faiz` paths replaced with `getAgentDir()` + `resolvePackageDir()` (package.json → require entry → `import.meta.resolve`, since `pi-coding-agent` exports only an `import` condition) | covered by `tests/antigravity-vendor-parity.test.ts` + adapter runtime path |

### §3 replacement proven end to end

Loading extensions through the real `DefaultResourceLoader` against the live
`~/.pi/agent/settings.json` now yields **23 extensions, 0 errors**, registering
`antigravity` plus `antigravity.{accounts,doctor,image,models,refresh,search,usage}`
and the `google_search` / `generate_image` tools — full parity with the npm package
it replaced. The vendored stream also honours the pool's per-request credential
(`stream.ts:1526 parseApiKey(opts.apiKey)`), so router-pooled requests dispatch
through the patched copy and the `NO_ACCOUNT_FAILOVER` guard now actually applies.

### Notes

- `tests/plan-mode.test.ts:186` previously asserted on the discarded `{ input }`
  return value, so it validated the mock contract rather than Pi. It now asserts the
  in-place mutation the agent loop actually observes.
- `settings.json` backup of the pre-change version is at `/tmp/settings.json.bak`.
- The npm package is only removed from `settings.packages`; its files remain on disk
  under `~/.pi/agent/npm/node_modules/pi-antigravity` and can be deleted separately.
