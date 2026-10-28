# Access scope: workspace by default

> Part of [pi-workflow-extensions](../README.md). Which paths agent tools may touch, what happens outside the workspace, and how to grant more.

Pi's working folder decides where tools *start*, not what they may reach.
`read`, `grep`, `find`, `ls` and `bash` run with the permissions of the Pi
process, so `read ~/.ssh/config` or `cat ../../secrets` succeeds silently while
the transcript says nothing unusual happened. This extension adds the missing
question:

```text
inside the workspace   → allowed, no dialog
outside the workspace  → asks; the answer is remembered per branch
explicitly denied      → blocked, even under yolo
```

It is a **policy, not a sandbox**. Read [Limits](#limits) before relying on it.

## The question

```text
╭─ Access outside the workspace ────────────────────────────╮
│ read  ../shared/config.yaml                               │
│ outside the workspace: /home/u/shared/config.yaml         │
│                                                           │
│   1  Allow once                                           │
│ › 2  Allow /home/u/shared (read-only · session)           │
│      saves /home/u/shared/*                               │
│   3  Deny                                                 │
│   4  Edit a rule…                                         │
╰─ ↑↓ select · Enter choose · 1-4 · e rule · Esc deny ───────╯
```

- **Escape denies.** The hint says so; a dialog that closes on Escape is never
  approval, and an aborted turn is a denial.
- **The grant is literal and visible.** Option 2 prints the exact glob it will
  save. Widening is never implicit — the failure that made one opencode approval
  a standing `$HOME` grant was an invisible `save` pattern (opencode #52715).
- **The offer is the narrowest useful one.** A file grants its directory
  (`dir/*`). If that directory is `$HOME`, `/`, a system tree, or a directory
  that contains the workspace, the option degrades to *Allow only this file*
  instead.
- **One question at a time.** Parallel tool calls queue; an "allow this folder"
  answer re-evaluates the calls waiting behind it, so five reads in one outside
  directory cost one question.

## `/scope`

| Command | Effect |
|---|---|
| `/scope` or `/scope status` | Roots with access and provenance, both defaults, rule count, config files, yolo state |
| `/scope allow <path> [--ro\|--rw] [--project\|--global]` | Add a root for this session, the project, or every project |
| `/scope deny <path> [--project\|--global]` | Deny the path and everything under it (writes `dir` and `dir/*`) |
| `/scope remove <path>` | Drop a session root |
| `/scope reset` | Drop session roots and rules; config and the workspace root stay |
| `/scope rules` | The effective rule table, last match wins, with provenance |
| `/scope test <path>` | Dry run: prints the decision and the rule or root that produced it |
| `/scope log [n]` | Recent decisions: auto-approved, asked, blocked |
| `/scope yolo [on\|off\|all\|status] [--persist]` | Auto-approve the remaining questions |

## `/scope yolo`

`yolo` is opencode's `--auto` restricted to this gate: it converts `ask` into
`allow` and **never** touches a `deny`.

| Form | Approves |
|---|---|
| `/scope yolo` | Reads outside the workspace |
| `/scope yolo all` | Reads and writes outside the workspace |
| `/scope yolo --persist` | Same, and survives reload/resume via a branch record |
| `/scope yolo off` | Disarm |

While armed it is never quiet: the rail shows `Scope · YOLO(ro)` in the warning
tone, arming emits a warning that names the strength and the disarm command, and
a persisted arm is announced again on reload. Everything it approved lands in
`/scope log`, and a `deny` hit while armed is reported to the user, because that
is exactly where the assumption "yolo means anything goes" is wrong.

`yolo` also does not propagate to delegated children: a spawn gives the child
the parent's roots and no permission to ask, so a worker cannot inherit an
approval the user gave for the parent's own reading.

## Configuration

`.pi/scope.json` in the workspace, or `~/.pi/agent/scope.json` globally. Project
values override global ones; branch grants are layered on top.

```json
{
  "roots": [
    "../shared-docs",
    { "path": "~/scratch", "access": "ro" }
  ],
  "defaults": { "external": "ask", "unknown": "ask" },
  "rules": [
    { "action": "read", "resource": "**/.env*", "effect": "deny" },
    { "action": "bash", "resource": "git push *", "effect": "deny" }
  ],
  "mcp": { "mcp__fs": { "pathField": "path" } }
}
```

- `roots` accept strings (`rw`) or `{ path, access }`; relative paths resolve
  against the workspace, `~` against your home directory.
- `defaults.external` is the answer for paths outside every root (`ask` by
  default). `defaults.unknown` is the answer for a tool whose inputs this
  extension cannot map — a new MCP server, a dispatcher (`ask` by default;
  choose `deny` for a strict setup).
- `rules` are `{ action, resource, effect }`, matched with opencode's wildcards
  (`*` any run of characters, `?` exactly one) and **last match wins**. Put the
  catch-all first and exceptions after it.
- `mcp` maps a server's path field so its calls can be judged instead of asking
  once per call.
- `yolo` is deliberately **not** configurable: a file that sets it is reported
  and ignored, so arming always takes a keystroke.

## What is remembered where

| Answer | Stored | Survives reload/resume | Survives fork | Survives a new session |
|---|---|---|---|---|
| Allow once | memory | no | no | no |
| Allow this folder | branch snapshot | yes | only in the branch that has it | no |
| `/scope allow --project` | `.pi/scope.json` | yes | yes | yes |
| `/scope allow --global` | `~/.pi/agent/scope.json` | yes | yes | yes |
| `/scope yolo --persist` | branch snapshot | yes | only in that branch | no |

Branch records are full snapshots, so replaying them is idempotent and a grant
cannot leak into a fork that never saw the question (opencode #30779). A stored
grant that would re-expose `$HOME`, `/`, or a directory containing the workspace
is refused with a warning when the session loads.

## Where the gate sits

- `read`, `write`, `edit` claim their `path`; `grep`, `find`, `ls` and the
  fff equivalents claim their search directory (cwd by default).
- `bash` is tokenized: absolute paths, `~`, `./`, `../`, anything with a
  separator, and redirection targets are claims. A bare relative filename is
  not, because it resolves inside the workspace. Read-only-ness reuses the
  existing `readOnlyShellCommand` judgement, so `git -C ../repo status` asks
  for nothing while `rm -rf ../build` is a write.
- A command a tokenizer cannot model (`$(…)`, backticks, heredocs, `bash -c`,
  `xargs`, `find -exec`) is *unknown*: it asks once per call and cannot be
  covered by a folder grant.
- Session-state tools (`todo_*`, `artifact_*`, `ask_user`, delegation) claim
  nothing. An unmapped tool is *unknown* unless it declares `readOnlyHint`
  (and `destructiveHint` outranks that).
- Read-only roots allow reads and ask before a write; `--ro` is how you grant
  "look, don't touch".

## Limits

This raises the cost of an accident. It does not contain a determined escape:

- **Not an OS sandbox.** Pi itself, extensions, plugins and MCP servers run with
  the process's permissions. Containers/VMs remain the only real boundary — see
  [Run Pi safely](../node_modules/@earendil-works/pi-coding-agent/docs/security.md).
- `bash` can leave the workspace in ways a tokenizer cannot see: `bash -c`,
  `find -exec`, `git -C`, interpreters, subshells. Those become *unknown* when
  they are recognizable; the rest is a heuristic.
- A symlinked ancestor is resolved with `realpath`, so `link -> /etc` is judged
  by its target. A path created *after* the check is not.
- Network egress, secret redaction and resource cost are out of scope.
- Extensions that run their own tool calls outside `tool_call` (or replace the
  editor and bypass hooks) are not gated.

## Verification

`tests/scope-glob|paths|policy.test.ts` cover wildcard and last-match semantics,
`~`/`..`/symlink classification and the narrowest-grant rules.
`tests/scope-tool-paths.test.ts` covers the tool table, bash extraction and the
unknown cases. `tests/scope-ask.test.ts` covers the dialog's keys, the literal
glob row and narrow widths. `tests/scope-gate.test.ts` covers the queue, allow
once, folder grants covering queued calls, deny, rule answers and fail-closed
dialogs. `tests/scope-state.test.ts` covers config merge, broken files, refused
stored grants and snapshot replay. `tests/scope-command.test.ts` and
`tests/scope-audit.test.ts` cover parsing, reporting and the bounded log.
`tests/scope-runtime.test.ts` boots the extension against a fake Pi and checks
the wired behaviour end to end.
