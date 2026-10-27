# Subagent fork context and Plan-mode state fixes

| Field | Value |
| --- | --- |
| **Status** | implemented fix record |
| **Detail for** | [README § Delegated-work checkpoints](../README.md) |
| **Scope** | `vendor/pi-herdr-subagents/`, `lib/plan-mode.ts`, `lib/modes.ts` |
| **Verified against** | validation steps recorded below |
| **Related** | [Original audit](CONTEXT-FORKING-SUBAGENT.md) |

## Summary

- Fork context is now tree-aware: a linear prefix kept abandoned branches and dropped the investigation before delegation.
- The child keeps the work that happened immediately before it was spawned, which is the whole point of the fork.
- Plan/Normal mode state is synchronized so a switch is reflected rather than remembered from an earlier turn.
- Activation steps are listed at the end; nothing here needs a live session reload.

## Scope

This tracks the fixes requested in `@artifact:fix-subagent-bug` and the report that an agent sometimes claims Plan mode is still active after switching to Normal.

The original artifact is a historical diagnosis, not executable code. Its sample `slice(0, cutoffIndex)` implementation is insufficient: Pi session files are trees, so a linear prefix can include abandoned branches. The artifact also incorrectly says the original code keeps the final user message; the exclusive slice actually removes that message too.

## Fork context: implemented

The original Herdr `getForkContentLines()` scanned backward to the last user message and discarded that message and everything after it. This lost the investigation performed immediately before delegation.

The installed package already contained a partial correction at the start of this work: active-branch reconstruction, a `subagent-context:v1` provenance marker, and companion child-policy isolation/parent recall. However, it still dropped a trailing user request and inferred the live branch from the disk tail.

The completed fix:

- Captures `sessionManager.getLeafId()` when delegating and threads it through `index.ts` and `src/launch.ts` into `src/session.ts`.
- Walks the selected leaf's `parentId` chain, not a linear file prefix or a later abandoned disk branch. An explicit missing leaf fails instead of silently choosing a different branch; an explicit null leaf seeds an empty branch.
- Retains the latest user request, assistant findings, tool results, and compaction entries on that branch.
- Adds explicitly unsuccessful placeholders for inherited tool calls that have no result at fork time. These say the call was not executed by the child; they do not fabricate successful tool output. Assistant content is preserved. All following entries are rechained so even multiple inserted placeholders remain reachable from the child leaf.
- Keeps the provenance marker attached to the copied branch and preserves its original parent boundary, character/token estimate, and redaction metadata. The parent file remains read-only.

If an older host or minimal mock does not expose `getLeafId()`, file-tail selection remains a compatibility fallback; it cannot establish a live branch reliably after tree navigation. Full forks are not automatically truncated to fit a smaller model. Use digest mode or an appropriate context-window model when needed. Secret-pattern redaction is only a best-effort seatbelt, not comprehensive DLP.

Source: `~/.pi/agent/git/github.com/0xfzz/pi-herdr-subagents/`.
Reproducible local patch: `patches/herdr-context-fork.patch`.

## Plan/Normal mode: implemented

Files:

- `extensions/modes.ts`
- `lib/plan-mode.ts`
- `tests/plan-mode.test.ts`
- `tests/mode-transitions-runtime.test.ts`

Previously, the extension updated structured system sections before an agent run, but old assistant messages and compaction summaries could still insist that Plan mode was active. The live execution policy was not necessarily wrong; its current state needed to be made explicit near the end of each model request.

The extension now appends one hidden, request-local `<current-input-mode>` reminder through the `context` hook before every model call, including tool-loop continuations. It:

1. Synchronizes with the selected branch's current policy, using the same state as the execution guard and mode UI.
2. Explicitly says whether Plan is ON or OFF.
3. Tells the model that historical mode instructions, assistant claims, and compaction summaries are not the current mode.
4. Removes older copies of its own reminder without editing user/assistant history.
5. Remains request-local: it is not persisted and does not trigger inference by itself.

The deterministic Plan-mode tool and shell guards remain in place. Normal mode still respects tool availability and ordinary safety/permission rules; it does not automatically grant all tools or approvals. Mode changes during active work are still refused.

Structured prompt sections are retained. Installed Pi supports append-only system/tool deltas, so the old audit's blanket claim that every section change rewrites the entire cached prefix is not a sound basis for removing them. Cache behavior remains provider-dependent.

## Final validation

- Workflow suite: **608 passed, 1 skipped**, no failures.
- Installed Herdr suite: **273 passed**, no failures.
- Final focused fork/mode regression run: **39 passed**, including 12 fork-seed cases and all mode-transition matrix cases.
- Reproducible fork patch: forward application checked against a clean archive of Herdr HEAD (`9942203`); reverse application checked against the installed patched checkout.
- Focused mode, lifecycle, and child-isolation coverage: **50 passed** against the project's Pi 1.3.0 dependencies.
- The same 50 focused tests: **50 passed** in an isolated fixture using installed Pi 1.4.0.
- Real Pi SDK tests use a scripted local provider, not external inference. They verify the provider-bound reminder, system sections, UI/policy agreement, restored tools, and an actual built-in file write after `/plan off`, `/mode normal`, and Shift+Tab; each path is also tested after compaction and/or resume.
- Unit coverage verifies deduplication, unchanged historical messages, no transcript growth, and missed branch-refresh recovery.
- Independent mode review: approved with caveats (`@artifact:mode-reminder-review`), with 53 focused mode/shell tests passing. Future third-party providers must preserve the request-local custom message correctly; reminder wording cannot guarantee an LLM will never make a stale-mode claim.
- `npm run typecheck` currently reports three errors outside the changed mode code: two in `extensions/account-router.ts` (possibly undefined `uiCtx`) and one in `tests/account-sources.test.ts` (missing `accounts`). These unrelated files were not changed for this fix.

## Activation

After all delegated agents finish, run `/reload` or restart Pi. Existing running extension instances are not automatically replaced by editing these files. Do not reload while children are still active.

Package updates can overwrite installed Herdr changes. Do not blindly apply the patch to an already patched checkout: inspect compatibility first and run the fork regression tests.
