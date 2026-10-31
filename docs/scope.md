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
5. **"Ask" is a request, not a modal.** The answers are `once`, three standing
   grants (this file or its folder, for this session or for this workspace) and
   `reject` — every grant is literal and printed, and a reject may carry a note,
   which reaches the model as `Do this instead: …` rather than a bare refusal.

## Jurisdiction: builtin path tools only

Scope judges a closed set of builtin tools whose inputs name a path:

```text
bash  read  write  edit  grep  find  ls  ffgrep  fffind
```

Everything else is **outside its jurisdiction**. That is not an approval and not
a denial — the call is not judged at all: no claim, no question, no rule, no
audit record.

- **MCP tools are out.** An MCP server's inputs are its own business, so gating
them would mean inventing path semantics the host cannot verify. Permission
rules here deliberately do not name MCP tools, and an MCP server can reach the
filesystem beyond this gate. That is a stated limit, not a silent promise.
- **Custom and session tools are out** (`todo_*`, `artifact_*`, `ask_user`,
  delegation, web and search tools). There is no "unknown tool" consent state and
  no `defaults.unknown`; the earlier per-tool consent question is gone.

A bypass cannot be widened later, because nothing is stored. What it does mean is
that Scope must not be mistaken for a complete gate: it governs the builtin tools
above and nothing more.

## Quiet by construction

A question must be a boundary escape, never a parsing accident. A bash path comes
from a **named channel**, never from the presence of a slash:

- **The call's directory.** The session cwd, after applying the configured shell
  command prefix: a `cd /repo &&` prefix moves the base, so relative claims are
  judged where the process will actually run. A prefix target that is computed or
  a glob is reported instead of guessed.
- **`cd` / `pushd` arguments.** A directory change is a read of that directory,
  and it moves the base for later segments. A `cd` inside a subshell does not
  move the outer base.
- **Redirection targets** (`>`, `>>`, `2>`, `<`, and a `tee` destination). These
  are the write and read channels a shell gives us explicitly.
- **An interpreter's entry script** (`node script.js`, `python3 -m mod`). The
  script is a read claim. In `node /c /e`, `/c` is that script and `/e` is an
  argument whose meaning belongs to the program, so only `/c` is a claim.
- **Mutator operands** (`cp`, `mv`, `rm`, `tar`, `ln`, `install`, …) when they are
  path-shaped or actually exist — the channel where a real write escape shows up.
- **Reader operands** (`cat`, `grep`, `ls`, `sed`) when they are path-shaped or
  exist. Data operands and data flags are excluded, so `grep -E 'a/b'`, a URL and
  a write-out format are never paths.

An **inline program is data**: `node -e '…'` and `python3 -c '…'` produce no path
claim and do not make the call unreadable, so a repo-local
`node -e 'require("./.e2e/run.json")'` runs quietly. A **shell's** `-c` argument
is different: `bash -c '…'` is another shell program the gate cannot read, so it
stays opaque and asks.

A binary with no table entry does not get its arguments guessed by shape or
existence. Its command text is still covered by rules, and its `cd` and redirect
channels are still judged, but an unknown program's arguments are its own.

Nothing above is a claim about data: `origin/main`, `HEAD:src/x`,
`ghcr.io/a/b:1`, `2024/01/02` and a pattern are never paths.

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
╭─ Access outside the workspace ──────────────────────────────────────╮
│ read  ../shared/config.yaml                                        │
│ outside the workspace: /home/u/shared/config.yaml                  │
│                                                                    │
│ › 1  Allow ../shared/config.yaml for once                          │
│   2  Always allow ../shared/config.yaml for this workspace         │
│      saves /home/u/shared/config.yaml in .pi/scope.json            │
│   3  Allow all /home/u/shared/* for once                           │
│      session only, not saved                                       │
│   4  Always allow /home/u/shared/* for this workspace              │
│      saves /home/u/shared/* in .pi/scope.json                      │
│   5  Deny with reason                                              │
│   6  Deny                                                          │
╰─ ↑↓ select · Enter choose · 1-6 · e rule · Esc deny ────────────────╯
```

The four grants are the two axes the question really has: **the target** (this
one file, or everything in its folder as `dir/*`) and **the lifetime** (this
session, or this workspace). "For once" on the folder row is the branch snapshot
— it covers the calls queued behind it but is gone after a restart; "for this
workspace" is a config write that a new session starts with.

- **Escape denies.** The hint says so; a dialog that closes on Escape is never
  approval, and an aborted turn is a denial.
- **A denial can say what to do instead.** Option 5 is opencode's reject stage:
  a note becomes `Do this instead: …` in the block the model reads, and Enter on
  an empty note is a plain deny. Escape inside the stage returns to the question,
  so opening it cannot accidentally answer it — the same reason a closing dialog
  is never consent.
- **The grant is literal and visible.** Options 2 and 4 print the exact value
  they store and the file they store it in. Widening is never implicit — the
  failure that made one opencode approval a standing `$HOME` grant was an
  invisible `save` pattern (opencode #52715).
- **The offer is the narrowest useful one.** A file grants its directory
  (`dir/*`). If that directory is `$HOME`, `/`, a system tree, or a directory
  that contains the workspace, the folder rows are not offered at all: the only
  standing grant is the file itself.
- **The rule editor stays behind a key.** `e` opens a prefilled
  `<tool> <glob> allow|ask|deny` line for the cases the six answers cannot say
  (a `deny`, a wildcard the dialog did not compute); it is not a seventh row, so
  the six answers keep their digits.
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
| `/scope` or `/scope status` | Roots with access and provenance, the three defaults, rule count, config files, yolo state, telemetry file |
| `/scope allow <path> [--ro\|--rw] [--project\|--global]` | Add a root (a glob is allowed) for this session, the project, or every project |
| `/scope deny <path> [--project\|--global]` | Deny the path and everything under it (writes `dir` and `dir/*`) |
| `/scope remove <path>` | Drop a session root |
| `/scope remove --rule <tool\|*> <glob> [--project\|--global]` | Revoke one rule by the name `/scope rules` lists it under |
| `/scope reset` | Drop session roots and rules; config and the workspace root stay |
| `/scope rules` | The numbered effective rule table, last match wins, with provenance |
| `/scope test <path>` | Dry run: prints the decision and the rule or root that produced it |
| `/scope log [n] [--stats]` | Recent decisions, or a summary by tool and asked-about path |
| `/scope telemetry [n]` | The global log, summarized: asked targets, repeated asks, detection gaps, deny rules that fired |
| `/scope yolo [on\|off\|all\|status] [--persist]` | Auto-approve the remaining questions |
| `/scope sandbox [status\|on\|off\|mode\|backend\|ask\|retry\|probe\|allow\|deny\|test]` | Kernel-enforced write sandbox for `bash` (Landlock, bubblewrap, Seatbelt) |

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

## Sandbox: kernel-enforced write boundaries for `bash`

While tools like `read`, `write`, `edit`, `grep`, and `find` carry discrete path
arguments that Scope checks deterministically in-process, `bash` executes
arbitrary shell programs where filesystem writes cannot be predicted reliably
from text alone.

Scope solves this by separating reads and writes:
- **Reads** remain open across the machine by default (`readExternal: "allow"`),
  with parser checks for sensitive paths (credentials, private keys, `.env` files).
- **Writes** are enforced at the OS kernel level:
  - Inside the workspace and granted read-write roots: unrestricted.
  - Outside the workspace: denied by the kernel (`EROFS` or `EACCES`).
  - Scratch space (`/tmp/pi-scope-scratch-<rand>`) and virtual devices (`/dev/null`,
    `/dev/zero`, `/dev/tty`, `/dev/pts`) remain writable so Unix pipelines and
    utilities function without friction.

### Refusal → Gate Ask

When a sandboxed command attempts to write outside the workspace:
1. The kernel denies the mutation (`EROFS` via mount namespaces or `EACCES` via Landlock).
2. Scope inspects the output for permission refusals and extracts candidate absolute paths.
3. Each candidate path is evaluated through the Scope gate (`gate.evaluate`):
   - If blocked by a configured `deny` rule, access is refused without asking.
   - If auto-approved (e.g. `yolo all`), access is permitted.
   - Otherwise, the standard Scope boundary dialog opens, offering literal standing grants.
4. If approved by the user, the path is added as a root, Scope annotates the tool result trailer:
   ```text
   [sandbox] blocked a write outside the workspace: /srv/data.
   Answer: allowed for this folder (this session). Retry the command.
   ```
   The retried command is sandboxed with the new root and succeeds.

### Backends

- **`landlock`** (Linux 5.13+): Uses Linux's unprivileged Landlock LSM via the
  official `landlock` Rust crate (`crates/nowrite-guard`). Handles only write
  rights (reads remain unrestricted), does not unshare namespaces, keeps host
  networking and tty untouched, and background processes survive.
- **`bwrap`** (Linux): Uses bubblewrap to mount the host root read-only and
  bind-mount writable roots. Does NOT unshare pid, network, or session, so
  background servers, dev ports, and interactive tools continue working.
- **`seatbelt`** (macOS): Uses `sandbox-exec` with a profile allowing default
  reads and denying `file-write*` outside allowed paths.
- **`auto`** (default): Probes in order `landlock` → `bwrap` → `seatbelt` → `none`.

### Sandbox commands

| Command | Effect |
|---|---|
| `/scope sandbox status` | Show current mode, active backend, probe result, scratch dir, and writable paths |
| `/scope sandbox on` | Arm sandbox in `workspace` mode |
| `/scope sandbox off` | Disarm sandbox |
| `/scope sandbox mode <workspace\|readonly\|off>` | Set mode (`readonly` denies all writes except scratch/devices) |
| `/scope sandbox backend <auto\|landlock\|bwrap\|seatbelt\|none>` | Select sandbox mechanism |
| `/scope sandbox probe` | Probe backend availability on the current host |
| `/scope sandbox allow <path>` | Add an extra writable path (e.g. `/var/run/docker.sock`) |
| `/scope sandbox deny <path>` | Mark a path read-only even if within workspace |
| `/scope sandbox test '<command>'` | Dry-run wrapping and display exact argv and policies |

### Configuration

In `.pi/scope.json` or `~/.pi/agent/scope.json`:

```json
{
  "sandbox": {
    "mode": "off",
    "backend": "auto",
    "ask": "both",
    "retry": "model",
    "scratch": "session",
    "allow": [],
    "deny": []
  }
}
```

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
  "defaults": { "external": "ask", "readExternal": "allow" },
  "rules": [
    { "action": "read", "resource": "**/.env*", "effect": "deny" },
    { "action": "bash", "resource": "git push *", "effect": "deny" },
    { "action": "bash", "resource": "find *", "effect": "allow" }
  ]
}
```

- `roots` accept strings (`rw`) or `{ path, access }`; relative paths resolve
  against the workspace, `~` against your home directory. A `*` makes it a
  wildcard root (see above).
- `defaults.external` is the answer for a **write** outside every root (`ask` by
  default). `defaults.readExternal` is the answer for an ordinary **read**
  outside every root (`allow` by default; a sensitive read still asks, and
  `"ask"` here makes every outside read prompt).
- `rules` are `{ action, resource, effect }`, matched with opencode's wildcards
  (`*` any run of characters, `?` exactly one) and **last match wins**. Put the
  catch-all first and exceptions after it. A leading `~`/`$HOME` in `resource`
  expands. A rule keyed on `bash` covers a whole command habit
  (`{"action":"bash","resource":"find *","effect":"allow"}`).
- `yolo` is deliberately **not** configurable: a file that sets it is reported
  and ignored, so arming always takes a keystroke.

### Migrating from the previous model

`defaults.unknown` and the `mcp` path-field map were removed together with the
unknown-tool consent state. A config that still carries either one loads and
reports a problem line naming it, instead of silently doing nothing:

- `defaults.unknown` — Scope now judges only the builtin path tools, so a tool it
  cannot map bypasses it. Delete the key.
- `mcp` — MCP tools are outside the gate; there is no path field to declare.
  Delete the section. MCP permissions belong to the host or the server, not here.
- Rules keyed on `mcp__…` no longer match anything; remove them so `/scope rules`
  shows only rules that can fire.

Migrating an older file: nothing has to change. A root ending in `*` used to be
accepted and silently inert; it now works, and a pattern that could re-expose
`$HOME` is refused with a message rather than ignored.

## What is remembered where

| Answer | Stored | Survives reload/resume | Survives fork | Survives a new session |
|---|---|---|---|---|
| Allow once | memory | no | no | no |
| Allow all `<dir>/*` for once | branch snapshot | yes | only in the branch that has it | no |
| Always allow `<dir>/*` for this workspace | `.pi/scope.json` | yes | yes | yes |
| Always allow this file for this workspace | `.pi/scope.json` | yes | yes | yes |
| `scope_answer` (child) | branch snapshot | yes | no | no |
| `/scope allow --project` | `.pi/scope.json` | yes | yes | yes |
| `/scope allow --global` | `~/.pi/agent/scope.json` | yes | yes | yes |
| `/scope yolo --persist` | branch snapshot | yes | only in that branch | no |

Branch records are full snapshots, so replaying them is idempotent and a grant
cannot leak into a fork that never saw the question (opencode #30779). A stored
grant that would re-expose `$HOME`, `/`, or a directory containing the workspace
is refused with a warning when the session loads, and a seeded child ignores the
whole inherited snapshot.

## Telemetry

`/scope log` is bounded and dies with the session. To answer the slower question
— *is this gate asking about things it should not, and missing things it
should?* — every decision is also appended to **one global file**, not a
per-workspace one:

```text
~/.pi/agent/scope-telemetry.jsonl
```

Every workspace and every session appends to that same file, so a decision made
in one project can be compared with the same shape of decision in another. The
`cwd` field on each record is what tells the workspaces apart — the path is a
single log, the records inside it are not.

One JSON object per line, one line per **claim** (a `bash` call with three path
operands writes three). Records are written for ordinary internal allows too, not
just questions and denials, because a detector can only be tuned against what it
saw.

```json
{
  "v": 1, "at": 1760000000000, "source": "gate", "tool": "bash",
  "input": "rm -rf ../build", "cwd": "/work/app",
  "effect": "ask", "asked": true, "answer": "once",
  "reason": "bash wants to write /build — outside the workspace",
  "claim": { "action": "external_directory", "absolute": "/build", "resource": "/build", "write": true, "posture": "write", "external": true, "kind": "directory" },
  "state": { "roots": 1, "rules": 2, "external": "ask", "readExternal": "allow" }
}
```

The fields that make a later analysis possible:

| Field | Reads as |
|---|---|
| `asked`, `answer` | The gate bothered someone — the candidate false positive — and what resolved it (`once`, `allow-session`, `allow-workspace`, `rule`, `deny`, `deny-feedback`, `escalated`, `no-answer`) |
| `effect` | The final verdict for this claim (`allow`, `ask` only when a standing answer failed to settle it, `deny`) |
| `auto`, `yolo` | A yolo arm, not the user, approved it |
| `unknown`, `opaque` | The parser could not analyse the construct — a detection gap, named |
| `child` | A delegated child escalated instead of asking a user |
| `claim` | Absolute target, resource, read/write posture, whether it was external |
| `rule`, `root` | Which stored consent produced the verdict |
| `state` | The scope state in force, so a surprising decision can be explained later |
| `source` | `gate`, `scope_answer` (a parent's decision) or `command` (a `/scope` change) |

Privacy and lifecycle:

- **Local only.** Nothing is sent anywhere; the file sits in the agent directory.
- **Narrow.** File contents and edit bodies are never stored. Command text is
  truncated at 2000 characters and credential-shaped values (`Authorization:`,
  `Bearer …`, `TOKEN=…`, `--password …`) are redacted before the line is written.
- **Bounded.** The file rotates at 4 MiB into a single `.1` predecessor; a long
  session cannot grow it without limit.
- **Best effort.** A read-only home or a full disk drops the record and never
  changes a verdict.
- **Off switch.** `PI_SCOPE_TELEMETRY=off` disables it. `PI_SCOPE_TELEMETRY_FILE`
  overrides the path (useful for tests or a per-machine location).

Quick reads without any tooling:

```sh
# the decisions that asked a question, newest last
jq -c 'select(.asked) | {at, tool, input, answer}' ~/.pi/agent/scope-telemetry.jsonl

# the detection gaps the parser gave up on
jq -c 'select(.unknown) | {tool, input, opaque}' ~/.pi/agent/scope-telemetry.jsonl

# questions by target, most frequent first
jq -r 'select(.asked) | .claim.absolute' ~/.pi/agent/scope-telemetry.jsonl | sort | uniq -c | sort -rn

# every automatic yolo approval
jq -c 'select(.auto) | {tool, input, yolo}' ~/.pi/agent/scope-telemetry.jsonl
```

`/scope telemetry [n]` does the counting for you over the newest `n` records
(1000 by default) and names the three things worth changing: targets that keep
asking, targets that keep being answered "once" (a standing grant or a rule
would silence them), and opaque constructs the parser could not analyse.

## Where the gate sits

- **Jurisdiction is a closed set**: `bash`, `read`, `write`, `edit`, `grep`,
  `find`, `ls`, `ffgrep`, `fffind`. A call to anything else — MCP, a custom tool,
  a session-state tool — is not judged at all. See
  [Jurisdiction](#jurisdiction-builtin-path-tools-only).
- `read`, `write`, `edit` claim their `path`; `grep`, `find`, `ls` and the
  fff equivalents claim their search directory (the cwd by default).
- `bash` is split into `|`/`&&`/`;` segments and judged by named channels: the
  call directory, `cd`/`pushd` arguments, redirection and `tee` targets,
  interpreter entry scripts, mutator operands and reader operands. A relative
  file that exists inside the workspace resolves inside it and does not ask.
- The **base is the directory the process will use**, not just the session cwd:
  the configured shell command prefix is applied first, so a `cd /repo &&` prefix
  moves it. A prefix whose target is computed or a glob is reported rather than
  guessed.
- `node -e '…'` and `python3 -c '…'` are **data**: the payload is never scanned
  for paths and the call is not made opaque. `bash -c '…'` is a nested shell
  program and stays opaque.
- A command a tokenizer cannot model (`bash -c`, `xargs`, `find -exec`, a heredoc
  fed to an interpreter, a path computed at runtime) is **opaque**: it asks once
  per call, the message names the construct, and the offer is the narrowest rule
  that genuinely narrows it (`find *`). When no narrow rule exists, the block says
  to restructure the command rather than granting every bash command.
- A **heredoc is data, not code**: `git commit -F - <<EOF` keeps working. It is
  opaque only when an interpreter reads the body (`python3 <<EOF`), because then
  the body is a program.
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

The sourced comparison behind that table, including which channels each harness
uses and what it admits its text rules cannot cover, is
[research/opencode-v2-bash-permissions.md](research/opencode-v2-bash-permissions.md).

## Limits

This raises the cost of an accident. It does not contain a determined escape:

- **MCP is outside the gate by decision.** An MCP server can read or write files
  beyond any Scope boundary, and nothing here asks or records it. Scope governs
  the builtin path tools listed above; per-server trust is the host's concern.
  Do not read this document as an MCP control.
- **Kernel sandbox for `bash` writes.** `bash` writes outside the workspace can
  be enforced at the OS kernel level via Landlock or bubblewrap (or Seatbelt on
  macOS) using `/scope sandbox on` or in Plan mode. Without the sandbox armed,
  `bash` is policy-gated via in-process parsing.
- `bash` can leave the workspace in ways a tokenizer cannot see: `bash -c`,
  `find -exec`, `git -C`, interpreters, subshells. Under `/scope sandbox on`,
  mutations outside permitted roots cannot succeed because the kernel refuses
  them (`EACCES` / `EROFS`), and the refusal is caught and presented to the user.
- Containers/VMs remain the complete boundary against determined attacks: Landlock
  and mount namespaces restrict filesystem mutations, but do not isolate
  network egress, `ptrace`, or kernel `io_uring` bypasses from hostile code.
- A symlinked ancestor is resolved with `realpath`, so `link -> /etc` is judged
  by its target. A path created *after* the check is not.
- Network egress, secret redaction and resource cost are out of scope.
- Extensions that run their own tool calls outside `tool_call` (or replace the
  editor and bypass hooks) are not gated.

## Verification

`tests/scope-glob.test.ts` and `tests/scope-paths.test.ts` cover wildcard and
last-match semantics, `~`/`..`/symlink classification, wildcard roots and the
narrowest-grant rules. `tests/scope-tool-paths.test.ts` covers the gated set, the
bypass, the named channels, interpreter entry scripts and the opaque cases.
`tests/scope-cwd.test.ts` covers the prefix base: `cd`, subshells, transparent
`source` lines and a target that cannot be resolved.
`tests/scope-policy.test.ts` covers the decision order, special paths, sensitive
reads, the `.env` template exception, the yolo narrowing and rule-silenced tools.
`tests/scope-ask.test.ts` covers the dialog's keys, the six answers and the
literal value each one stores, the rule row for an unreadable command, the
reject stage and narrow widths.
`tests/scope-gate.test.ts` covers the queue, allow once, folder grants covering
queued calls, workspace answers reaching `onPersistGrant`, a read-only root
upgraded to read-write, deny, deny-with-a-note, rule answers, duplicate rule
answers, the policy hook, the base from the shell prefix, the bypass and
fail-closed dialogs.
`tests/scope-state.test.ts` covers config merge, wildcard validation, `~`
expansion in rules, broken files, refused stored grants, snapshot replay and the
in-place config edits (root access, root removal, rule effect, default merge).
`tests/scope-settings.test.ts` covers the settings rows, their order and the
"can this be kept/removed" rules; `tests/scope-settings-popup.test.ts` covers the
screen's keys, its menus, the add flow, the failure notice and narrow widths.
`tests/scope-command.test.ts` and `tests/scope-audit.test.ts` cover parsing,
reporting, stats and the bounded log. `tests/scope-telemetry.test.ts` covers the
persistent sink (append, rotation, disabled, unwritable destination, redaction
and truncation) and the gate's one-record-per-claim emission for an internal
allow, a question, a denial, an opaque command and a yolo approval. `tests/scope-runtime.test.ts` boots the
extension against a fake Pi and checks the wired behaviour end to end, including
bare `/scope` opening the settings screen.
