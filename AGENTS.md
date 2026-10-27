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
npm run typecheck
npm test
```

The only accepted baseline failures are the two `native regular/fullscreen inline
custom UI reproduces clipping…` tests. Anything else is a new failure and must be
fixed before the commit.
