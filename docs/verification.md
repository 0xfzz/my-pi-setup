# Verification

> Part of [pi-workflow-extensions](../README.md). What the suites cover and how to run them.

```sh
npm test
npm run typecheck
node --test docs/patches/vcc-tests/regression.mjs
```

Tests use `node:test`, stubbed Pi hooks/dialogs, and native Node 22 TypeScript stripping. Dev dependencies are only for type-checking; extension runtime imports are supplied by Pi. Tests cover all three extensions in all six load orders, failed/successful question-forwarding enforcement, real Pi provider-request injection, native compaction and saved-session reload, filesystem milestone delivery, branch isolation, stale-run outcomes, and read-only previews. A real Pi runtime uses a scripted in-process provider: no credentials, network or inference. Automated dashboard tests use mocked native dialog replies, not an actual interactive TUI. `npm test` runs the core and orchestrator suites together; the Herdr seam tests use the in-tree `vendor/pi-herdr-subagents` snapshot, so no sibling checkout is required. The pi runtime packages are peer dependencies, installed from the registry by `npm install --ignore-scripts --legacy-peer-deps`. No live parent session or child pane is restarted by tests.
