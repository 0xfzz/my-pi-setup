# Contributing

## Setup

```sh
git clone <this repo>
cd pi-workflow-extensions
npm install --ignore-scripts --legacy-peer-deps
npm test
npm run typecheck
```

Node 22.6+ is required (the suites use `--experimental-strip-types`, so there is no
build step). The `@earendil-works/*` packages and `typebox` are peer dependencies —
Pi supplies them at runtime; `npm install` fetches them locally so the tests can run.

## Layout rules

- `extensions/` holds only files listed in `package.json` → `pi.extensions`. If a helper
  is not meant to be loaded by Pi, put it in `lib/`.
- Every extension that registers tools must keep its tool names in sync with the child
  allowlist (`vendor/pi-herdr-subagents/src/launch.ts`, `SUBAGENT_CONTROL_TOOLS`) and
  with `lib/tool-policy.ts`, or delegated children lose the tool silently.
- Do not add absolute paths from your machine. Tests resolve fixtures relative to the
  repository (`tests/fixtures/herdr-root.ts`); environment variables are the escape
  hatch (`HERDR_ROOT`, `PI_RUNTIME_ROOT`, `VCC_ROOT`).
- `vendor/` is a source snapshot, not a dependency. Read
  `vendor/pi-herdr-subagents/VENDORED.md` before touching it, and record the change
  there.

## Tests

- `npm test` runs both suites (core + main agent). Prefer `npm run test:core` or
  `npm run test:delegation` while iterating.
- Tests must not need credentials, network, inference, or a live Pi session. Use the
  in-process scripted provider pattern already present in the suites.
- A bug fix lands with a regression test that fails without the fix. Name the failure
  mode in the test title so the next person can find it.

## Docs

- `README.md` is the operator-facing document: tool surface, behaviour, commands.
- `docs/` holds design notes, audits, and `docs/patches/` (the diffs applied to installed
  packages, plus `VERIFICATION.md`). Every note follows [`docs/TEMPLATE.md`](docs/TEMPLATE.md):
  a status/scope/verification block, a five-bullet summary, then the detail. `README.md`
  indexes each note in one row — README summarises, the note holds the detail.
- Investigation reports are also kept as workspace artifacts; sum them into `docs/` when
  they describe a decision rather than a one-off bug.

## Commits

Keep commits scoped to one work unit (one extension, one library, one vendored fix) and
explain the failure mode in the body when the change is a bug fix. `npm test` and
`npm run typecheck` must pass before the commit.
