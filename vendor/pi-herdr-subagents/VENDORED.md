# Vendored: `pi-herdr-subagents`

This directory is a **source snapshot**, not a package you install. It exists so this
repository is self-contained: `extensions/orchestrator.ts` imports the Herdr launch
planner, socket client, watcher and message builders directly, and those files used to
live in a sibling checkout (`../pi-herdr-subagents`) that only existed on the author's
machine.

## Provenance

| | |
|:--|:--|
| Upstream | <https://github.com/modem-dev/pi-herdr-subagents> |
| Local checkout | `~/projects/pi-herdr-subagents` (working tree, including local patches) |
| Snapshot commit | `99422030a487da8edf7f0c90303377b654e011b6` (`feat: integrate workflow completion, auto-exit defaults, and control tool allowlist`) |
| Snapshot date | 2026-10-24 |
| License | MIT (upstream `author: Justin`); upstream README is copied alongside |

## What is included, and why

| Path | Needed by |
|:--|:--|
| `src/launch.ts` | `agent_spawn` / `agent_resume` launch planning, `buildSubagentToolAllowlist` |
| `src/herdr/client.ts`, `src/herdr/events.ts` | pane lifecycle (`paneStart`, `paneRead`, `paneSendKeys`), event stream |
| `src/watcher.ts`, `src/messages.ts` | child outcome detection and the messages delivered to the orchestrator |
| `src/agents.ts`, `src/settings.ts` | agent profiles (`tools:`, `model:`, `thinking:`) and subagent settings |
| `src/session.ts`, `src/context-*.ts`, `src/runtime-state.ts`, `src/context-usage.ts`, `src/model-picker.ts` | transitive imports of the above |
| `orch-child.ts` (package root) | **required at runtime**: `launch.ts` passes `join(PACKAGE_ROOT, "orch-child.ts")` as each child's `-e` control extension |
| `README.md` | upstream attribution and protocol documentation |

### Why `orch-child.ts` sits at the package root, not in `src/`

Every other source file is under `src/`, so the loose root file looks like an
oversight. It is deliberate. `launch.ts` resolves the child's control extension as
`join(PACKAGE_ROOT, "orch-child.ts")`, where `PACKAGE_ROOT` is `src/` one level up
— i.e. the package root, not `src/`. Moving the file into `src/` would silently
break every child launch, because `-e` would point at a path that does not exist.

This snapshot also preserves upstream's own layout rather than re-organising it:
a vendored tree should stay byte-close to the source it was taken from, so a
future re-copy is a clean diff instead of a merge. Note the table above once
referred to this file as `subagent-done.ts`, upstream's older name for the same
child extension; the file is `orch-child.ts` in the snapshot commit.

Deliberately **not** copied: upstream `test/`, `agents/`, `herdr-plugin/`, `index.ts`
(the v1 `subagent` tool surface, which this repository does not load), `docs/`, and
`package.json` (replaced below with a snapshot marker).

## Local modifications carried in this snapshot

The local checkout was ahead of the snapshot commit (17 modified files). The vendored
files therefore include local work on context forking, progress control, terminal-error
shutdown and the workflow completion contract. The human-readable record of that work is
in [`../../docs/patches/`](../../docs/patches/).

Behavioural changes made *in this repository* on top of the snapshot:

1. `src/launch.ts` — `SUBAGENT_CONTROL_TOOLS` now grants `todo_plan`, `todo_act` and
   `todo_next` alongside the deprecated `workflow_todo` shim. Without them every child
   launched with a restricted `tools:` profile lost the v2 todo surface while its prompt
   still told it to use it. See `tests/orchestrator-child-guard.test.ts` and the artifact
   `qa-orch-todo-investigation`.
2. `src/launch.ts` — `ResumeLaunchParams.model` and a `--model` argument on the resume argv, so a failed child can fail over to another model of its role pool.
3. Type-only corrections so `npm run typecheck` is clean (no runtime change).

## Updating the snapshot

Re-copy the files listed above from the upstream checkout, re-apply the control-tool
addition in `src/launch.ts`, and run `npm test && npm run typecheck`. The imports are
`../vendor/pi-herdr-subagents/src/...` — keep them relative so the repository stays
portable.
