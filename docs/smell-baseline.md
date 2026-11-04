# Dead-code and duplication baseline

> Part of [pi-workflow-extensions](../README.md). What `knip` and `jscpd` report
> today, so a later change can be measured against a number instead of a guess.

| | |
| --- | --- |
| **Status** | measurement snapshot, not a policy |
| **Detail for** | [README § Verification](../README.md) |
| **Scope** | `extensions/`, `lib/`, `tests/`, `scripts/` (per `knip.json`) |
| **Verified against** | `npm run lint:dead`, `npm run lint:dup` at the commit that adds this note (after `80f71e4`) |
| **Related** | [Verification](verification.md) |

`knip` and `jscpd` are deliberately outside the pre-commit hook: the tree still
carries a dead-export backlog, so making them blocking today would reject every
commit. This note records where that backlog stands.

- **Unused files**: 0 — the deployed VCC entry and the test fixtures are knip entries.
- **Unused dependencies**: 2 — `@viz-js/viz` and `highlight.js`, which `scripts/build-dashboard.mjs` bundles. `tree-sitter` and `tree-sitter-bash` had no importer anywhere and were removed.
- **Unlisted dependencies**: 0 — the 15 Pi runtime and peer imports are declared in `knip.json` → `ignoreDependencies`, each with a reason (see below).
- **Unused exports**: 0.
- **Duplicated blocks**: 20 clones, 356 lines (0.58%) of 61,183 TypeScript lines (advisory).

`knip` is blocking in CI (`npm run lint:dead` in `.github/workflows/ci.yml`). `jscpd` stays advisory.

---

## What each number actually means

A non-zero `knip` count here is not automatically a bug:

- **Unused exports** are the real target. `lib/` is not loaded by Pi, so an export
  nothing imports is genuinely dead. There are none today; keep it that way.
- **Unused dependencies** need a decision, not a reflex. `highlight.js`,
  `tree-sitter` and `tree-sitter-bash` back features the dashboard or code views
  use at runtime through a path `knip` cannot follow; verify before deleting any.
- **Unlisted dependencies** are mostly expected: `@earendil-works/pi-ai` and
  `jiti` are peer/runtime packages. They belong in `knip.json`'s ignore list, not
  in `package.json`.
- **Unused files** includes two `tests/fixtures/` modules that a browser or mount
  probe loads dynamically, so type-based reachability misses them.
- **Duplication** is 0.57% and mostly `tests/delegation/` setup scaffolding. The
  `--threshold 12` setting already tolerates it, so this is informational.

## Ignored dependencies and why

`knip` cannot follow these, so each is listed in `knip.json` → `ignoreDependencies`:

| Dependency | Reason |
| --- | --- |
| `@viz-js/viz`, `highlight.js` | Bundled by `scripts/build-dashboard.mjs` (its header says so). knip does not follow the bundle, so these look unused. Verify with the build before removing either. |
| `@earendil-works/pi-ai` | Pi runtime peer package, imported by tests and extensions. Pi supplies it at load time. |
| `pi-vcc` | Resolved at runtime by `lib/vcc-subagent-adapter.ts` (`VCC_ROOT`, the agent npm dir or `node_modules`); a devDependency only so CI can run the VCC tests. |
| `playwright-core` | A devDependency so CI can run the web-read tests; `lib/web-read.ts` falls back to the agent's npm directory at runtime. |
| `jiti` | Pi runtime loader, used by `tests/extension-loader.test.ts`. |

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
