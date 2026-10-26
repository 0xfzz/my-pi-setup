# Pi workflow extensions

Extensions for **Pi** (Node 22) that coexist with Herdr subagents, codemode, MCP adapter, VCC, auto-compact, clipboard-image, and prompt-history. Smart timeout wraps the built-in bash tool; the other extensions do not replace existing tools. No replacement of system prompt, header, footer, or global agent definitions. Input modes extend the editor and consume Shift+Tab for mode cycling.

## Repository layout

| Path | What lives there |
|:--|:--|
| `extensions/` | The installable extensions listed in `package.json` → `pi.extensions`. |
| `lib/` | Shared implementation (todo state machine, artifacts, orchestrator registry, VCC adapter). Not loaded as extensions. |
| `tests/` | `node:test` suites: `tests/*.test.ts` plus the orchestrator suite in `tests/orchestrator/`. |
| `vendor/` | Third-party code kept in-tree: `pi-herdr-subagents` (see its `VENDORED.md`) and `antigravity`. |
| `docs/` | Design notes, audits, and `docs/patches/` — the diffs applied to installed packages, with `VERIFICATION.md`. |
| `crates/` | Optional Rust/WASM ascii animation engine (`npm run build:wasm`). |

## Install / remove

```sh
pi install /absolute/path/to/pi-workflow-extensions
# Restart Pi (or /reload in a session with no running children).
pi remove /absolute/path/to/pi-workflow-extensions
```

The local package stays in this directory. Do not delete or move it while installed. The package manifest lists each extension explicitly, so its tests and helpers are not loaded as extensions. To disable only one, use `pi config` and select this package's resources.

For development:

```sh
npm install --ignore-scripts --legacy-peer-deps   # dev-only: typescript + @types/node
npm test                                          # every suite, no network or inference
npm run typecheck
```

## 1. Conditional AI todo list

Tool: **`workflow_todo`**. Command: **`/workflow-todos`**.

**Keyboard details:** press **Alt+W**, release, then **T** for todos, **S** for subagents, or **E** for artifact details (no Enter). **Esc** cancels the prefix menu. `/workflow` opens the same menu. Todo and subagent details open as bordered pickers that drill into bordered markdown/text detail popups (`↑↓/jk`, `Enter`, digits `1`–`9`, `Esc`); artifact details open the artifact viewer's markdown popup described under [Workspace Artifacts](#4-workspace-artifacts-plans-specs-scratchpads). This keyboard path works in regular and fullscreen TUI modes, including when `/sidebar off` hides the rail; terminal mouse clicks work only in fullscreen. The prefix is registered by `extensions/sidebar.ts`; standalone todo/subagent extensions retain `/workflow-todos` and `/subagents`.

- Text-only replies and clarification questions need no assessment tool call. Before using work tools, the main AI assesses the current request. `skip` records a short simplicity reason (with a default if omitted) without making a list or showing a widget. `plan` creates concrete steps for multi-step work, with the first step already in progress. `continue` preserves an unfinished plan.
- **Dynamic Atomic Sync**: The AI can pass an entire updated checklist in a single tool call via `todos: [...]` (or `action: "sync"`). This supports simultaneous step completion and next-step activation in one turn (zero-turn handoff), dynamic task description editing, reordering, and item insertion.
- Before normal tools can run, the request must be assessed. Clarification, parent pings, interruption, and tool discovery remain available. Nested/codemode tool calls pass through the same Pi tool hooks.
- Only one item can be `in_progress` at any time. In dynamic mode, completing a step and calling a work tool automatically advances to the next pending step without blocking.
- `done` requires an evidence note. Completed items cannot be silently removed or reopened without a reason.
- `modify` allows in-place task description, continuous activeText (`activeText`), or reason/note editing.
- `cancel` supports both global scope cancellation and per-item cancellation (by providing `id`).
- On a premature final response with an actionable unfinished plan, a `turn_end` boundary requests continuation. It does not reopen a plain reply just to record a skip or invent a task to resume. This boundary is deliberately before Herdr's child `agent_end` auto-exit; a final-settlement-only hook would be too late.
- Genuine `blocked` and `waiting` states require reasons and allow yielding. They are **not completed**. The AI should report them honestly and update them when input/results arrive. Parent completion is blocked while unresolved items remain; a child may still `orch_ping` for help.
- New user requests take priority, but preserve unfinished plans. The AI can add a step and continue. Explicit scope cancellation is recorded, not silently cleared.
- State lives in Pi session custom entries, reconstructed from the **active branch**, not a global file. Reload, resume, fork/tree navigation, and normal compaction retain the plan. Separate sessions have independent state.
- No extra classifier model, inference bill, keyword guesser, timers, filesystem watcher, network, or polling. The existing AI judges complexity.

Example actions:

```json
{"action":"skip","reason":"Single factual answer; no work plan needed"}
{"action":"plan","steps":["Inspect the relevant code","Implement the change","Run focused tests"]}
{"todos":[{"id":1,"text":"Inspect code","status":"done","evidence":"Found src/login.ts"},{"id":2,"text":"Implement change","activeText":"Refactoring login auth","status":"in_progress"},{"id":3,"text":"Run tests","status":"pending"}]}
{"action":"modify","id":2,"text":"Refactor login authentication handlers","activeText":"Refactoring auth handlers"}
{"action":"update","id":1,"status":"done","evidence":"Inspected src/login.ts and its tests"}
{"action":"update","id":2,"status":"in_progress"}
{"action":"update","id":2,"status":"blocked","reason":"Need the user's choice of authentication provider"}
{"action":"cancel","id":3,"reason":"Scope removed by user"}
```

### Safety and limits

This is a workflow guardrail, not a permission sandbox or a proof of correctness. It enforces the declared plan's structure, not the truth of the AI's complexity assessment or evidence notes. An AI can still misjudge a task or claim inaccurate evidence. Final-answer reminders are capped at one per run to prevent costly infinite loops, and never continue errors or aborts. Each continuation adds a model-visible reminder entry, providing the runnable context Pi requires. At the cap, Pi warns that work is incomplete; it does not mark it done. The initial premature text can already have streamed before the continuation hook fires.

**Loops are corrected, never stopped.** When several consecutive turns contain only `workflow_todo` administration (list, continue, redundant status churn) and no real work, the guardrail does not abort or terminate the run. It instead:

1. injects a model-visible steer telling the assistant to run the current step with real tools and to stop repeating `workflow_todo`;
2. refuses the redundant administrative call for that turn so the steer cannot be ignored;
3. **fails open**: after a few steers the guardrail stops refusing and lets the agent's chosen call run, so the guard itself can never become the cause of a stall.

The plan, all evidence, and all unfinished work are always retained. Real work (or an explicit milestone: `plan`, `skip`, `cancel`, or an `update` to `done`/`blocked`/`waiting`) resets the counter immediately, so ordinary progress never trips the guard. Only intentional yields — a forwarded `ask_user`/`orch_ping` — end a turn early.

The user can always press Escape. To drop removed scope explicitly:

```text
/workflow-todos cancel requirements changed
```

## 2. Ask user / ask orchestrator

Tool: **`ask_user`**. Ask about consequential ambiguity, missing requirements, conflicting instructions, or unavailable information—not facts that can be checked using available tools, and not routine confirmations already authorized by the request.

In the main session, use Pi's native select/input dialogs rather than a custom terminal renderer. In a Herdr child, questions route through the existing **`orch_ping`** tool; no direct user dialog, sidecar duplication, parallel question transport, or change to the Herdr plugin. The parent receives the question and child session path, answers from existing context when possible, otherwise calls `ask_user`, then resumes the child with `orch_resume` and the answer. This is Herdr's exit-and-resume handshake, not a child blocking forever on a new RPC channel.

Cancelled/unavailable input is not an answer or consent. The AI must keep dependent work blocked and report missing information. Non-interactive sessions must not invent user answers. Agent definitions that explicitly restrict tools must allow `ask_user` in the parent and `orch_ping` in the child; the extensions do not override those restrictions.

**Guidance is injected only when it applies.** A Herdr child always receives the child-side rules, because they constrain tools it can reach at any moment. The parent receives the ping-handling rules **only on a `subagent_ping` turn** — not on every turn. Injecting them unconditionally made the rules read as a standing assignment, so a bare `test` arrived with hidden instructions about answering pings and resuming children and was answered with a protocol recital instead of an acknowledgement.

## 3. Durable delegated-work checkpoints & VCC history reduction

Command: **`/subagents`**. Parent tool: **`orch_history`**. Child tool: **`orch_progress`**.

- The parent records child identity, task, saved session path, pane/run identity, latest milestone, changed files, verification, next action/question, and terminal outcome. A compact widget shows recent/active work. `/subagents` lists running and completed history, opens saved checkpoints/results and transcript previews, displays a reopen command, and can explicitly request a follow-up resume for an ended child.
- **VCC Algorithmic History Distillation & Recall**: Instead of dumping monolithic raw transcripts (up to 30,000 characters) into model context, `orch_history` integrates with `pi-vcc`:
  - `vccSummary: true`: Generates a structured zero-LLM algorithmic summary (`[Session Goal]`, `[Files And Changes]`, `[Commits]`, `[Key Signals]`, and rolled-up `[Brief Transcript]`) directly from the child session branch (~95% token savings).
  - `query: "<regex>"`: Performs regex/keyword search over child session entries and returns indexed matches with pagination.
  - `expand: [<indices>]`: Expands only the requested entry indices in full untruncated detail, avoiding token bloat.
  - Terminal child completion automatically compiles a VCC summary into the parent's recorded summary.
- Dashboard previews use native editor dialogs for scrolling/copying; edits are **discarded**. They never edit child files. Transcripts are read only on request, use the active child branch, omit thinking, and show at most 40 text/tool entries / 30,000 characters. Files over 16 MiB must be reopened directly. The parent tool only reads children admitted by launches/checkpoints on the active parent branch—not arbitrary file paths or late off-branch results.
- Registry entries live in the parent session as `subagent-checkpoint:v1`. Every model request receives a fresh, bounded (14,000-character) checkpoint snapshot, including after native/VCC compaction **and** the separate 20% auto-compactor. Old records omitted by the bound remain accessible through history. No full child transcript is copied into every prompt, and no extra summarizer/model call is added. The snapshot adds context tokens to the existing request.
- Children publish meaningful milestones with `orch_progress`, not every tool call. Changes made through `workflow_todo` also publish automatically when that tool is allowed. Atomic, private `<child-session>.progress-checkpoint.json` sidecars carry only the latest milestone; event-driven filesystem notifications update the parent's widget/checkpoint journal. They do **not** wake the parent model or spend inference tokens. The next ordinary request receives the latest checkpoint. Completion still uses Herdr's existing automatic result delivery; questions needing an answer still use `orch_ping` / `ask_user`.
- Progress is not completion. A blocked-but-running milestone cannot offer a resume action. Terminal results are correlated with pane identity so delayed results from an old run cannot terminate a resumed writer. Sidecars are matched to both session path and run ID, and only previously accepted milestones establish progress ordering.
- Registry recovery is not process recovery. After reload/restart, unfinished records are labeled **unverified**: the companion restores history and milestone watching, but it does not recreate Herdr's in-memory completion watchers or prove that a child is alive. Do not reload while children are running. Check their existing panes first; never open/resume the same session concurrently. No automatic restart or duplicate writer is created.
- Existing saved launches/results on the active branch are reconstructed when possible. Old children that predate activation cannot emit the new milestone tool until they are restarted/resumed after activation. Restricted profiles receive `orch_progress` and `workflow_todo` through a minimal local Herdr control-tool allowlist patch (otherwise the existing todo guardrail would block those children before assessment). If disabling this companion entirely, revert that compatibility patch too.

Example child milestone:

```json
{"summary":"Fixed auth validation","files":["src/auth.ts"],"verification":"3 regression tests pass","next":"Review the patch","blocked":false}
```

### Activation, installed-package fixes, and rollback

This directory is already configured in `~/.pi/agent/settings.json`; the manifest now includes the checkpoint extension. **After all children finish**, restart Pi or use `/reload`. No live session is automatically reloaded by this installation.

The installed VCC compaction/recall patch keeps VCC's **zero-LLM algorithmic compiler**. It fixes selection of projected custom/branch messages and stable recall indexing; it is not a lossless summarizer. See [`docs/patches/vcc-tests/README.md`](docs/patches/vcc-tests/README.md) for exact changes, tests, retention/index behavior, rollback, and limitations. Your separate 20% auto-compactor is left intact; the request-local checkpoint hook covers that path.

Patches are under `docs/patches/`:

- `vcc-projected-compaction-recall.patch` + `vcc-tests/`: the installed VCC sources' fix and its regression harness.
- `herdr-context-fork.patch`, `herdr-progress-control.patch`, `herdr-auto-complete.patch`, `herdr-terminal-error-shutdown.patch`: the local `pi-herdr-subagents` changes. The source they apply against is vendored at [`vendor/pi-herdr-subagents`](vendor/pi-herdr-subagents) — see its `VENDORED.md` for provenance and the exact date the snapshot was taken.
- `VERIFICATION.md`: how each patch was verified.

Package updates/reinstalls can overwrite the installed VCC/Herdr edits. Check patch compatibility and rerun tests before reapplying; do not blindly replace either package with the backups. To remove only this feature, disable `extensions/subagent-checkpoints.ts` with `pi config` (or remove it from the manifest), revert `herdr-progress-control.patch`, then safely restart. Existing checkpoint/session files remain available as history. VCC's independent fix can remain enabled.

## 4. Workspace Artifacts (Plans, Specs, Scratchpads)

Tools: **`artifact_save`**, **`artifact_edit`**, **`artifact_recall`**, **`artifact_search`**, **`artifact_list`**. Command: **`/artifacts`**.

- Decouples heavy specifications, architecture roadmaps, schemas, and scratchpads from conversational chat turns.
- **Ultra-light catalog injection**: Pi's `context` hook injects a compact index (~50 tokens) of active artifacts into model prompts (`artifact-catalog:v1`). The model recalls full text on demand with `artifact_recall({ id })`.
- **Partial reads and edits**: `artifact_recall({ id, offset, limit })` returns a 1-based line range with an `NNN│ ` gutter instead of the whole document, and `artifact_edit` changes part of an existing artifact (`append`, `replace`, `insert`, `replaceLines`) instead of forcing a full rewrite through `artifact_save`. `artifact_search` reports artifact, line and column for a text or regex hit, so the caller can jump straight to the relevant range. Each edit bumps the artifact version and keeps the same placement rules as `artifact_save` (child staging, parent sidecar-only scoped specs).
- **Subagent-to-main IPC**: When a subagent calls `artifact_save`, the artifact is written to an atomic staging sidecar (`<child>.artifact.<id>.json`). The parent process automatically detects and ingests it into the **main conversation branch** via `pi.appendEntry("artifact:v1")`, ensuring artifacts are never trapped inside child sessions.
- **Branch-aware & compaction-proof**: Stored in session `custom` entries. State is reconstructed from `SessionManager.getBranch()` on reload, resume, and tree navigation. Compaction retains active artifacts automatically.
- **Interactive browser**: `/artifacts` (or **Alt+W → E**) opens a bordered picker — `↑↓/jk`, `Enter`, digits `1`–`9`, `Esc` — and a bordered markdown detail popup (`↑↓/jk`, PgUp/PgDn, Home/End, mouse wheel, `Esc`). In the detail popup, **`o`/`v`** pauses the TUI, writes the artifact to a temp `*.md` file (so nvim gets markdown syntax), opens `$PI_EDITOR`/`$VISUAL`/`$EDITOR` (falling back to `nvim`, then nano/notepad), and restores the TUI when the editor exits.
- **`@` mentions**: Type `@` and search by artifact ID, title, or tag, then select an artifact alongside the normal file suggestions. Selection inserts `@artifact:<id>` (for example, `Review @artifact:auth-spec` or `@artifact:blabalal.md`). Use `@artifact` (with or without the trailing `:`) to show only artifacts; the dropdown opens naturally while typing, without pressing Tab. Suggestions require saved artifacts on the current branch—ordinary files and chat messages are not automatically artifacts. Sending the message attaches a compact reference placeholder with artifact metadata and recall instructions instead of dumping full content into the prompt, keeping prompt input minimal so the agent recalls full content on the go with `artifact_recall`. Mentions support IDs with or without file extensions (e.g. `@artifact:blabalal.md`). Plain `@file` mentions remain unchanged. Missing/off-branch artifact IDs are reported as unavailable rather than silently using another branch. Explicit mentions also work in RPC/print input and resolve parent/staged artifacts in Herdr children. Uses Pi's public autocomplete wrapper without replacing the input-mode editor.

### Compatibility with FFF file mentions

Pi applies autocomplete wrappers in registration order: the last provider sees input first. FFF 0.11.0 returns matching files for `@…` without consulting earlier providers, so loading it after this package can hide artifacts. Keep `npm:@ff-labs/pi-fff` **before** `pi-workflow-extensions` in the `packages` array of `~/.pi/agent/settings.json`. This lets the artifact wrapper merge saved artifacts with FFF's fuzzy file results; `@artifact` remains artifact-only. No FFF tools or file search features need to be disabled. Restart or `/reload` after all children finish to apply the order.

An optional integration test loads the real installed FFF extension with isolated temporary files/databases and no model requests. It reproduces the conflicting order and verifies the corrected order:

```sh
PI_FFF_EXTENSION_PATH=/path/to/@ff-labs/pi-fff/src/index.ts \
  node --experimental-strip-types --test tests/artifact-mentions-fff.test.ts
```

## 5. Smart bash timeout

Tool: wraps **`bash`** (including nested/codemode calls). Command: **`/smart-timeout`** shows the limits/config path.

- Stamps the active timeout on **each bash call** in the UI header (`renderCall`), so users can see the exact limit: `(timeout: 180s, idle: 90s)` for default calls, or `(timeout: <secs>s)` for explicit budgets. Tool details also store applied timeout metadata.
- Default: terminate after **180 seconds total** or **90 seconds without stdout/stderr**, whichever comes first. Continuous output cannot keep a command running forever.
- An explicit bash `timeout` disables the silence cutoff for legitimate quiet tasks, but is limited to **1800 seconds**. Invalid/over-ceiling values fail before execution.
- The result retains command output and Pi's truncation/full-output handling, returns error status/exit code **124**, and adds an agent-visible diagnostic: `fix-first` for possible prompts/watch processes/errors, `inspect-first` for ambiguous silence, or `consider-increase` for recent output at the wall limit. It includes elapsed/silent time and retry guidance. The existing agent decides what to do; no extra model call or automatic rerun occurs.
- Uses Pi's local shell backend for process-group termination, cancellation, streaming, session environment and shell settings. Each call owns independent timers, cleaned up on completion/abort; shutdown aborts active calls. Escape remains cancellation, not a timeout.
- Killing a command does **not** undo partial effects. Advice explicitly warns against blindly repeating mutations. Output activity is not proof of progress, and silence is not proof of a hang. Diagnosis uses bounded recent output and simple heuristics, not CPU/process deadlock detection.

Optional user configuration: `~/.pi/agent/smart-timeout.json` (or the configured Pi agent directory):

```json
{
  "defaultSeconds": 180,
  "idleSeconds": 90,
  "maxSeconds": 1800
}
```

All fields are optional positive numeric seconds, at most 86400, with `idleSeconds <= defaultSeconds <= maxSeconds`. Invalid config falls back to safe defaults and warns in interactive mode. Restart or `/reload` **after all children finish** to activate or apply changes. This package is already installed; no additional install is needed. New/resumed child processes receive the extension when they load this package. Existing running children are not hot-patched.

Limits: agent `bash` only, not user `!` shell commands, powershell, browser operations, or arbitrary subprocesses launched inside other tools. Deliberately detached/reparented processes may escape Pi's process-group cleanup; uninterruptible OS I/O cannot be reliably terminated by any userspace timer. Another extension overriding `bash` can conflict; only one implementation should own it. Disable `extensions/smart-timeout.ts` using `pi config` to restore ordinary bash behavior.

Focused tests: `node --experimental-strip-types --test tests/smart-timeout.test.ts` exercise real short-lived shell commands, quiet/chatty hangs, explicit budgets, cancellation, parallel isolation, descendant termination, diagnostics, validation, and extension registration.

## 6. Input modes: Normal / Plan / Orchestrator

**Shift+Tab** cycles modes. The sidebar shows a bold, theme-colored mode label with a distinct single-column icon, a concise description, and a dimmed switching hint. **◇ Normal** uses the accent color and **≡ Plan** the success color. These are standard text glyphs, not emoji or Nerd Font icons; labels remain readable without color. Without the sidebar, a compact bar above the editor uses the same icons and highlights the active mode:

```text
[ ◇ Normal ]   ≡ Plan     Supervise     ⌁ Orchestrator    Shift+Tab to switch
Chat with AI
```

- **Normal**: Pi's regular AI input, tools, commands, and shortcuts. Shell commands still run through Pi's native `!`/`!!` prefix.
- **Plan**: brainstorming and grilling, not implementation. `/plan mode` (also `/plan` or `/plan on`) enters; `/plan off` returns to Normal and restores the previous tool loadout. `/plan status` reports the policy. `/mode plan` selects the same mode.
- **Orchestrator** (also spelled **Supervise**): delegation without implementation. `/mode orchestrator` (or `/supervise on`) enters; `/mode normal` exits and restores the previous tool loadout. Direct edits, browser tools and mutating shell commands are blocked; `orch_handoff → orch_spawn → orch_review → orch_escalate` stay available. See [Orchestrator mode](#orchestrator-mode-parallel-delegated-work).
- `/mode` and Shift+Tab cycle **Normal → Plan → Orchestrator → Normal**; `Supervise` is the same policy as Orchestrator and is reachable explicitly with `/mode supervise` but is skipped by the cycle. `/mode normal`, `/mode plan` and `/mode orchestrator` select explicitly (with completions). `/mode`, `/plan`, `/sidebar`, `/reload`, and `/quit` remain available in every mode; switch to Normal for other Pi slash commands.
- **A switch is a transition, not a cursor move.** Entering or leaving a restricted mode is refused while a turn or native shell command is running (or while unverified children hold permissions in Plan); a refused switch leaves both the tab and the policy unchanged, so repeating the keypress is never skipped. The transcript is the source of truth: the selected tab, the enforced allowlist and the request's mode reminder are all derived from the same branch entry.
- Switching preserves the current draft. Normal remains local input routing; **Plan policy is branch-local session state** and survives reload/resume/fork, follows tree navigation, and restores the original tools on exit. `/plan` also works through RPC/print prompts. It does not change global agent configuration.
- Shift+Tab replaces thinking-level cycling **in the main editor**; other shortcuts still go through `CustomEditor`. No global keybindings file is modified. Another extension replacing the editor can conflict.
- This is an inline command runner, **not a persistent PTY**: interactive apps such as vim/htop are not supported, and `cd`/exports do not persist across submissions. Use `cd path && command` within one submission.

### Read-only exploration / artifact-only writes

```text
/plan mode
Grill @artifact:auth-spec: what assumptions are weak, and what could fail?
/plan off
```

- Every AI run gets an explicit **current-mode briefing**, derived from the same branch-local state as the guard and sidebar. A fresh `<current-input-mode>` reminder is also appended to each model request, including tool-loop continuations, after restoring the current branch policy. Normal explicitly says **Plan mode is OFF** and that historical Plan restrictions, assistant claims, and compaction summaries no longer apply. The Plan-only prompt section is removed on exit; the AI should not ask you to exit Plan again when already in Normal. The reminder is request-local, deduplicated, and never stored in the transcript (no history growth or extra inference). No manually activated skill or global prompt change is needed.
- Plan's automatic briefing follows **clarify → recall artifacts / inspect references → grill assumptions → compare alternatives → create/refine artifacts → summarize and stop**. Questions are focused and asked one at a time; previously answered questions need not be repeated. Suggestions are not approval, and the assistant must not switch modes or start implementation itself. The guidance is rebuilt after reload/resume.
- **Read any files** accessible to the local user, including paths outside the workspace. Dedicated read/search tools, audited web search/fetch tools, MCP resource readers, and third-party tools explicitly annotated `readOnlyHint: true` are allowed. Explicit destructive hints override read-only hints. Missing hints fail closed; hints are trusted tool-author claims, not verified guarantees.
- **Create or update artifacts** through `artifact_save`, including new IDs on an empty branch. Existing artifact versions/history are retained. Raw `write`/`edit` are blocked everywhere, even for paths named `artifacts/`; the exception is the artifact API, not a directory name.
- **`ask_user` and `workflow_todo`** remain available as conversation/workflow control exceptions. Todos track research/discussion, not permission to implement.
- **Shell inspection** is supported through `bash`, `!`, and `!!` using the same conservative parser. It normalizes/quotes arguments and checks every command in pipelines or `&&` chains. Supported commands include `cat`, `ls`, `head`, `tail`, `wc`, `stat`, `rg`, `grep`, restricted `find`, and read-only Git status/log/diff/show/listing commands. Git pagers, external diff/text conversion, fsmonitor hooks and optional index locks are disabled. Redirection, expansions, glob expansion, interpreters, arbitrary executables and write/execute options are rejected. Quote literal special characters and use read/search tools for unsupported commands. Native Plan shell execution uses checked local operations; Normal preserves other shell extensions unchanged.
- Unrestricted browser/codemode/MCP script gateways, image generation, ad-hoc/implementation delegation, and unclassified tools remain blocked because their internal operations can bypass nested tool checks. Direct MCP tools with read-only annotations are supported. The `orch_*` parent tools are allowed: Plan can delegate research/review work, and spec work with a handoff; the child's `purpose`, not the parent's mode, decides its tools. Nested, deferred, stale and newly registered calls go through the same `tool_call` policy. Tool hiding is **not** the enforcement boundary. Normal-mode tool availability is restored on exit.
- **File/path and artifact completions, `/skill:` file expansion, image attachments, slash commands and templates are available in Plan**. Reading/attaching content is not permission to modify it. Keep the FFF load order documented above for combined file/artifact suggestions.
- The sidebar shows **Plan / Read; artifacts RW**. Entering/leaving Plan during an agent turn or a native shell submission through the mode editor is refused; stop/cancel it first. Shell tracking clears on completion, cancellation or failure. Entry is also refused while branch checkpoints contain running/unverified children; finish/stop them and resolve their checkpoint state first.
- Tool restoration respects Pi's destination-branch transcript, including intentionally empty/read-only loadouts and exits immediately followed by resume/switch/fork. Deferred tools that reconnect after a restored Plan exit return on the next Normal AI request; pending names survive checkpoints/reload/tree without leaking to unrelated branches or repeatedly undoing later deactivation. Normal preserves other extensions' explicit per-request tool selection.

**Boundary:** this is a read-only **agent policy, not an OS sandbox**. “No writes” means no task-directed workspace or remote mutations except artifact storage; operational transcripts, caches and temporary tool output still exist. Pi extensions and local executables run with full process permissions: their background work, direct I/O, executable resolution/configuration and native user slash-command handlers remain trusted. Earlier input/shell handlers can intercept before this extension, so cooperating extensions and correct load order remain required. The mode neither revokes external processes/children nor restricts other sessions. Direct SDK shell execution outside the mode editor is the caller's responsibility; `ctx.isIdle()` excludes native shell activity, and shell activity predating extension reload/editor replacement cannot be tracked. Disable/exit Plan before disabling its mode extension.

Add a `{ id, label, hint, route(text) }` entry to `MODES` in `lib/modes.ts` to extend the cycle; the widget and `/mode` completions follow the registry automatically. Permission-bearing modes also need policy/lifecycle handling in `extensions/modes.ts`; merely routing editor submissions does not restrict tools.

Already included in the installed package. Run `/reload` when no children are running, or restart Pi. Disable just `extensions/modes.ts` with `pi config` to restore the default editor and Shift+Tab behavior.

Verification: `tests/modes.test.ts` covers extensibility, native-shell routing, callback replacement, actual editor Shift+Tab/draft retention, `/mode`, and narrow UI widths. `tests/plan-mode*.test.ts` covers read-only inspection, new/existing artifacts, both extension orders, reload/branch restoration, busy/child guards, and real Pi direct/nested calls with codemode-only and later tool reactivation. `tests/plan-shell.test.ts` checks shell normalization, mutation/expansion/option rejection, outside-workspace reads and tool annotations. `tests/mode-transitions-runtime.test.ts` verifies the effective system prompt, matching mode widget/policy, original tool restoration, and an actual built-in file write after `/plan off`, `/mode normal`, and Shift+Tab, both live and after resuming a saved Plan session, with and without a stale Plan-mode compaction summary. It checks the fresh provider-bound reminder on every request, including the post-write continuation; unit tests verify deduplication, missed branch refresh, and no persisted reminder entries. `tests/plan-autocomplete.test.ts` covers real-editor Tab, slash names/arguments, forced completion, stale selections and async mode-change/cancellation races. `tests/mode-lifecycle-runtime.test.ts` covers resume/switch/fork before a Normal request (including empty loadouts), distinct tree loadouts, disconnected/reconnected deferred tools across reload/tree, upstream tool selection, slash commands and preloaded templates. `tests/mode-shell-runtime.test.ts` gates real Pi native-shell execution with cooperating remote operations and verifies completion/cancellation, command/Shift+Tab rejection, and draft retention. Scripted runtime tests use no real credentials, network or inference. The earlier real tmux/Pi smoke test covers inline shell output, zero inference usage, and switching back to Normal.

## 7. Minimal right sidebar

The main terminal gets a resizable right rail (**24 columns by default**) with just three sections:

```text
│ ◇ Normal
│ AI chat & tools
│ Shift+Tab · switch
│
│ Todo 1/3
│ ☑ Inspect existing UI
│ ● Build minimal sidebar
│   with readable wrapping
│ ☐ Verify resizing
│ /workflow-todos
│
│ Artifacts 1
│ · Sidebar design
│ /artifacts
```

- Shows up to three todo rows in **natural plan order** with clean unicode checked (`☑`), in-progress (`●`), and unchecked (`☐`) status glyphs (no prepended numbers). Long todo text wraps with readable hanging continuation indentation so tasks can be read carefully without truncation. Full lists and viewers remain under `/workflow-todos` and `/artifacts`; the rail does not steal editor focus.
- Replaces the todo/artifact/mode widgets rather than duplicating them. No extra model, prompt injection, files, timers, or polling. Provider state updates through Pi's local event bus.
- Below **100 terminal columns**, the rail collapses to **one compact status line** above the editor. Short terminals show fewer rows. `/sidebar` toggles it; `/sidebar on` and `/sidebar off` are explicit. Off restores full chat width without bringing back clutter. The toggle lasts for this Pi process.
- **Pluggable ASCII animations & Rust WebAssembly engine:** when spare vertical rows exist below the sidebar sections in fullscreen, an animated ASCII piece runs at its preferred frame rate without taking editor focus.
  - **Pluggable architecture (`lib/sidebar-animation.ts`):** Includes three built-in pieces:
    - **`aquarium`**: Swimming neon tetras, golden minnows, angelfish, pulsating jellyfish, red crabs on gravel, swaying kelp, and rising bubbles.
    - **`cats`**: Slow-paced autonomous cat playground with multiple scenes (laser chase, cardboard box sits, yarn acrobatics, fish snack feasts, cozy afternoon naps, playful tumble scuffles, and top-shelf kitten) and smooth star-dither cross-fade transitions.
    - **`matrix`**: Cascading phosphorescent green digital code streams with bright leading heads.
    - **`fire`**: Cozy flickering campfire hearth with dancing flames and rising embers.
    - **`auto`** (aliases: `random`, `shuffle`, `gallery`): Autonomous playlist cycling through all pieces with slow-paced durations and seamless dither transitions.
  - **Controls:**
    - `/sidebar anim`: shows current and available animations.
    - `/sidebar anim <name>`: switches the active piece (e.g. `/sidebar anim cats`, `/sidebar anim auto`, `/sidebar anim matrix`, `/sidebar anim fire`, `/sidebar anim aquarium`).
    - `/sidebar anim on` / `/sidebar anim off`: toggles animation on or off. Backward-compatible alias `/sidebar aquarium on|off` remains supported.
  - **Custom plugins:** other extensions or scripts can register animations at runtime via `pi.events.emit("sidebar:register_animation", { id, name, render })`.
  - **Rust WebAssembly optimization (`crates/aquarium-engine`):** compiles to native WebAssembly (`wasm32-unknown-unknown`, outputting to `lib/aquarium_engine.wasm`). Generates frames in under **30 µs/frame (>33,000 FPS)** directly in linear memory with zero JS garbage collection overhead. Automatically falls back to pure TypeScript if WASM is unavailable.
- **Resize:** in fullscreen, drag the vertical `│` divider left/right. Mouse must be enabled in Pi and forwarded by your terminal/tmux. In either renderer, `/sidebar width 32` sets the width, `/sidebar width` reports it, and `/sidebar reset` returns to 24. Valid widths are **20–60 columns**, automatically clamped to leave at least **76 columns for chat**. Your preferred width returns when the terminal grows; below 100 columns the sidebar still collapses. Width updates are deduplicated by integer column bounds so high-frequency terminal mouse events do not trigger redundant TUI re-renders. Dragging owns only the divider, not transcript selection or editor focus.
- **Fullscreen** keeps the host's original transcript ScrollView/editor layout. Pi exposes no public layout-root getter, so this adapter **feature-checks** the existing root field and `setLayoutRoot`, and additionally requires Pi **1.3.0 or newer** (a floor, not a pin: an equality check on `1.3.0` disabled the sidebar entirely on 1.4.0, where the layout API is unchanged). Unsupported fullscreen layouts retain the original widgets and show a warning. No installed Pi sources are patched.
- **Regular/scrollback mode** composes public TUI children, drawing the rail beside the latest visible screenful. Native terminal scrollback cannot keep it pinned while manually scrolling old terminal history. Resizing or toggling changes wrapping in either renderer.
- Main interactive UI only; child sessions and RPC/print runs keep their existing behavior. Disabling only `extensions/sidebar.ts` in `pi config` restores the independent widgets after reload.

Already registered in the installed package. **Restart Pi or run `/reload` when no children are running.** Existing sessions are not hot-reloaded automatically.

Verification: focused sidebar tests cover both renderers, two provider load orders, sidebar ownership/fallback, branch restoration, narrow layout, cursor preservation, toggles, ScrollView state, renderer switching, and cleanup. Aquarium tests verify 12–120 width scaling, border integrity, animation loop/clock pauses, row allocation, and command toggling. Resize tests also cover capture, screen-coordinate dragging, width limits, lost-release recovery, command validation/reset, and chat space on narrow terminals. Run `node --experimental-strip-types --test tests/sidebar*.test.ts`. Live tmux/Pi checks verified regular/fullscreen rendering, aquarium animation frames, 80-column collapse, reload, artifact picker/viewer, Shift+Tab, and shell output without inference. The full suite's existing filesystem milestone test needs available OS file watchers; an exhausted inotify quota produces `ENOSPC` independently of this sidebar.

## 8. Custom provider setup in the TUI

Command: **`/provider`** only. The redundant `/providers` alias has been removed. Opens Pi dialogs—no AI request or generated extension code.

```text
/provider             # interactive menu
/provider add         # provider ID, display name, API key, connection, fetched model
/provider edit        # change a configured provider's connection
/provider model       # add/update one or more models on a configured provider
/provider remove      # remove only its models.json entry
/provider list        # list configured providers (not the entire built-in catalog)
```

Supports OpenAI Chat Completions (`openai-completions`), OpenAI Responses (`openai-responses`), Anthropic Messages, and Google Generative AI compatible endpoints. For Ollama/LM Studio/vLLM and gateways, use the exact base URL (including `/v1` when required).

**Setup flow:** enter the provider **ID**, its separate **display name**, and an **API key** in a masked input. Then select the API protocol and enter the base URL (these are required to contact a custom service). The wizard fetches its model list. Select a model and save—returned context/output limits and explicit capabilities are applied automatically, without retyping them.

**Automatic model list:** `/provider add` and `/provider model` try the selected protocol's read-only model-list endpoint and show a searchable, scrollable multi-select picker. Type to search model IDs or display names (case-insensitive). **↑/↓** scroll, **PgUp/PgDn** page, **Space** toggles a model, and **Ctrl+A** selects/deselects all matching models. Selections survive search changes. **Enter** continues with all selected models (or just the highlighted model if none are checked); **Ctrl+G** switches to manual ID entry; **Esc/Ctrl+C** cancels without saving. Fullscreen also supports wheel scrolling and clicking checkboxes; regular mode uses the keyboard because the terminal owns mouse scrollback. The picker opens as a focused, centered overlay instead of replacing the prompt/editor dock, so widgets and the footer cannot clip it. Its viewport adapts to terminal height, using a compact layout on very short screens while keeping the highlighted model visible. RPC clients use repeated standard selection dialogs with a **Use selected models** action instead of the terminal picker.

Selected models are configured together and saved only after one final confirmation. Missing context limits are requested separately with the model ID shown. Existing unselected models are kept; cancelling any step saves none of the batch. If discovery is missing, unauthorized, empty, malformed, unsupported, or unreachable, the wizard falls back to the same manual-entry form without discarding your setup.

- OpenAI-compatible: `GET <base-url>/models` (typically `/v1/models`, including Ollama's OpenAI compatibility API).
- Anthropic: `GET <base-url>/v1/models`, without duplicating an existing trailing `/v1`.
- Gemini: `GET <base-url>/models`; a host-only base uses `/v1beta/models`. `models/` resource prefixes are removed for Pi's model IDs, and explicitly non-chat entries are excluded.

`/models` is a convention, not a universal standard. Native Ollama `/api/tags`, unusual gateway paths and unsupported APIs may need manual entry. Discovery uses the entered key, environment references or existing native Pi API-key credentials and provider headers. No key is included in notifications or session messages. OAuth, extension-owned providers and `!command` authentication use manual entry rather than guessing service-specific auth or executing credential commands.

Discovery has a five-second HTTP timeout and bounds of ten pages, 2 MiB and 2,000 unique models. Pagination stays on the original endpoint; redirects are rejected. `--offline` or `PI_OFFLINE=1` skips discovery. No inference request is made, but read-only discovery requests can occur before final save confirmation; rejecting save does not undo those reads. Endpoint trust confirmation for reused authentication occurs **before** discovery. Returned IDs alone do not describe capabilities. When supplied, the wizard uses validated `context_length`/`context_window`/`contextWindow`/`max_model_len`, OpenRouter `top_provider` limits, or Gemini `inputTokenLimit`/`outputTokenLimit`. It also accepts explicit returned model names, reasoning flags and input modalities; it never infers limits from a model ID. **If a fetched model omits its context window, only that limit must be entered manually**—many standard `/models` responses expose IDs only. Missing/invalid output limits retain a valid existing limit or use `min(8192, contextWindow)`, with a visible notice. Missing capabilities retain existing values or default to text-only/non-reasoning; review these fields in `models.json` if the server does not advertise them. The full manual-entry form remains available whenever discovery fails or you choose manual entry.

API-key input:

- **Paste a key**: masked in the terminal and used immediately for discovery. On final confirmation, its literal value is saved in the private `models.json` file (`0600`). Treat that file as a credential file; do not commit or share it. `$` and leading `!` in literal keys are escaped so they cannot trigger environment interpolation or commands.
- **Environment variable**: type `$ACME_API_KEY` or `${ACME_API_KEY}` in the key field. Only the reference is written. Export the variable **before starting Pi**; shell exports inside the running agent do not change its environment.
- **Blank on a new provider**: configures a dummy `pi-local` key for local servers. This is not an anonymous/no-header transport mode; the server must accept or ignore a dummy key.
- **Blank when editing**: keeps existing authentication unchanged, including credentials stored through `/login`. RPC clients cannot display the masked TUI input; they accept an environment-variable name instead, not a raw key.

**Credential precedence matters:** stored `/login` and runtime keys override model-file/environment keys. The wizard blocks changing the key/local/environment setting while such a credential is active: use `/logout` first, restart without a runtime override, or choose a new provider ID. It also refuses authentication changes on extension-owned provider IDs or when existing provider/model headers are present, since extension auth and custom headers may override the selected method. Use a unique ID, keep existing authentication, or review advanced configuration manually. Changing an endpoint with existing authentication/custom headers requires explicit confirmation showing the current source and destination. Use a unique ID to isolate a new service from existing provider credentials. Removing configuration does **not** log out, revoke keys or delete built-in/extension providers; use `/logout` separately.

Configuration is saved to `<agent-dir>/models.json` (normally `~/.pi/agent/models.json`, respecting `PI_CODING_AGENT_DIR`). Pi reloads it immediately with network catalog refresh disabled; select the new model through `/model`. The current selection is not changed. Restarted Pi sessions and `pi --list-models` load the same native configuration without this extension needing to register competing providers. SDK hosts with a nonstandard `modelsPath` must manage that path themselves; the command targets the standard agent directory.

Other providers, headers, compatibility flags, costs and advanced metadata are preserved. Existing `modelOverrides` are synchronized for the fields edited in the model form, so they cannot silently hide its changes. Model-level endpoint/API overrides still take precedence over provider connection edits. **New model prices are recorded as zero/unknown**, not a promise that the model is free; edit `cost` in `models.json` for accurate billing. Advanced compatibility flags, custom headers, OAuth integrations, nonstandard model discovery and unsupported streaming protocols remain manual configuration/provider-extension work; see the [custom-provider guide](https://pi.dev/docs/latest/custom-provider).

Escape or rejecting confirmation saves nothing. Writes use a private temporary file (`0600`), atomic replacement, Pi's file-mutation queue and a cooperative cross-process wizard lock, with conflict checks before/after staging. Stale dialogs fail instead of intentionally overwriting detected changes. Arbitrary external editors do not honor the lock, so this is **not an OS-wide compare-and-swap guarantee**; avoid simultaneous manual edits. A crashed save can leave `models.json.workflow.lock`; remove it only after confirming no provider save is running. Symlinks, malformed JSON and JSON-with-comments are refused without rewriting them. Saving normalizes strict JSON formatting; no backup copies of credentials are created. A failed refresh after saving is reported as saved-but-not-loaded, not cancellation or automatic rollback.

Main session only, idle between runs. RPC clients supporting native dialogs use environment references instead of masked key entry; print mode and Herdr children do not open setup UI. Already included in this package: **restart Pi or use `/reload` after all children finish**, then run `/provider add`. No real provider configuration is changed merely by installing this extension.

Verification: `node --experimental-strip-types --test tests/providers.test.ts tests/provider-discovery.test.ts tests/provider-key-input.test.ts tests/provider-model-picker.test.ts tests/provider-model-picker-layout.test.ts` covers fetched metadata, separate native provider display names, masked key rendering/editing/cancellation, literal-key escaping, and discovery protocol paths, authentication, pagination, timeouts/redirects/response limits, automatic selection, manual fallback, cancellation, trust-before-network, field validation, auth precedence guards, native secret login, private/atomic writes, stale/concurrent saves, model override precedence, advanced-field preservation, removal, failed refresh, and real Pi 1.3.0 model loading across fresh runtimes. Tests use fixture credentials and injected responses or loopback HTTP, never real provider inference.

## 9. Account router (multi-account, any provider)

Command: **`/router`**. Routes each request to any registered provider/model, and spreads one provider across several accounts. Works for **every** provider Pi knows about — built-in, `models.json`, or extension-owned — with no provider-specific code.

```text
/router                    # routes, pools and health
/router accounts [pool]    # per-account health
/router use <pool> <id>    # pin a pool to one account
/router reset [pool]       # clear failures, cooldowns and pins
/router reload             # re-read config files
```

Two independent layers, both optional:

- **Routes** — a virtual model `router/<name>` that dispatches to an ordered fallback chain of `provider/model` targets. Pick it in `/model` like any model.
- **Pools** — a set of accounts for one provider, rotated by strategy, so several Google logins (or several API keys) share one provider.

Config is read from the global `<agent-dir>/account-router.json` and then the project `.pi/account-router.json`; a project entry wins per route or pool name.

```json
{
  "routes": [
    { "name": "auto", "targets": ["antigravity/gemini-3-pro", "openai-codex/gpt-6-astra"] },
    { "name": "cheap", "targets": [{ "model": "antigravity/gemini-3.8-flash", "pool": "ag" }] }
  ],
  "pools": {
    "ag": { "provider": "antigravity", "source": "antigravity-accounts",
            "strategy": "round-robin", "cooldownMs": 60000 },
    "or": { "provider": "openrouter", "strategy": "least-recently-used",
            "accounts": [{ "id": "personal", "apiKey": "$OPENROUTER_KEY_1" },
                         { "id": "work", "apiKey": "$OPENROUTER_KEY_2" }] }
  }
}
```

**Routing.** A target is `provider/modelId`; a model id may contain slashes (`openrouter/meta/llama-3`). A failed target moves to the end so the retry tries the next model. Tool continuations stay on the model that answered the turn, which keeps prompt caches and thinking signatures valid; set `"sticky": false` on a route to opt out. A target may pin a `thinking` level.

**Pools.** Strategies: `round-robin`, `least-recently-used`, `priority` (declaration order) and `sticky` (hold one account). Sources: `antigravity-accounts` reads the linked Google logins from the account store (no explicit `accounts` list needed — every linked login is used, and expired tokens are refreshed through the vendored provider), and `static` (the default) uses each account's own `apiKey` expression: a literal, `$ENV`/`${ENV}`, or a leading `!command`. `$$` and `$!` escape those prefixes. Secrets are resolved inside the request path and never printed by `/router`.

A quota/rate-limit failure (`429`, `resource_exhausted`, …) quarantines the account for at least `cooldownMs` (default `60000`), honoring longer provider reset hints such as `Please wait 54h10m43s`. Cooling accounts are never used, even when the entire pool is exhausted. After the deadline, the next request selecting that account first sends a tiny `Reply OK.` recovery probe to the **same model/account**, with no conversation or tools, reasoning off, a 16-token output cap and a 15-second timeout. A failed probe renews cooldown and moves on to another eligible account; a successful probe restores normal traffic and stops further tests until another quota failure. Probes are demand-driven, not background polling, and their usage is included in the resulting response. `maxConsecutiveFailures` (default `3`, `0` disables) retires accounts after other repeated failures; quota recovery remains possible beyond that budget. Health and pins persist in the branch and in `<agent-dir>/account-router-state.json` (`0600`, atomic), including the pending-probe flag, so a restart does not re-hammer a dead account.

Health is tracked for **any** provider, not just Antigravity: a pool is exposed as a shadow provider that replaces each request's credential with the selected account's, using the request-scoped API key Pi already treats as an override. One shadow provider is registered per API group of the base provider, because Pi dispatches an extension's `streamSimple` only for a matching `api`. A pool does not modify `auth.json`, does not touch the active login, and never rotates a token on disk.

A pool whose `provider` names an **account family** (`"provider": "antigravity"` with providers `antigravity-1`, `antigravity-2`, …) uses that family's catalog and dispatches through a member, so one route or pool config keeps working as accounts are linked or removed. Per-account providers hand the pool's per-request credential to the vendored stream, so the account the pool selected is the account billed.

Route targets and pools are additive to the existing `/provider` wizard: use `/provider` to define a custom endpoint, then a pool or route to share or fall back across it. Errors are reported, never silently ignored: `/router` lists config warnings and the last error, and a route with no usable target fails the request with the reason instead of picking something arbitrary.

Verification: `node --experimental-strip-types --import ./tests/isolate-env.mjs --test tests/account-pools.test.ts tests/account-sources.test.ts tests/account-router-runtime.test.ts` covers config validation and projects-over-global merging, every selection strategy, cooldowns, failure budgets, exhaustion, state persistence and permissions, corrupt-state recovery, static/`antigravity-accounts` credential resolution, token refresh and re-login errors, routes and fallback chains, plus **real Pi sessions** proving that a pool rotates accounts across requests, that a `429` cools one account and the next request succeeds on another, that a route skips an unavailable provider, and that `/router` reports status headlessly. Tests use fixture credentials and stub providers; no real inference or account is used.

## 10. Antigravity accounts as providers (`antigravity-1` … `antigravity-n`)

Command: **`/antigravity`**. Registers **one provider per linked Google account**, so several Antigravity logins appear as separate models in Pi's own `/model` picker — no account-switching extension, no single shared `antigravity` provider.

```text
/antigravity                 # list accounts and their provider ids
/antigravity login           # link another Google account
/antigravity remove <id>     # unlink an account (others renumber)
/antigravity refresh         # refresh access tokens now
/antigravity help            # usage
```

**Why one provider per account.** A single provider can only hold one credential, so switching accounts used to mean a manual switch that the model picker could not express. With `antigravity-1`, `antigravity-2`, … each account is an ordinary Pi model target: pick it in `/model`, name it in a route, or let a pool rotate it. Numbering is **stable link order** (ties broken by account id), so ids only change when an account is actually added or removed — and removal renumbers, because the numbers are positional slots, not identities. `/antigravity` always lists the current mapping.

An account with no refresh token cannot be used, so it does not occupy a slot. A malformed, empty or missing store is reported as zero accounts, never as an error at startup. Each provider exposes the same model catalog; only the credential differs.

**Credentials are never shared.** Every request refreshes its own account's token (persisting the new one behind a mode `0600` atomic write) and passes only that account's credential to the stream. A token is never read from, or written to, another account's slot, and nothing is printed by `/antigravity` except account labels and provider ids.

**No silent account switching.** Upstream `pi-antigravity` fails a `429` over to the next linked account, which rewrites the global active login. That contradicts a provider pinned to one account, so this extension sets `ANTIGRAVITY_NO_ACCOUNT_FAILOVER=1`: a quota wall surfaces as a quota error on the account you chose instead of quietly changing accounts. Use a pool if you actually want rotation.

**No npm dependency.** The provider is vendored under `vendor/antigravity/` — see [`VENDORED.md`](vendor/antigravity/VENDORED.md) for the exact delta from upstream and the re-vendoring steps. It is not loaded as an extension itself, so there is exactly one owner of the provider ids.

Verification: `node --experimental-strip-types --import ./tests/isolate-env.mjs --test tests/antigravity-accounts.test.ts` covers provider-id mapping, stable ordering, malformed/empty stores, per-slot credential isolation, project derivation, token freshness skew, and **real Pi sessions** proving each linked account registers as its own provider with chat models and configured auth, that no bare `antigravity` provider exists, and that an unlinked install registers nothing and still loads. Tests use fixture credentials; no real inference or account is used.

## Orchestrator mode (parallel delegated work)

Mode: **Orchestrator** (`/mode orchestrator`). The supervisor decomposes a large request into work units, delegates each to a cheap-model child with a handoff spec, runs them in parallel, reviews the results with evidence, and escalates only what it cannot decide.

**The loop:**

1. **Author** — `orch_handoff` writes one spec per work unit (scope slug, goal, acceptance criteria, lane files, out-of-lane files, interfaces, guidance) and publishes it as a **scoped artifact**. A child recalls its spec by id and sees nothing else: no sibling scope, no sibling path.
2. **Delegate** — `orch_spawn` takes a `handoffId` (spec work), or runs an **ad-hoc** child with `purpose`, optional `laneFiles`/`acceptanceCriteria`, and `budgetMinutes` (default 30). The child runs in its own Herdr pane; workers with disjoint lanes run in parallel. Purpose is resolved before any pane exists, so a refused spawn leaves no trace.
3. **Steer** — `orch_steer` (Esc→settle→type→observe delivery, confirmed by echo), `orch_route` (deterministic owner resolution), `orch_interrupt`/`orch_resume`. `orch_running` reports every child with scope, lane, and pending escalations.
4. **Review** — `orch_review` records each criterion against evidence the orchestrator gathered itself; an approved verdict with a failing criterion or an out-of-lane diff is refused in code. Two consecutive `revise` rounds stop the loop and move the decision to the user.
5. **Escalate** — `orch_escalate` is the ladder: `answer` / `to-user` (through the ask-user extension — a cancelled dialog is unanswered, never consent) / `relay-user` / `cancel`.

**Durability.** The registry persists to an atomic versioned sidecar (`orchestrator-registry.json`) and is restored + reconciled on session start: dead panes are closed, live panes keep running, pending escalations survive. A watchdog enforces each child's wall-clock budget and stall-detects (3 identical pane tails) — interrupting and steering the parent instead of burning tokens. `orch_running` lazily re-verifies pane liveness, so a child whose pane died never lingers as a zombie triggering cleanup loops across sessions; `orch_resume` refuses session paths that do not exist.

### Spawn shapes and mode policy

`purpose` is resolved before any registry row or pane exists. A refused spawn writes nothing.

| `purpose` | Normal | Plan | Child policy |
|---|---|---|---|
| `research` (Plan default) | ✅ | ✅ | read-only tools + `bash`/web inspection; no `write`/`edit`/patch |
| `review` | via `orch_spec_review` | via `orch_spec_review` | isolated reviewer, no shell, no writer |
| `spec` (`handoffId`) | ✅ | ✅ | worker allowlist, lane frozen |
| `adhoc` (Normal default) | ✅ | ❌ | worker allowlist; no lane unless declared |
| `implementation` | ✅ | ❌ without an execution approval | worker allowlist |

Plan is read-only for the **parent**; delegating research, review or spec work is not implementation. Plan refuses `adhoc` and `implementation` with an explicit message. `orch_check` reports `lane: not-declared` for an ad-hoc unit with no `laneFiles` (it is not a failure), and `orch_review` treats an empty lane as "nothing to violate".

A delegated child may not spawn again (`PI_SUBAGENT_DEPTH`, default max-depth 1), and one parent may hold at most 8 running children (`PI_SUBAGENT_MAX_CHILDREN`). Both are hard stops before a pane exists and both are overridable.

### v1 removal and cut-over

The old `subagent*`, `caller_ping` and `parent_*` names are **removed**, not aliased. Everything is `orch_*`; `/subagents on|off|status` is the single switch, and `lib/delegation-tools.ts` is the single capability table. A stale global install that registers a v1 name is stripped from the active set and refused at call time. A v1 child launched before the migration must be finished or closed before reloading: resuming it would call a tool that no longer exists.

**Status:** `/orch status | list | handoffs | escalations`.

### Independent specification review (opt-in)

Reviewing only the finished diff catches problems after they are expensive. `orch_spec_review` puts an independent, **read-only** review in front of implementation:

```text
orch_spec_review({ action: "start", targetArtifactId: "retry-design" })
  → pins the document by content hash, launches one isolated reviewer per lens
orch_spec_review({ action: "collect", runId })
  → reads their reports; every finding is bound to its lens and revision
orch_spec_review({ action: "resolve", runId, dispositions: [...] })
  → records how each finding was handled; readiness settles only when no blocker is open
```

Presets: `quick` (comprehension + readiness) and `architecture` (zoom-out, comprehension, critic, readiness). A reviewer gets a snapshot quoted into its ticket, `read`, the todo tools, and `orch_spec_review_submit` — **no** shell, **no** write tool, **no** artifact writer, **no** parent transcript pointer, and it is forced to `standalone` so an agent profile cannot widen its context. That is enforced by the launcher and the parent's `tool_call` guard, not by prompt text.

Bind the result to the work unit with `designRef`, and the gate refuses a stale approval at both ends:

```text
orch_handoff({ scope, …, designRef: { runId, targetHash } })   // refuses an unready or amended design
orch_spawn({ handoffId, … })                                    // re-reads the content and refuses drift
```

**Check receipts.** `orch_check` now returns a `checkRunId`. `orch_review({ …, checkRunId })` refuses a verdict when the receipt is missing, belongs to another scope, was taken against different acceptance criteria, or was taken against a different tree. Without a receipt, `cmd`/`test` evidence is still accepted as *attested* (shape-verified) — the difference is now visible in the audit trail instead of being indistinguishable from a real run.

**Known limitations:** receipts live in memory for the process that observed the run (a restart cannot vouch for work it did not watch); `treeDigest` covers the whole worktree, so two lanes in one checkout invalidate each other's receipt; reviewer isolation is harness isolation, not an OS sandbox.

Tests: `node --test tests/orchestrator/*.test.ts`.

## Orchestrator web dashboard (live graph + artifacts)

A local, read-only web view of the orchestrator, its subagents, and workspace artifacts. Full details in [`docs/ORCHESTRATOR-DASHBOARD.md`](docs/ORCHESTRATOR-DASHBOARD.md).

```text
npm install && npm run build:dashboard   # once; serves Graphviz WASM locally, no native graphviz, no CDN
/mode orchestrator                      # Pi prints a dashboard URL; open it in a browser
```

The first parent session that enters Orchestrator mode starts **one detached server** for the OS user (`~/.pi/dashboard`); every later orchestrator session — including other Pi processes and other projects — is added to the same page's left sidebar instead of starting a second one. A refused mode switch and a delegated child session never register a top-level entry. Leaving the mode publishes the new mode and keeps observing the work.

- **Names**: every worker is a person — a vendored Javanese given name plus a role (`Bima · Skeleton Builder`) — and the root is an authority, not a peer: `{Project} Manager` (`Pi Workflow Extensions Manager`). Handoffs read `Spec · Repo Skeleton`; reviews and escalations are never labelled as people. Assignment is deterministic (`fnv1a(child id)` over sorted ids, probing past claimed names), an explicit author name always wins, slugs and UUIDs are never printed as a person, and `scope` stays an immutable slug. Dictionary provenance: [`web/dashboard/NAMES.md`](web/dashboard/NAMES.md).
- **Graph**: Realtime Graphviz (WASM in the browser) of the session, workers/reviewers, handoffs, spec reviews, and escalations. Edges come from recorded ids (`handoffId`, `reviewRunId`, `supersededIds`, `childId`) — never from matching names or scopes. Kind is the primary encoding (manager `box3d`, worker rounded box, spec dashed `note`, review `hexagon`, spec review `folder`, escalation `octagon`) with status as a second layer; pan/zoom, “hide completed”, stable relayout only on topology change.
- **Motion**: 320 ms viewBox relayout, staggered node entry, edge draw-in, a slow ambient pulse for running workers only, and a 600 ms status flash — all CSS classes (no inline style, no SMIL, CSP unchanged) behind a full `prefers-reduced-motion` kill switch. Animation classes never enter the topology signature, so status updates still skip Graphviz.
- **Artifacts**: The session's effective catalog (branch + scoped-spec sidecars + ingested child artifacts), rendered as sanitized Markdown with `raw` toggle, version metadata, and live refresh. Bodies are fetched on selection; attachment HTML is never executed and remote images are blocked.
- **Health**: Producer connection state is shown separately from worker state. A disconnected Pi process never makes its workers look finished.

Bounds and trust: loopback only, separate producer/browser credentials, Host/Origin validation, size/count/SSE caps, no mutation endpoints. Snapshot projection is an allowlist — no transcripts, session-file paths, terminal tails, or credentials. Delivery is best-effort and coalesced, so a slow browser or dead server cannot block orchestration. Tests: `node --test tests/dashboard-*.test.ts`; `tests/dashboard-host-runtime.test.ts` drives a real Pi runtime, mode switch, detached server, and browser API end to end.



Tool: **`web_read`**. Opens and reads content from referenced web pages using a lightweight headless browser (`chromium_headless_shell` or `chromium` via `playwright-core`).

```text
Parameters:
- url: string (required) - URL to open and read (e.g. "https://example.com/docs")
- selector: string (optional) - Scoped CSS selector (e.g. "main", "article", "#content")
- waitForSelector: string (optional) - CSS selector to wait for before extracting
- format: "markdown" | "text" | "html" (optional, default: "markdown")
- timeoutSeconds: number (optional, default: 20, max: 60)
```

**Why a headless browser reader is needed:**
- Direct HTTP fetchers (like `fetch_content` via `undici`) fail on Single Page Applications (React, Vue, Next.js, Vitepress, GitBook) and JavaScript-rendered documentation, returning empty shells (`<div id="root"></div>`) or "Please enable JavaScript".
- Interactive browser agents (like `betterwright`'s `browser` tool) are heavyweight, require complex script authoring (`code: string`), launch stateful browser daemons, and are blocked in Plan mode.
- `web_read` bridges this gap: it executes client JavaScript in an ultra-lightweight headless shell, aborts images/media/fonts to keep bandwidth and latency minimal, extracts structured Markdown directly from the rendered DOM, and is annotated with `readOnlyHint: true` (and allowlisted in `PLAN_TOOLS`) so it works safely in both Normal and Plan modes.

Verification: `node --experimental-strip-types --import ./tests/isolate-env.mjs --test tests/web-read.test.ts` covers binary resolution, Playwright loading, tool registration, read-only policy compatibility, DOM-to-markdown extraction, selector scoping, text formatting, truncation bounds, and abort signal handling.

## Research / design references

- [Pi extension guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md): native tools, sequential execution, branch-aware state, lifecycle hooks, nested tool calls, and UI availability.
- [Official todo example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/todo.ts): session-local todo state and branch reconstruction. The example does not itself conditionally enforce a work plan.
- [Official question example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/question.ts): model-callable clarification. Native dialogs were preferred here to keep RPC compatibility and avoid another custom UI/keybinding layer.
- [pi-model-router](https://github.com/yeliu84/pi-model-router/): prior art for virtual-model routing in Pi. This implementation keeps routing provider-agnostic and adds per-provider account pools, which that project does not provide.
- [Pi virtual models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/virtual-models.md): `registerVirtualModel`, route reasons (`user`/`continuation`/`retry`/`direct`), and why continuations stay on the answering model.
- [Herdr subagents](https://github.com/modem-dev/pi-herdr-subagents), especially its completion/question handshake (ported here as `orch_done` / `orch_ping` and parent `orch_resume`; the vendored `orch-child.ts` is the local fork). Herdr's completion/question protocol is unchanged; only the control-tool allowlist adds the companion milestone and workflow assessment tools.
- [pi-antigravity](https://github.com/Rahularya01/pi-antigravity) by Rahul Arya (MIT): the Antigravity / Cloud Code Assist provider, vendored under `vendor/antigravity/` so this package needs no npm dependency for it. The multi-account layer on top — one provider per account — is this package's own.
- [ascii.rest/aquarium](https://ascii.rest/aquarium/) by @bas3line (MIT): ASCII fish tank art, physics, and swimming animation equations. Adapted for compact terminal dimensions and sidebar lifecycle.

Implementation targets the **installed** Pi API (`@earendil-works`, `typebox`, actionable `turn_end`) rather than assuming upstream example versions match this fork.

## Verification

```sh
npm test
npm run typecheck
node --test docs/patches/vcc-tests/regression.mjs
```

Tests use `node:test`, stubbed Pi hooks/dialogs, and native Node 22 TypeScript stripping. Dev dependencies are only for type-checking; extension runtime imports are supplied by Pi. Tests cover all three extensions in all six load orders, failed/successful question-forwarding enforcement, real Pi provider-request injection, native compaction and saved-session reload, filesystem milestone delivery, branch isolation, stale-run outcomes, and read-only previews. A real Pi runtime uses a scripted in-process provider: no credentials, network or inference. Automated dashboard tests use mocked native dialog replies, not an actual interactive TUI. `npm test` runs the core and orchestrator suites together; the Herdr seam tests use the in-tree `vendor/pi-herdr-subagents` snapshot, so no sibling checkout is required. The pi runtime packages are peer dependencies, installed from the registry by `npm install --ignore-scripts --legacy-peer-deps`. No live parent session or child pane is restarted by tests.
