# Smart bash timeout

> Part of [pi-workflow-extensions](../README.md). Wall-clock and idle limits for `bash`, and the diagnostics on timeout.

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
