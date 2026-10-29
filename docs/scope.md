# Access scope: workspace by default

> Part of [pi-workflow-extensions](../README.md). Which paths agent tools may touch, what happens outside the workspace, and how to grant more.

Pi's working folder decides where tools *start*, not what they may reach.
`read`, `grep`, `find`, `ls` and `bash` run with the permissions of the Pi
process, so `read ~/.ssh/config` or `cat ../../secrets` succeeds silently while
the transcript says nothing unusual happened. This extension adds the missing
question:

```text
inside the workspace      → allowed, no dialog
a sensitive read          → asks (keys, cloud credentials, dotenv files)
outside, ordinary         → reads are open; writes ask
explicitly denied         → blocked, even under yolo
a delegated child         → never asks the user; escalates to its parent
```

It is a **policy, not a sandbox**. Read [Limits](#limits) before relying on it.

## Model

Five pieces, in the order they decide anything. The vocabulary is opencode's
`permission` system on purpose; the fourth and fifth are where we are more
conservative than it is.

1. **One triple, three effects.** A rule is `{action, resource, effect}`:
   `action` is a tool name, or `external_directory` for a boundary escape, and
   `resource` is what the tool touches — a path for `read`, a parsed segment for
   `bash`. `effect` is `allow`, `ask` or `deny`.
2. **Last match wins, and no match is not an allow.** `*` matches any run of
   characters, `?` exactly one, everything else literally. Order is policy, so a
   config's rule order is preserved verbatim. A rule set with no match falls
   through to the defaults, never to a silent yes.
3. **Deny is computed before grants.** A `deny` is checked before roots, before
   yolo, before a hook and before anything a "yes" saved earlier, so nothing
   accumulated in a session can re-open what a config closed.
4. **A policy hook has the last word — except about `deny`.** opencode triggers
   `permission.evaluate` so a plugin can rewrite the computed effect; this gate
   does the same through `GateDeps.onEvaluate`, and its first client is the
   sensitive-read rule below. A hook may tighten or relax `allow`/`ask`; it is
   never consulted about a `deny`. That difference is what keeps a policy seam
   from becoming a hole.
5. **"Ask" is a request, not a modal.** The answers are `once`, `always` (a
   literal, printed grant) and `reject` — and a reject may carry a note, which
   reaches the model as `Do this instead: …` rather than a bare refusal.

## Quiet by construction

A question must be a boundary escape, never a parsing accident. The matcher is
therefore narrow on purpose:

- **A shell path comes from an argv slot, not from a slash.** `git -C <dir>`,
  `npm --prefix <dir>`, `tar -f <file>`, `cp` operands and redirection targets are
  path slots because the binary says so. `origin/main`, `HEAD:src/x`,
  `ghcr.io/a/b:1`, `2024/01/02` and a `grep -E 'a/b'` pattern are data.
- **An operand counts when it is path-shaped or actually exists.** A token that
  resolves nowhere is not a claim.
- **Posture is per claim**, taken from the segment's binary and sub-command:
  `sed -i` writes, `sed` reads, `git add` writes, `git status` reads. Only a
  command we cannot classify is judged as a write would be.
- **Device, `/proc` and scratch paths never ask.** `cmd 2>/dev/null` is not a
  boundary escape. (Exception: a workspace that itself lives in the temp root
  keeps its boundary, because there a sibling *is* an escape.)
- **A sensitive read always asks**: `~/.ssh`, `~/.aws`, `~/.config/gh`,
  `~/.config/gcloud`, `~/.kube/config`, `~/.netrc`, `~/.pgpass`,
  `~/.git-credentials`, `.env*`, `*.pem`, `*.key`, `*.p12`, `*.kdbx`, `id_rsa`.
  This is the shape Codex and Claude Code's sandbox take — reads free, dangerous
  reads named — and it is why `readExternal: "allow"` does not mean "no read gate".
  Templates (`.env.example`, `.env.sample`, `.env.template`) are documentation,
  not secrets, and never ask: a dialog in front of the file that merely lists the
  key names is how people learn to click through the one that matters.
- **A sensitive read survives yolo.** The arm approves *ordinary* outside paths.

`/scope log --stats` counts what actually asked, grouped by tool and by the paths
that were asked about most; that is the input a grant or a rule needs.

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
│   4  Deny with instructions…                              │
│   5  Edit a rule…                                         │
╰─ ↑↓ select · Enter choose · 1-5 · e rule · Esc deny ───────╯
```

- **Escape denies.** The hint says so; a dialog that closes on Escape is never
  approval, and an aborted turn is a denial.
- **A denial can say what to do instead.** Option 4 is opencode's reject stage:
  a note becomes `Do this instead: …` in the block the model reads, and Enter on
  an empty note is a plain deny. Escape inside the stage returns to the question,
  so opening it cannot accidentally answer it — the same reason a closing dialog
  is never consent.
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

## Wildcard folders

A root may be a glob, which is how "these folders are mine" is said once:

```json
{
  "roots": [{ "path": "~/projects/*", "access": "rw" }, { "path": "../reference/*", "access": "ro" }]
}
```

Safety is decided by the **literal prefix**, which a `*` can never escape: a
pattern whose prefix is `/`, `$HOME`, a system tree, or a directory containing the
workspace is refused with a problem line rather than stored, and a pattern whose
prefix does not exist says so instead of granting silence. Specificity is that
same literal prefix, so `~/projects/*` beats `~/projects`, and a nested read-only
root still wins over a broad read-write one.

## `/scope`

| Command | Effect |
|---|---|
| `/scope` or `/scope status` | Roots with access and provenance, the three defaults, rule count, config files, yolo state |
| `/scope allow <path> [--ro\|--rw] [--project\|--global]` | Add a root (a glob is allowed) for this session, the project, or every project |
| `/scope deny <path> [--project\|--global]` | Deny the path and everything under it (writes `dir` and `dir/*`) |
| `/scope remove <path>` | Drop a session root |
| `/scope remove --rule <tool\|*> <glob> [--project\|--global]` | Revoke one rule by the name `/scope rules` lists it under |
| `/scope reset` | Drop session roots and rules; config and the workspace root stay |
| `/scope rules` | The numbered effective rule table, last match wins, with provenance |
| `/scope test <path>` | Dry run: prints the decision and the rule or root that produced it |
| `/scope log [n] [--stats]` | Recent decisions, or a summary by tool and asked-about path |
| `/scope yolo [on\|off\|all\|status] [--persist]` | Auto-approve the remaining questions |

## Delegated children

A child **inherits configuration, not approvals**. A fork-seeded child carries
its parent's branch verbatim, so its `agent-scope:v1` snapshot is ignored: it
starts from the workspace root plus the project and global config, with no
parent session roots, no parent rules and no inherited yolo arm.

When a child hits the boundary it does not open a dialog in a pane nobody is
watching, and it does not silently inherit the parent's answer. It is blocked
with the ladder spelled out, asks its parent with `agent_ping`, and applies the
reply with `scope_answer`:

```text
scope_answer({ decision: "allow-once" | "allow-folder" | "deny", path: "/srv/data", access: "ro" })
```

The decision lands on the child's own branch and in `/scope log` (`source:
parent`), so a retry is judged by the same policy as everything else, a denial
cannot be re-asked in a loop, and a fork cannot inherit either.

## `/scope yolo`

`yolo` is opencode's `--auto` restricted to this gate: it converts `ask` into
`allow` and **never** touches a `deny`. It also never approves a sensitive read —
a private key, a cloud credential, a real `.env` — because arming an arm to stop
nagging about folders says nothing about publishing secrets.

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

## Configuration

`.pi/scope.json` in the workspace, or `~/.pi/agent/scope.json` globally. Project
values override global ones; branch grants are layered on top.

```json
{
  "roots": [
    "../shared-docs",
    { "path": "~/scratch", "access": "ro" },
    { "path": "~/projects/*", "access": "rw" }
  ],
  "defaults": { "external": "ask", "readExternal": "allow", "unknown": "ask" },
  "rules": [
    { "action": "read", "resource": "**/.env*", "effect": "deny" },
    { "action": "bash", "resource": "git push *", "effect": "deny" },
    { "action": "mcp__fs", "resource": "*", "effect": "allow" }
  ],
  "mcp": { "mcp__fs": { "pathField": "path" } }
}
```

- `roots` accept strings (`rw`) or `{ path, access }`; relative paths resolve
  against the workspace, `~` against your home directory. A `*` makes it a
  wildcard root (see above).
- `defaults.external` is the answer for a **write** outside every root (`ask` by
  default). `defaults.readExternal` is the answer for an ordinary **read**
  outside every root (`allow` by default; a sensitive read still asks, and
  `"ask"` here makes every outside read prompt). `defaults.unknown` is the answer
  for a tool whose inputs this extension cannot map — a new MCP server, a
  dispatcher (`ask` by default; choose `deny` for a strict setup).
- `rules` are `{ action, resource, effect }`, matched with opencode's wildcards
  (`*` any run of characters, `?` exactly one) and **last match wins**. Put the
  catch-all first and exceptions after it. A leading `~`/`$HOME` in `resource`
  expands. A rule keyed on a tool name (`{"action":"mcp__fs","resource":"*",
  "effect":"allow"}`) is how a tool that declares no paths is silenced for good.
- `mcp` maps a server's path field so its calls can be judged instead of asking
  once per call.
- `yolo` is deliberately **not** configurable: a file that sets it is reported
  and ignored, so arming always takes a keystroke.

Migrating an older file: nothing has to change. A root ending in `*` used to be
accepted and silently inert; it now works, and a pattern that could re-expose
`$HOME` is refused with a message rather than ignored.

## What is remembered where

| Answer | Stored | Survives reload/resume | Survives fork | Survives a new session |
|---|---|---|---|---|
| Allow once | memory | no | no | no |
| Allow this folder | branch snapshot | yes | only in the branch that has it | no |
| `scope_answer` (child) | branch snapshot | yes | no | no |
| `/scope allow --project` | `.pi/scope.json` | yes | yes | yes |
| `/scope allow --global` | `~/.pi/agent/scope.json` | yes | yes | yes |
| `/scope yolo --persist` | branch snapshot | yes | only in that branch | no |

Branch records are full snapshots, so replaying them is idempotent and a grant
cannot leak into a fork that never saw the question (opencode #30779). A stored
grant that would re-expose `$HOME`, `/`, or a directory containing the workspace
is refused with a warning when the session loads, and a seeded child ignores the
whole inherited snapshot.

## Where the gate sits

- `read`, `write`, `edit` claim their `path`; `grep`, `find`, `ls` and the
  fff equivalents claim their search directory (cwd by default).
- `bash` is split into `|`/`&&`/`;` segments and each one is judged by its binary:
  operands and path-valued flags are claims, `>` writes, `<` reads. A bare
  relative filename is not a claim, because it resolves inside the workspace.
- A command a tokenizer cannot model (`$(…)`, backticks, `<(…)`, `bash -c`,
  `xargs`, `find -exec`, a heredoc fed to an interpreter) is **opaque**: it asks
  once per call, the message names the construct, and a rule for the tool is the
  way to stop asking.
- A **heredoc is data, not code**: `git commit -F - <<EOF` keeps working. It is
  opaque only when an interpreter reads the body (`python3 <<EOF`), because then
  the body is a program.
- Session-state tools (`todo_*`, `artifact_*`, `ask_user`, delegation) claim
  nothing. An unmapped tool is *unknown* unless it declares `readOnlyHint`
  (and `destructiveHint` outranks that).
- Read-only roots allow reads and ask before a write; `--ro` is how you grant
  "look, don't touch".

## Differences from opencode

Deliberate, and each one is a failure we did not want to import:

| | opencode | here |
|---|---|---|
| Read-only trees | none; per-action rules | typed `ro` roots |
| Saved pattern | tool-chosen, can widen to the VCS root (#52715) | printed literally before it is saved |
| Grants | project-scoped rows, leak into forks (#30779) | branch snapshots; forks only keep their own |
| Unanalyzable command | scanner error | opaque, named, coverable by a rule |
| Sibling git worktree | inside the project | outside: it asks, and `/scope status` says why |
| Denial | reject is bare, or carries a message the model reads | same, as the dialog's fourth answer |
| Policy hook | a plugin may flip a `deny` into an `allow` | a hook is never asked about a `deny` |

## Limits

This raises the cost of an accident. It does not contain a determined escape:

- **Not an OS sandbox.** Pi itself, extensions, plugins and MCP servers run with
  the process's permissions. Containers/VMs remain the only real boundary — see
  [Run Pi safely](../node_modules/@earendil-works/pi-coding-agent/docs/security.md).
- `bash` can leave the workspace in ways a tokenizer cannot see: `bash -c`,
  `find -exec`, `git -C`, interpreters, subshells. Those become *opaque* when
  they are recognizable; the rest is a heuristic. This is why the real fix for a
  strict setup is an OS sandbox, not a better parser — see [Limits](#limits).
- A symlinked ancestor is resolved with `realpath`, so `link -> /etc` is judged
  by its target. A path created *after* the check is not.
- Network egress, secret redaction and resource cost are out of scope.
- Extensions that run their own tool calls outside `tool_call` (or replace the
  editor and bypass hooks) are not gated.

## Verification

`tests/scope-glob.test.ts` and `tests/scope-paths.test.ts` cover wildcard and
last-match semantics, `~`/`..`/symlink classification, wildcard roots and the
narrowest-grant rules. `tests/scope-tool-paths.test.ts` covers the argv-slot
table, posture and the opaque cases. `tests/scope-policy.test.ts` covers the
decision order, special paths, sensitive reads, the `.env` template exception,
the yolo narrowing and rule-silenced tools.
`tests/scope-ask.test.ts` covers the dialog's keys, the literal glob row, the
reject stage and narrow widths. `tests/scope-gate.test.ts` covers the queue, allow
once, folder grants covering queued calls, deny, deny-with-a-note, rule answers,
duplicate rule answers, the policy hook and fail-closed dialogs.
`tests/scope-state.test.ts` covers config merge, wildcard validation, `~`
expansion in rules, broken files, refused stored grants and snapshot replay.
`tests/scope-command.test.ts` and `tests/scope-audit.test.ts` cover parsing,
reporting, stats and the bounded log. `tests/scope-runtime.test.ts` boots the
extension against a fake Pi and checks the wired behaviour end to end.
