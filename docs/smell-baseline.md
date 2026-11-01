# Dead-code and duplication baseline

> Part of [pi-workflow-extensions](../README.md). What `knip` and `jscpd` report
> today, so a later change can be measured against a number instead of a guess.

| | |
| --- | --- |
| **Status** | measurement snapshot, not a policy |
| **Detail for** | [README § Verification](../README.md) |
| **Scope** | `extensions/`, `lib/`, `tests/`, `scripts/` (per `knip.json`) |
| **Verified against** | `npm run lint:dead`, `npm run lint:dup` at commit `a4ec792` |
| **Related** | [Verification](verification.md) |

`knip` and `jscpd` are deliberately outside the pre-commit hook: the tree still
carries a dead-export backlog, so making them blocking today would reject every
commit. This note records where that backlog stands.

- **Unused files**: 3 — `lib/ui/index.ts`, and two test fixtures.
- **Unused dependencies**: 4 — `@viz-js/viz`, `highlight.js`, `tree-sitter`, `tree-sitter-bash`.
- **Unlisted dependencies**: 15 — mostly `@earendil-works/pi-ai` in tests, plus
  `playwright-core` and `jiti`, which are provided by the Pi runtime rather than
  installed by this package.
- **Unused exports**: 41 functions/constants plus 1 exported type.
- **Duplicated blocks**: 19 clones, 342 lines (0.57%) of 59,982 TypeScript lines.

---

## What each number actually means

A non-zero `knip` count here is not automatically a bug:

- **Unused exports** are the real target. `lib/` is not loaded by Pi, so an export
  nothing imports is genuinely dead, and the 41 are spread across
  `lib/orchestrator/`, `lib/vcc/` and `lib/ui/`. They should be removed file by
  file, not in one sweep.
- **Unused dependencies** need a decision, not a reflex. `highlight.js`,
  `tree-sitter` and `tree-sitter-bash` back features the dashboard or code views
  use at runtime through a path `knip` cannot follow; verify before deleting any.
- **Unlisted dependencies** are mostly expected: `@earendil-works/pi-ai` and
  `jiti` are peer/runtime packages. They belong in `knip.json`'s ignore list, not
  in `package.json`.
- **Unused files** includes two `tests/fixtures/` modules that a browser or mount
  probe loads dynamically, so type-based reachability misses them.
- **Duplication** is 0.57% and mostly `tests/orchestrator/` setup scaffolding. The
  `--threshold 12` setting already tolerates it, so this is informational.

## Configuration hints

`knip` reports that `vendor/**`, `web/**` and `crates/**` are in `ignore` but are
also outside `project`, so the ignore entries are redundant. They are harmless;
removing them is part of tidying the config, not a correctness fix.

## How to re-measure

```sh
npm run lint:dead    # knip: files, dependencies, exports
npm run lint:dup     # jscpd: clones and duplicated lines
```

Update this note when a change moves a number materially — especially when the
unused-export count drops, because that is the count that gates making `knip`
blocking in CI.
