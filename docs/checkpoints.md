# Durable delegated-work checkpoints

> Part of [pi-workflow-extensions](../README.md). What the parent records about a child, and how VCC keeps that history small.

Command: **`/subagents`**. Parent tool: **`agent_history`**. Child tool: **`agent_progress`**.

- The parent records child identity, task, saved session path, pane/run identity, latest milestone, changed files, verification, next action/question, and terminal outcome. A compact widget shows recent/active work. `/subagents` lists running and completed history, opens saved checkpoints/results and transcript previews, displays a reopen command, and can explicitly request a follow-up resume for an ended child.
- **VCC Algorithmic History Distillation & Recall**: Instead of dumping monolithic raw transcripts (up to 30,000 characters) into model context, `agent_history` integrates with `pi-vcc`:
  - `vccSummary: true`: Generates a structured zero-LLM algorithmic summary (`[Session Goal]`, `[Files And Changes]`, `[Commits]`, `[Key Signals]`, and rolled-up `[Brief Transcript]`) directly from the child session branch (~95% token savings).
  - `query: "<regex>"`: Performs regex/keyword search over child session entries and returns indexed matches with pagination.
  - `expand: [<indices>]`: Expands only the requested entry indices in full untruncated detail, avoiding token bloat.
  - Terminal child completion automatically compiles a VCC summary into the parent's recorded summary.
- Dashboard previews use native editor dialogs for scrolling/copying; edits are **discarded**. They never edit child files. Transcripts are read only on request, use the active child branch, omit thinking, and show at most 40 text/tool entries / 30,000 characters. Files over 16 MiB must be reopened directly. The parent tool only reads children admitted by launches/checkpoints on the active parent branch—not arbitrary file paths or late off-branch results.
- Registry entries live in the parent session as `subagent-checkpoint:v1`. Every model request receives a fresh, bounded (14,000-character) checkpoint snapshot, including after native/VCC compaction **and** the separate 20% auto-compactor. Old records omitted by the bound remain accessible through history. No full child transcript is copied into every prompt, and no extra summarizer/model call is added. The snapshot adds context tokens to the existing request.
- Children publish meaningful milestones with `agent_progress`, not every tool call. Changes made through `workflow_todo` also publish automatically when that tool is allowed. Atomic, private `<child-session>.progress-checkpoint.json` sidecars carry only the latest milestone; event-driven filesystem notifications update the parent's widget/checkpoint journal. They do **not** wake the parent model or spend inference tokens. The next ordinary request receives the latest checkpoint. Completion still uses Herdr's existing automatic result delivery; questions needing an answer still use `agent_ping` / `ask_user`.
- Progress is not completion. A blocked-but-running milestone cannot offer a resume action. Terminal results are correlated with pane identity so delayed results from an old run cannot terminate a resumed writer. Sidecars are matched to both session path and run ID, and only previously accepted milestones establish progress ordering.
- Registry recovery is not process recovery. After reload/restart, unfinished records are labeled **unverified**: the companion restores history and milestone watching, but it does not recreate Herdr's in-memory completion watchers or prove that a child is alive. Do not reload while children are running. Check their existing panes first; never open/resume the same session concurrently. No automatic restart or duplicate writer is created.
- Existing saved launches/results on the active branch are reconstructed when possible. Old children that predate activation cannot emit the new milestone tool until they are restarted/resumed after activation. Restricted profiles receive `agent_progress` and `workflow_todo` through a minimal local Herdr control-tool allowlist patch (otherwise the existing todo guardrail would block those children before assessment). If disabling this companion entirely, revert that compatibility patch too.

Example child milestone:

```json
{"summary":"Fixed auth validation","files":["src/auth.ts"],"verification":"3 regression tests pass","next":"Review the patch","blocked":false}
```

### Activation, installed-package fixes, and rollback

This directory is already configured in `~/.pi/agent/settings.json`; the manifest now includes the checkpoint extension. **After all children finish**, restart Pi or use `/reload`. No live session is automatically reloaded by this installation.

The installed VCC compaction/recall patch keeps VCC's **zero-LLM algorithmic compiler**. It fixes selection of projected custom/branch messages and stable recall indexing; it is not a lossless summarizer. See [`docs/patches/vcc-tests/README.md`](patches/vcc-tests/README.md) for exact changes, tests, retention/index behavior, rollback, and limitations. Your separate 20% auto-compactor is left intact; the request-local checkpoint hook covers that path.

Patches are under `docs/patches/`:

- `vcc-projected-compaction-recall.patch` + `vcc-tests/`: the installed VCC sources' fix and its regression harness.
- `herdr-context-fork.patch`, `herdr-progress-control.patch`, `herdr-auto-complete.patch`, `herdr-terminal-error-shutdown.patch`: the local `pi-herdr-subagents` changes. The source they apply against is vendored at [`vendor/pi-herdr-subagents`](../vendor/pi-herdr-subagents) — see its `VENDORED.md` for provenance and the exact date the snapshot was taken.
- `VERIFICATION.md`: how each patch was verified.

Package updates/reinstalls can overwrite the installed VCC/Herdr edits. Check patch compatibility and rerun tests before reapplying; do not blindly replace either package with the backups. To remove only this feature, disable `extensions/subagent-checkpoints.ts` with `pi config` (or remove it from the manifest), revert `herdr-progress-control.patch`, then safely restart. Existing checkpoint/session files remain available as history. VCC's independent fix can remain enabled.
