# Workspace artifacts

> Part of [pi-workflow-extensions](../README.md). Store, recall and edit plans, specs and scratchpads outside the chat turn.

Tools: **`artifact_save`**, **`artifact_edit`**, **`artifact_recall`**, **`artifact_search`**, **`artifact_list`**. Command: **`/artifacts`**.

- Decouples heavy specifications, architecture roadmaps, schemas, and scratchpads from conversational chat turns.
- **Ultra-light catalog injection**: Pi's `context` hook injects a compact index (~50 tokens) of active artifacts into model prompts (`artifact-catalog:v1`). The model recalls full text on demand with `artifact_recall({ id })`.
- **Partial reads and edits**: `artifact_recall({ id, offset, limit })` returns a 1-based line range with an `NNN│ ` gutter instead of the whole document, and `artifact_edit` changes part of an existing artifact (`append`, `replace`, `insert`, `replaceLines`) instead of forcing a full rewrite through `artifact_save`. `artifact_search` reports artifact, line and column for a text or regex hit, so the caller can jump straight to the relevant range. Each edit bumps the artifact version and keeps the same placement rules as `artifact_save` (child staging, parent sidecar-only scoped specs).
- **Subagent-to-main IPC**: When a subagent calls `artifact_save`, the artifact is written to an atomic staging sidecar (`<child>.artifact.<id>.json`). The parent process automatically detects and ingests it into the **main conversation branch** via `pi.appendEntry("artifact:v1")`, ensuring artifacts are never trapped inside child sessions.
- **Branch-aware & compaction-proof**: Stored in session `custom` entries. State is reconstructed from `SessionManager.getBranch()` on reload, resume, and tree navigation. Compaction retains active artifacts automatically.
- **Interactive browser**: `/artifacts` (or **Alt+W → E**) opens a scrolling picker — `↑↓/jk`, `PgUp/PgDn`, `Enter`, digits `1`–`9`, `Esc` — and a bordered markdown detail popup. The detail body renders through Pi's markdown library (tables, quotes, lists, code) and supports **`/` search** with match highlighting and `n`/`N` navigation. **`o`/`v`** pauses the TUI, writes the artifact to a temp `*.md` file (so nvim gets markdown syntax), opens `$PI_EDITOR`/`$VISUAL`/`$EDITOR` (falling back to `nvim`, then nano/notepad), and restores the TUI when the editor exits. If the buffer changed, the edit is saved back through the normal artifact placement rules as a new version; an unchanged buffer creates no version.
- **`@` mentions**: Type `@` and search by artifact ID, title, or tag, then select an artifact alongside the normal file suggestions. Selection inserts `@artifact:<id>` (for example, `Review @artifact:auth-spec` or `@artifact:blabalal.md`). Use `@artifact` (with or without the trailing `:`) to show only artifacts; the dropdown opens naturally while typing, without pressing Tab. Suggestions require saved artifacts on the current branch—ordinary files and chat messages are not automatically artifacts. Sending the message attaches a compact reference placeholder with artifact metadata and recall instructions instead of dumping full content into the prompt, keeping prompt input minimal so the agent recalls full content on the go with `artifact_recall`. Mentions support IDs with or without file extensions (e.g. `@artifact:blabalal.md`). Plain `@file` mentions remain unchanged. Missing/off-branch artifact IDs are reported as unavailable rather than silently using another branch. Explicit mentions also work in RPC/print input and resolve parent/staged artifacts in Herdr children. Uses Pi's public autocomplete wrapper without replacing the input-mode editor.

### Compatibility with FFF file mentions

Pi applies autocomplete wrappers in registration order: the last provider sees input first. FFF 0.11.0 returns matching files for `@…` without consulting earlier providers, so loading it after this package can hide artifacts. Keep `npm:@ff-labs/pi-fff` **before** `pi-workflow-extensions` in the `packages` array of `~/.pi/agent/settings.json`. This lets the artifact wrapper merge saved artifacts with FFF's fuzzy file results; `@artifact` remains artifact-only. No FFF tools or file search features need to be disabled. Restart or `/reload` after all children finish to apply the order.

An optional integration test loads the real installed FFF extension with isolated temporary files/databases and no model requests. It reproduces the conflicting order and verifies the corrected order:

```sh
PI_FFF_EXTENSION_PATH=/path/to/@ff-labs/pi-fff/src/index.ts \
  node --experimental-strip-types --test tests/artifact-mentions-fff.test.ts
```
