# Verification

> Part of [pi-workflow-extensions](../README.md). What the suites cover and how to run them.

```sh
npm test
npm run typecheck
node --test docs/patches/vcc-tests/regression.mjs
```

Tests use `node:test`, stubbed Pi hooks/dialogs, and native Node 22 TypeScript stripping. Dev dependencies are only for type-checking; extension runtime imports are supplied by Pi. Tests cover all three extensions in all six load orders, failed/successful question-forwarding enforcement, real Pi provider-request injection, native compaction and saved-session reload, filesystem milestone delivery, branch isolation, stale-run outcomes, and read-only previews. A real Pi runtime uses a scripted in-process provider: no credentials, network or inference. Automated dashboard tests use mocked native dialog replies, not an actual interactive TUI. `tests/scope-*.test.ts` cover the access-scope gate from pure parsing to a wired extension against a fake Pi, including the dialog, the queue, grants, yolo and the audit log. `npm test` runs the core and main agent suites together; the Herdr seam tests use the in-tree `vendor/pi-herdr-subagents` snapshot, so no sibling checkout is required. The pi runtime packages are peer dependencies, installed from the registry by `npm install --ignore-scripts --legacy-peer-deps`. No live parent session or child pane is restarted by tests.

## Running the suites

`npm test` runs the complete suite and is the commit/CI gate. Every run has a
per-test deadline (`--test-timeout`, default 30s, override with
`TEST_TIMEOUT_MS`), so a hung test fails by name instead of stalling the gate.

| Command | Runs |
| --- | --- |
| `npm run test:unit` | Everything except the slow tier (servers, jsdom, real Pi sessions) |
| `npm run test:integration` | The slow tier, listed in `tests/tiers.json` |
| `npm run test:delegation` | `tests/delegation/**` |
| `npm run test:changed` | Tests whose source a `git diff` touched; falls back to `test:unit` |
| `npm run test:profile` | The full suite with per-file durations, to refine `tests/tiers.json` |
| `npm test` | All of the above files, in one run |

CI shards the full suite with `--test-shard=i/3`. A new slow test must be added
to `tests/tiers.json`, or `test:unit` will start paying for it.

The runner also passes `--test-force-exit`: a file whose assertions all pass but
whose process lingers on a watcher or timer must not hold the run open. That
leak — not a slow assertion — is what used to stall the suite past its budget.
