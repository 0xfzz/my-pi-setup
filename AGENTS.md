# Agent instructions

## Commit every change

Commit each completed change before starting the next one. The commit is the
rollback boundary: if a later step goes wrong, `git revert <sha>` (or resetting
to the previous commit) restores a known-good tree. Uncommitted work is not
covered by that safety net.

- **Commit after each coherent unit of work** — a feature, a fix, its tests, or a
  docs update. Do not leave finished work sitting in the working tree while you
  move on to something else.
- **Keep the tree clean at the end of a task.** Run `git status` and commit or
  explicitly discard every change. A dirty tree at hand-off is unfinished work.
- **Verify before committing.** `npm test` and `npm run typecheck` must pass (the
  two documented TUI clipping failures are the only accepted baseline failures).
  The pre-commit hook also runs `oxlint` on the staged TypeScript files — see
  [Smell gate](#smell-gate).
- **Use a scoped conventional message** so history stays greppable:
  `feat(area): …`, `fix(area): …`, `refactor(area): …`, `test: …`, `docs: …`.
  Explain the failure mode in the body when the change is a bug fix.
- **One work unit per commit.** Do not bundle unrelated changes; a mixed commit
  cannot be reverted cleanly.
- **Never rewrite or force-push shared history.** Revert forward instead.
- **If work must be preserved while incomplete,** make a clearly named WIP commit
  rather than leaving it uncommitted. Replace or squash it only if the history is
  local and unpublished.
- **Do not commit** secrets, credentials, generated noise, or unrelated files.

## Verification gate

```sh
npm run tidy      # typecheck + lint + tests, the whole gate in one command
```

The gate is the three checks that must all pass:

```sh
npm run typecheck
npm run lint:smell
npm test
```

`npm run tidy` runs exactly those three in that order. Use it before a commit
rather than remembering the list.

The only accepted baseline failures are the two `native regular/fullscreen inline
custom UI reproduces clipping…` tests. Anything else is a new failure and must be
fixed before the commit.

## Smell gate

A pre-commit hook runs `oxlint` on the staged TypeScript files (`lint-staged`,
installed by `simple-git-hooks`). The hook is a ratchet: it only sees files you
are already touching, so fix their warnings instead of bypassing it. Do not add
new unused imports, variables, functions or exports.

**Do not force a warning to green.** A warning is a signal to investigate, not a
quota to clear:

- If the warning is real, fix the cause — use the value, remove the dead code,
  correct the construct.
- If it is a false positive or an intentional construct (an ANSI
  control-character regex, for example), keep the narrowest per-line suppression
  and say in a comment why it is deliberate.
- Never rename a binding to `_`, delete behaviour, or add a blanket rule `off`
  just to make the checker pass. A green run bought that way hides the problem
  and is worse than the warning.
- If the right fix needs a decision you cannot make, leave the warning visible
  and raise it. Silence is not a fix.

```sh
npm run lint:smell   # oxlint, whole repo; fails on warnings
npm run lint:dead    # knip: unused files, exports and dependencies
npm run lint:dup     # jscpd: duplicated blocks above 12%
npm run smell        # dead + dup
```

`knip` and `jscpd` are deliberately not in the hook yet: the tree still carries a
dead-export backlog, and a pre-push gate would block every push until it is
cleared. Run `npm run lint:dead` when a change adds, moves or removes exports or
files, and clear whatever you introduce.

`git commit --no-verify` is for a clearly named WIP commit only. Explain why in
the commit body, and remove the bypass before the work is finished.
