# Baseline before the delegation-namespace migration

Recorded at the start of executing `@artifact:normal-mode-delegation-fix-plan` (v3).
Every later gate compares against this file, not against "green".

## Environment

| Fact | Value |
|---|---|
| Date (UTC) | 2026-10-26T14:49:02Z |
| Node | v22.23.2 |
| Branch | `main` |
| HEAD at capture | `52d4d32` |
| Working tree | dirty: 29 modified + 42 untracked paths (prior uncommitted work) |
| Checkpoint commit | the commit that adds this file (`chore: checkpoint before delegation namespace migration`) |

The checkpoint commit exists so each migration step has a rollback boundary. It
contains the prior working-tree state unchanged; it is not part of the feature.

## Deterministic checks

### Typecheck

```
$ npx tsc --noEmit
TYPECHECK_EXIT=0
```

**Baseline: green.** There are no pre-existing type errors. Any non-zero exit
after this point is a regression and stops the sequence.

### Test suite

```
$ npm test
# tests 966
# suites 20
# pass 963
# fail 2
# cancelled 0
# skipped 1
# todo 0
# duration_ms 18436.9
```

**Baseline: 963 pass, 2 fail, 1 skip.**

### Known pre-existing failures (not caused by this migration)

Observed `not ok` lines (3 lines; the suite summary counts 2 failures because the
two layout variants share a parent subtest):

1. `tests/dashboard-runtime.test.ts:1038`
   "a failed heartbeat re-arms discovery instead of leaving the producer dead"
   — `timed out waiting for initial publish` (5010 ms).
2. `tests/provider-model-picker-layout.test.ts:161`
   "native regular inline custom UI reproduces clipping with persistent widgets/footer"
   — `legacy custom UI only replaces the editor`.
3. `tests/provider-model-picker-layout.test.ts:161`
   "native fullscreen inline custom UI reproduces clipping with persistent widgets/footer"
   — same assertion.

A migration gate may only fail on **new** failures. These three names are exempt;
fixing them is out of scope.

## Delegation tool inventory at baseline (declared in this repository)

Parent-side v2 (`extensions/orchestrator.ts`):

`orch_handoff`, `orch_spec_review`, `orch_spawn`, `orch_resume`,
`orch_interrupt`, `orch_close`, `orch_steer`, `orch_route`, `orch_running`,
`orch_brief`, `orch_check`, `orch_escalate`, `orch_review`, `spec_review_submit`

v1 spawn surface (registered by the separately installed `pi-herdr-subagents`
extension, **not** by this repo — see artifact §1.4):

`subagent`, `subagent_resume`, `subagent_interrupt`, `subagents_list`

Child / checkpoint surface:

`subagent_done`, `subagent_progress`, `caller_ping`, `parent_recall`,
`parent_digest`, `subagent_history`

Target after the migration: the same capabilities under `orch_*` only, with
`spec_review_submit` → `orch_spec_review_submit` and `subagent_history` →
`orch_history`. No aliases.

## Gate commands used at every step

```bash
npx tsc --noEmit
npm test
npm run test:orchestrator
```

The full plan is in artifact `normal-mode-delegation-fix-plan` (v3), §4.3.
