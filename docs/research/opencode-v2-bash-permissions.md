# How OpenCode v2.2.0 and Claude Code scope Bash commands

Retrieved **2026-10-30**. This note records what two upstream harnesses actually
do, so later changes to this repository cite a source instead of re-deriving a
guess. Every claim carries one of three evidence classes:

- **[SRC]** read in published source at a pinned tag.
- **[DOC]** documented behavior; the implementation is not public.
- **[UNK]** not public. Never design against it.

Pinned OpenCode: tag **v2.2.0**, read at
`https://github.com/anomalyco/opencode/tree/v2.2.0`. The files below were
fetched at that tag on the retrieval date.
Claude Code: `https://code.claude.com/docs/en/permissions`,
`https://code.claude.com/docs/en/tools-reference` and
`https://code.claude.com/docs/en/sandboxing`, all retrieved the same day.

## Summary

Both products converge on a shape that is **not** "scan an argument for a
slash":

1. The unit of Bash permission is a **command segment** — parsed command text
   matched against pattern rules — not a set of path arguments found in argv.
2. A **path** enters the decision only through a small, named set of channels.
   Which channels exist differs between the two products; that they are a
   closed list does not.
3. An **interpreter payload is never analyzed** for paths. Neither product
   promises that `/c` or `/e` inside a program string is safe; they decline to
   turn it into a path claim at all.
4. Both treat rules as _advisory matching_ and say so: real containment is an
   OS sandbox (Claude) or is out of scope (OpenCode's own docs point at its
   permission model, not at text matching, for boundaries).

## OpenCode v2.2.0

### The shell tool call: `workdir` is an argument, the boundary is its own assert

[SRC] `packages/core/src/tool/plugin/shell.ts`

- The tool input is `{ command, workdir?, timeout?, background? }`. The
  `workdir` description says: *"Working directory to execute the command in.
  Defaults to the current working directory. When possible, avoid changing
  directories in the command and set the working directory here instead."*
- `prepare()` runs in this order:
  1. Resolve the working directory through `FileAccess.resolve({ path:
     invocation.cwd, kind: "directory" })` and write the absolute path back to
     `invocation.cwd`.
  2. `ShellParse.scan(command, shell, target.absolute, { portable })`.
  3. Resolve every entry of `parsed.directories` against `target.absolute`.
  4. `FileAccess.authorizeExternal([target, ...directories])` — one batched
     `external_directory` assert, skipped when nothing is external.
  5. `permission.assert({ action: "shell", resources: parsed.commands.map(c =>
     c.resource), save: parsed.commands.map(c => c.save) })` — one command
     assert carrying N resources.
  6. Re-stat the directory immediately before spawning, because *"Approval can
     outlive the directory"*.
- So the accurate description is **one command assert with multiple resources
  plus a separate boundary assert**, not one request per path. A pure `cd` call
  produces the boundary assert and no command assert at all.

### The only two path channels

[SRC] `packages/core/src/shell/parse.ts`, `packages/core/src/file-access.ts`

- `CWD = { cd, chdir, popd, pushd, push-location, set-location }`. Arguments of
  those commands become `directories`, which is the **only** source of path
  claims for the boundary assert.
- `FileAccess` turns an external target into
  `{ action: "external_directory", resource: "<dir>/*", save: ... }`. The
  boundary is a directory, not a file, and it is asserted once for the batch.
- Everything else — `cat /etc/passwd`, `tar -f out.tar`, `node /c /e` — stays
  inside the command-text resource. No operand is converted into a path claim.

### Command text and the `save` prefix

[SRC] `packages/core/src/shell/parse.ts`

- Every non-`cd` tree-sitter `command` node becomes
  `{ resource: <command text>, save: <prefix words> + " *" }`. Inside a
  redirect the resource is the whole `redirected_statement` text, so the
  redirect target is part of the matched string rather than a resolved path.
- `save` comes from an `ARITY` table that caps how many words are kept:
  `cat`/`ls`/`rm`/`grep`/`sed`/`mkdir` etc. keep 1; `git`, `python`, `deno`,
  `bun`, `docker`, `cargo`, `npm`, `go` etc. keep 2; `npm run`, `docker compose`,
  `bun x`, `git remote` etc. keep 3. Unknown binaries fall back to 1 token.
- **`python` is in the table at arity 2**, so `python -c '...'` yields the save
  pattern `python -c *`. **`node`, `bash`, `sh`, `zsh` are absent**, so they
  fall back to one token and yield `node *` / `bash *`.
- That absence is an **arity-table coincidence, not inline-program detection**.
  `parse.ts` has no notion of an "inline program"; the entire command text is
  the resource in every case, and the payload is never read.
- This is also the answer to the `node /c /e` question: `/c` is an entry-script
  operand and `/e` is an application argument whose meaning only the program
  knows. Neither is a `cd` argument, so neither becomes a path or directory
  claim. The pair merely shapes the permission prefix, which is `node *`.

### The portable scanner fails closed

[SRC] `packages/core/src/shell/scan.ts`

- The portable scanner is in-repo, not a private dependency. Its
  `OpaqueReason` set covers `command-substitution`, `compound-command`,
  `dynamic-command-name`, `dynamic-execution`, `heredoc`, `invalid-redirect`,
  `invalid-structure`, `unterminated-escape` and `unterminated-quote`.
- Its own comment states the intent: *"Opaque describes a parsing limitation,
  not a permission decision."* In the tool path an opaque verdict is a hard
  failure (`Portable shell scanner cannot analyze command: <reason>`), never a
  silent allow.
- Which scanner runs depends on the wasm asset, the app channel and an
  experimental flag — so the tree-sitter path is not guaranteed to be the one
  that runs.

### `cd` chain and subshell handling

[SRC] `packages/core/src/shell/parse.ts`

- The walk is over every command node, so `cd /tmp && rm x` yields the
  directory `/tmp` plus one command resource for `rm x`; the `cd` itself
  produces no shell resource.
- A `cd` inside `( ... )` or `$( ... )` is still walked and its target still
  lands in `directories`. A subshell `cd` does not change the outer cwd, but
  OpenCode over-collects it anyway, which is conservative for the boundary
  check.
- `cd -`, bare `cd` and `$CDPATH` resolve to nothing and produce no claim.
- There is no per-segment cwd chaining: a relative operand is never resolved
  against an earlier `cd`, because operands are not path claims at all.

### Matching and precedence

[SRC] `packages/core/src/permission.ts`

- `evaluate(action, resource, ...rulesets)` is `findLast(match)` over the
  flattened rule lists, defaulting to `{ effect: "ask" }`. **Last match wins,
  and no match is never an implicit allow.**
- `denied()` runs **first and against configured rules only** (agent plus
  session). Only then is the saved-rule set appended and the effect computed
  as `anyAsk ? "ask" : "allow"`.
- Consequence worth copying: a saved `always` grant **may override a
  configured `ask` but can never override a configured `deny`**.
- Multiple resources: deny if any configured deny, ask if any asks, allow only
  if all allow.
- Wildcards are `*` and `?`, matched against the whole string. A pattern
  ending in `" *"` also matches the bare prefix.

### MCP is a separate action namespace (context only)

[SRC] `packages/core/src/tool/mcp.ts`

Each MCP call asserts `action = "<server>_<tool>"` with `resources: ["*"]` and
`save: ["*"]`. A shell rule cannot reach it and an MCP rule cannot reach the
shell. Neither product needs an "unknown tool" state, because the tool catalog
exists before the call. This repository deliberately goes further and removes
MCP from its gate entirely; see the last section.

## Claude Code

All **[DOC]** — the permission matcher is not public.

### cwd

- *"The Bash tool runs each command in a separate process."*
- A `cd` in the main session **carries over** to later Bash calls while it stays
  inside the project directory or an additional working directory.
- Outside those, it **resets to the project directory and appends
  `Shell cwd was reset to <dir>`** to the tool result. Subagent sessions never
  carry `cd` over. `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` pins every
  command to the project directory.
- Environment variables never persist; shell rc aliases and functions are
  captured once at session start.

### Compound commands, wrappers, unparseable input

- Recognized separators: `&&`, `||`, `;`, `|`, `|&`, `&`, newlines. **Every
  subcommand must be allowed** for the compound to run unasked.
- `deny` and `ask` apply when **any** subcommand matches, including one inside
  a subshell, a command substitution or a `for` body.
- Stripped before matching: `timeout time nice nohup stdbuf command builtin
  noglob`, known-safe leading environment assignments, and bare `xargs`. The
  list is built in. `direnv exec`, `devbox run`, `npx` and `docker exec` are
  **not** stripped, and the docs name that as a hazard.
- A dangling operator such as `npm test &&` is treated as unparseable and is
  not split, so `Bash(npm *)` does not approve it. Unparseable analysis of a
  read-only command prompts, and commands over 10,000 characters always prompt.

### The documented path channels

1. **Redirects.** `>`/`>>`/`2>` targets are checked against the edit rules,
   protected paths and working directories as if Claude wrote the file
   directly; `<` targets against the read rules. `/dev/null`, `2>&1`, `<&3` and
   here-docs are exempt. `tee` destinations are checked too.
2. **`cd`.** A `cd` inside the working directories is read-only; one outside
   saves its own read rule when the user answers "don't ask again". `cd`
   combined with `git` prompts because the target may run its hooks; `cd`
   combined with a redirect prompts unless the only target is `/dev/null`.
3. **The fixed read-only command set.** `ls cat echo pwd head tail grep find wc
   which diff stat du cd` and read-only forms of `git` run unasked, except as
   `permissions.blockReadsOutsideWorkingDirectories` changes the treatment of
   paths outside the working directories. Paths are resolved for that fixed
   set.
4. **Edge checks.** UNC/network paths prompt, `file -m`/`-f` prompt, `ps` forms
   that could print the environment prompt, writes to special variables such as
   `PATH` and `IFS` prompt, and unquoted globs prompt for commands that have
   write-capable flags.

There is **no documented general argv path resolver** for arbitrary binaries.
The URL guidance is explicit that `Bash(curl http://github.com/ *)` is not a
URL boundary, listing options-before-URL, protocol changes, redirects and
`$URL` as the reasons, and points at sandboxing or a `PreToolUse` hook for
enforcement instead of claiming the matcher resolves those operands.

### What a Bash rule does not match

| Rule | Stops | Does not stop |
|---|---|---|
| `Bash(curl *)` | `curl https://example.com` | `/usr/bin/curl ...`, `sh -c 'curl ...'` |
| `Bash(rm *)` | `rm -rf build/` | `/bin/rm ...`, `bash -c 'rm ...'` |
| `Bash(git push *)` | `git push origin main` | `git -C . push ...`, `git -c ... push`, `git 'push' ...` |

The docs' own verdict: *"a deny or ask rule covers the invocation Claude
usually produces and isn't a security boundary around the program."* Parameter
rules on the `command` field are rejected outright because a compound command
would bypass them.

### Precedence

- Precedence is **deny, then ask, then allow** — first match in that order, and
  specificity is irrelevant, so an allow rule cannot carve an exception out of
  a deny rule.
- A bare deny removes the tool from the model's context; a scoped deny leaves
  the tool available and blocks matching calls.
- "Don't ask again" saves per subcommand, up to five rules per compound
  command, into `.claude/settings.local.json` at the repository root.

### Enforcement is OS-level and off by default

- *"The sandbox is off by default"*; it is enabled with `/sandbox` or
  `sandbox.enabled: true`, and if a dependency is missing it falls back to
  unsandboxed execution unless `sandbox.failIfUnavailable` is set.
- *"The sandbox covers shell commands only. Claude's file tools, MCP servers,
  and hooks run outside it."*
- It is built on the public `@anthropic-ai/sandbox-runtime`
  (`https://github.com/anthropics/sandbox-runtime`), using Seatbelt on macOS and
  bubblewrap on Linux plus a network proxy. Defaults: writes to the working
  directory, a per-user temp directory and added directories; reads cover most
  of the machine, including `~/.ssh` and `~/.aws/credentials`; network egress
  goes through a proxy whose allowlist starts empty.
- **What is not public is the permission matcher and the auto-mode classifier,
  not the sandbox.** The pairing is the point: rules decide *whether to ask*,
  and the sandbox decides *what a process can reach*.

## Side by side

| | OpenCode v2.2.0 [SRC] | Claude Code [DOC] |
|---|---|---|
| Unit of Bash permission | command text per segment; a redirect is folded into the string | command text per split segment after wrapper stripping |
| Path channels | `workdir` plus `cd`-family arguments | redirect and `tee` targets, `cd` targets, arguments of the fixed read-only set |
| Slash means path? | no | no |
| cwd | explicit `workdir`, resolved and boundary-checked; `cd` yields a directory claim | fresh process per command; `cd` carries over inside allowed roots, otherwise resets with a notice |
| Precedence | last match wins; configured deny pre-empts; a saved grant may override `ask` | deny, then ask, then allow; first match; specificity irrelevant |
| Saved grant scope | project-scoped saved rules | repo-root `settings.local.json`, per subcommand |
| Multi-segment | any deny denies, any ask asks | every subcommand must allow; deny or ask on any nested match |
| Unparseable | hard failure on the portable scanner | not split for allow matching, so it prompts |
| Interpreters | not analyzed; `save` is the arity prefix (`node *`) | rules match command text; alternate invocation forms escape |

## How this repository uses the note

The maintainer's decision, recorded 2026-10-30:

- Scope gates **only builtin tools whose inputs are paths**: `bash`, `read`,
  `write`, `edit`, `grep`, `find`, `ls`, `ffgrep`, `fffind`.
- **MCP tools bypass the gate entirely**: not allowed, not denied, not asked,
  not recorded. The rule vocabulary deliberately does not name MCP tools,
  because a text/path gate cannot control what an MCP server does internally.
  Per-server trust is the host's concern, not this extension's.
- Unknown and custom tools also bypass. There is no unknown-path consent state
  and no `defaults.unknown`.
- The shell model adopted here is the named-channel model: call cwd, `cd`-family
  arguments, redirect and `tee` targets, interpreter entry-script operands, and
  mutator operands. Reader operands, URLs and inline program payloads are never
  path claims.
- A saved grant may override an `ask` but never a `deny`.

## Open questions

- `parse.ts` details are pinned to tag v2.2.0. Re-read the file before
  depending on individual `ARITY` entries; the tag is the citation, not the
  branch.
- Which OpenCode scanner runs depends on the wasm asset, the app channel and an
  experimental flag, so do not assume the tree-sitter path is always in use.
- Claude's matcher and auto-mode classifier are not public. Treat the documented
  rule limits as the constraint and use a sandbox or hooks for real
  enforcement.
- Claude's deny/ask/allow ordering differs from the last-match-wins model this
  repository shares with OpenCode. Adopting anything from Claude must not
  silently change our precedence.
