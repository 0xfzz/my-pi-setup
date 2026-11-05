# Stream recovery

> Part of [pi-workflow-extensions](../README.md).

`extensions/stream-recovery.ts` saves generated text when an endpoint disconnects
while the model is still emitting a `write` or multiline `bash` tool call. The
`recover_stream` tool continues from the saved prefix instead of making the model
regenerate the entire file or command.

## Why this exists

A response ending with `upstream stream ended before completion` can contain a
nearly finished tool call. Pi correctly refuses to execute that incomplete call.
However, its next request may omit the failed response, so a plain “continue”
generates the same large document again. The motivating session had two such
unexecuted writes of the same PRD, the second approximately 19 KB long.

This extension preserves that work separately from model context. It does **not**
repair the endpoint, resume the original HTTP stream, or guarantee zero wasted
tokens. Only complete lines are retained: the final partial line is regenerated
to avoid trusting a streaming JSON parser's repaired trailing escape.

## Enable

Included in this package's `pi.extensions` manifest. If the package is already
installed, run `/reload` in the session after updating it. Otherwise:

```sh
pi install /path/to/pi-workflow-extensions
```

For an old session created before the extension was loaded:

1. `/resume` that session.
2. `/stream-recovery import` — checkpoint its latest failed assistant response
   (ignoring trailing aborted responses); this does not execute anything.
3. `/stream-recovery resume` — ask the agent to generate only the missing suffix.

Import reads only the active branch, refuses to run while busy, and will not
resurrect failures preceding a completed assistant response. Explicitly discarded
or consumed drafts stay retired.

## Normal operation

- On a failed assistant response, store complete-line prefixes in branch-local
  custom session entries. No target file is changed and no command runs.
- On the next request, provide the draft ID, version, target, saved length, and
  last 1200 characters. Do not resend the whole draft. Native Pi retries also
  receive this hint, even if Pi removes the failed response from model context.
- The model calls `recover_stream` with the ID, version, and **only new text**.
  `finish: false` saves another newline-terminated chunk without execution.
  `finish: true` combines prefix and suffix, then calls the original `write` or
  `bash` through `ctx.executeTool`. Existing permission hooks, tool overrides,
  smart timeouts, rendering data, and nested-call accounting still apply.
- A second disconnect while generating `recover_stream` checkpoints the completed
  lines of that suffix too. The version changes so stale retries cannot append a
  chunk twice.
- After native retries settle, an interactive/RPC stream disconnect can trigger
  at most **two extra continuations**, after 2 and 4 seconds. No extra automatic
  continuations run in print/JSON mode. Aborted runs, pending user messages, new
  user input, session replacement/reload, and shutdown cancel pending recovery.
  Use `/stream-recovery off` to cancel recovery during the backoff.

The model still decides whether a draft is relevant to the current request. Its
saved contents are tool data, not instructions. For long output, it is instructed
to stage small suffix chunks (~2000 characters).

## Commands

| Command | Effect |
| --- | --- |
| `/stream-recovery` or `status` | Show pending IDs, versions, sizes, and automatic recovery state. |
| `/stream-recovery off` / `on` | Persist automatic recovery preference on the active branch. Native Pi retries are unaffected; saved prefixes remain available. |
| `/stream-recovery resume` | Explicitly continue using saved drafts. |
| `/stream-recovery import` | Import the latest eligible failure from a pre-extension session. |
| `/stream-recovery discard <id>` | Retire an obsolete pending draft without executing it. |

`recover_stream({ id })` inspects a draft's last 6000 characters without executing
anything. Larger drafts are not printed in full.

## Safety and limits

- **Never execute partial commands.** Even syntactically valid partial arguments
  on an error response are drafts, not completed calls. Finalization requires a
  newly completed tool call with `finish: true`.
- **Do not replay side effects.** Before dispatching the original tool, persist
  an `executing` marker. That draft is never runnable again, including when the
  tool fails, is blocked, times out, or the process dies during execution. Inspect
  effects/results before issuing a fresh tool call. Recovery is deliberately
  at-most-once, not a claim of transactional or exactly-once execution.
- Writes fingerprint the local target when checkpointed and refuse finalization
  if it has changed. This is an optimistic check, not a filesystem transaction.
  Remote write backends are not covered by the local fingerprint.
- Successful ordinary writes retire pending drafts for that target, so an agent
  that elects to regenerate will not also replay the saved draft later.
- Up to 8 pending drafts, each at most 1 MiB. No recovery for `edit`, unsupported
  tools, malformed arguments, single-line output without a complete newline, or
  manually aborted generation. Over-limit drafts are skipped with a UI warning.
- No auto-resume on startup: drafts restore on `/reload`, `/resume`, and `/tree`,
  but resuming old work is explicit. Branching before an execution marker is an
  alternative history, not a rollback of filesystem or command effects.
- Drafts are persisted **when the failed response finalizes**, not per token.
  A process crash before that boundary is not covered. Recovering a command that
  was already executing is intentionally unsupported.
- Draft contents have the same sensitivity as tool arguments in session history.
  They are stored in the session, not in project files or a separate log.

## Verification

`tests/stream-recovery.test.ts` covers checkpoint boundaries, repeated cuts,
versions, branch restore, cancellation, stale files, and at-most-once dispatch.
`tests/stream-recovery-runtime.test.ts` drives a real Pi runtime with a scripted
endpoint: native retries and the exact motivating error both recover with only a
suffix, and the original tools execute through the normal nested tool pipeline.
