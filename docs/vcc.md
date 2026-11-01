# VCC auto-compaction

> Part of [pi-workflow-extensions](../README.md). The compaction policy, its calibration and rollback; the checkpoint side is in [checkpoints.md](checkpoints.md).

| Field | Value |
| --- | --- |
| **Status** | current policy |
| **Detail for** | [README § Delegated-work checkpoints](../README.md) |
| **Scope** | `lib/vcc/`, `extensions/subagent-checkpoints.ts` |
| **Verified against** | as recorded under Tests below; not re-verified in this pass |
| **Related** | [Patch test notes](patches/vcc-tests/README.md) |

## Summary

- Replaces "trigger at 20% of the window, keep trigger/4" with three separate numbers: capacity, quality target, post-compaction target.
- A model profile supplies a calibrated target when one exists; otherwise a documented fallback is used and marked uncalibrated.
- The retained tail is derived from the post-compaction target, and the whole request is verified before the boundary draft is returned.
- Configuration, calibration, telemetry and the small-model caveat are specified below.

Model-aware compaction controller for `pi-vcc`. Replaces the previous
"trigger at 20% of the context window, keep `trigger/4` of recent tail" policy
with one that separates **capacity**, **quality target**, and **post-compaction
target**, and that verifies the whole request it is about to send.

## Why the old policy was wrong for small models

| Window | Old trigger (20%) | Old tail budget (`trigger/4`) |
| ---: | ---: | ---: |
| 8K | 1.6K | 400 |
| 16K | 3.2K | 800 |
| 32K | 6.4K | 1.6K |
| 128K | 25.6K | 6.4K |

Two problems:

1. The trigger scaled with the window, not with how well the model actually uses
   context. A small-window model compacted very early.
2. The summary itself had no token budget (it was capped by 120 transcript
   *lines*), and successful tool results were dropped from the brief. So the
   agent compacted early, lost findings, and still carried an oversized summary.

## Current policy

```text
A = contextWindow - outputReserve - safetyMargin      hard input capacity
T = profile.qualityTarget ?? 0.70 × A                 compaction trigger
P = 0.70 × T                                          post-compaction target

summaryBudget = 0.25 × P       (headers + evidence, protected)
evidenceBudget = 0.35 × summaryBudget
tailBudget    = clamp(P - fixedOverhead - summaryBudget, tailMin, tailMax)
```

`fixedOverhead` is the system prompt/tool block plus queued steering messages:
tokens compaction cannot remove. `tailMax` defaults to `min(40k, 0.6 × T)`.

The fallback ratios (0.70/0.70/0.25) are **engineering seeds to evaluate**, not
research-proven optima. `resolveBudget()` marks them `calibrated: false`.

### What survives compaction

Protected summary sections, in order:

1. Compiler header sections (`[Session Goal]`, `[Files And Changes]`, `[Key Signals]`, …)
2. `[Observed Evidence]` — bounded, de-duplicated findings from tool results
   (successful output and errors), with the command/path they came from
3. The recall note

Only the transcript tail is elastic. It is trimmed oldest-first, never
mid-section, and replaced with `...(N earlier transcript lines omitted; use vcc_recall)`.

### Refusal conditions

The controller commits nothing and preserves history when:

- the cut would split a tool call from its result, or drop a result from the turn
  that just finished
- too few new tokens accumulated since the last compaction (`minProgressTokens`)
- the protected summary alone exceeds `summaryBudget` (it is never truncated)
- the compacted request would still exceed `A`
- the summary would save less than 5% of current usage
- the session, leaf, or abort state changed during compilation

After a refusal it skips the next 3 turns before retrying.

## Configuration

`~/.pi/agent/pi-vcc-config.json`, inside the existing `autoCompact` block:

```json
{
  "overrideDefaultCompaction": true,
  "autoCompact": {
    "enabled": true,
    "mode": "budgeted",
    "shadow": false,
    "profiles": {},
    "telemetry": { "enabled": true }
  }
}
```

| Key | Meaning |
| --- | --- |
| `mode` | `"budgeted"` (default) or `"legacy"`. A bare `maxPercent` with no `mode` is treated as legacy so old configs keep their behaviour. |
| `maxPercent` | Legacy only: trigger at this % of the window. |
| `shadow` | Compute, verify, and log the plan without committing it. |
| `defaults` | Tuning applied before profile overrides. |
| `profiles` | Per-model tuning keyed by `provider/model`, then `model`, then `*`. |
| `telemetry` | `{ enabled, path }`. Default path is next to the config file. |

### Profile fields

`qualityTargetRatio` (fraction of `A`), `qualityTargetTokens` (absolute, wins),
`postCompactionRatio`, `summaryRatio`, `evidenceRatio`, `tailMaxRatio`,
`maxTailTokens`, `minTailTokens`, `outputReserveRatio`, `safetyMarginRatio`,
`safetyMarginMin`, `safetyMarginMax`, `minQualityRatio`, `minProgressRatio`,
`headroomToleranceRatio`, `charsPerToken`, plus `calibrated` and `source`.

```json
{
  "profiles": {
    "opencode-go/deepseek-v4.1-flash": {
      "qualityTargetRatio": 0.55,
      "calibrated": true,
      "source": "sweep-2026-05-32k-window"
    }
  }
}
```

Only set `calibrated: true` after measuring task outcomes, not because a ratio
"feels" right. Telemetry distinguishes the two so a guess is never read later as
a measurement.

## Calibration

The reviewed research does not supply per-model optimal budgets. Measure them:

1. Build traces from real coding/research sessions (held-out tasks, repeated
   trials, confidence intervals).
2. Sweep total-input budgets: 4K, 8K, 16K, 32K, 64K, 128K, clipped to `A`.
3. Compare: legacy 20% policy, budget-only, observation pruning only, and
   pruning + active state + recent groups.
4. Score: task completion/test pass, retention of mandatory constraints,
   correctness of decisions, ability to continue without repeating finished work,
   re-fetch count, overflows, cost, latency.
5. Pick the cheapest budget inside an acceptable quality band. A 2-point solve-rate
   band is a product decision, not a research result. Constraint violations are
   never an acceptable trade.

Runtime occupancy and self-reported confidence are not quality measurements.

## Telemetry

JSONL, metadata only — no prompt text, tool output, file contents, or secrets:

```
ts, mode, outcome(committed|shadow|skipped), reason, provider, model,
contextWindow, calibrated, profileKey, usageTokens, triggerTokens,
inputAllowance, qualityTarget, postCompactionTarget, summaryBudget,
tailBudget, tailTokens, prefixTokens, newTokens, summaryTokens,
evidenceTokens, evidenceItems, fixedOverheadTokens, afterTokens,
headroomSatisfied, exception, durationMs
```

Rotates to `<path>.1` at 2 MB. Compare `afterTokens` with the next provider
`usage.input` to see how conservative the estimator is for that model.

## Commands

`/vcc-budget` — mode, model profile, resolved `A`/`T`/`P`, current usage,
distance to trigger, and the last five telemetry records.

## Ownership and deployment

Canonical source in this repo:

```
lib/vcc/estimate.ts        conservative token estimation
lib/vcc/budget.ts          A/T/P resolution and tuning
lib/vcc/config.ts          config schema, mode, profile lookup
lib/vcc/evidence.ts        observation extraction
lib/vcc/summary-budget.ts  team token-budgeted summary packing
lib/vcc/plan.ts            budgeted + legacy cut planning
lib/vcc/telemetry.ts       JSONL records
lib/vcc/controller.ts      turn_end controller and /vcc-budget
lib/vcc/auto-compact-entry.ts  deployed entry point (imports pi-vcc)
```

Deploy (this is what `~/.pi/agent/extensions/auto-compact.ts` runs):

```bash
node scripts/sync-vcc-auto-compact.mjs          # copy
node scripts/sync-vcc-auto-compact.mjs --check  # fail on drift
```

It mirrors `lib/vcc/auto-compact-entry.ts` → `<agent>/extensions/auto-compact.ts`
(the entry is renamed on deploy, since Pi discovers it as `auto-compact.ts`) and
the other `lib/vcc/*.ts` → `<agent>/extensions/lib/vcc/*.ts`.

**Single instance.** The deployed file is the only live controller. Do not add
it to `package.json` → `pi.extensions`; the sync script refuses to run if a
duplicate entry exists. Reload Pi after syncing.

The pre-redesign controller is not kept in the tree: it is a superseded copy of
this one, and keeping code under `docs/` meant nothing compiled or linted it.
Diff against it from history instead:

```sh
# the archived pre-redesign controller
git show 3090557:docs/patches/vcc-auto-compact-legacy.ts > /tmp/legacy.ts
diff -u /tmp/legacy.ts lib/vcc/auto-compact-entry.ts
```

## Small-model caveat: core compaction settings

`autoCompact` owns threshold compaction, but Pi core still has its own trigger
(`contextWindow - reserveTokens`). Global defaults in `~/.pi/agent/settings.json`:

```json
"compaction": { "enabled": true, "reserveTokens": 20000, "keepRecentTokens": 20000 }
```

For a 16K-window model that reserve is larger than the window, so core would
compact immediately and near-continuously. Those absolute numbers cannot express
a ratio, so add explicit overrides when you enable a small-window model:

```json
"compaction": {
  "enabled": true,
  "reserveTokens": 20000,
  "keepRecentTokens": 20000,
  "modelOverrides": {
    "provider/small-model": { "reserveTokens": 2048, "keepRecentTokens": 4096 }
  }
}
```

Leave core compaction enabled: it is the emergency overflow path when a prompt
arrives above capacity or the provider rejects a request. The budget controller
is the primary path; core is the backstop.

## Tests

```bash
node --experimental-strip-types --import ./tests/isolate-env.mjs --test tests/vcc-*.test.ts
```

Coverage: budget ordering and clamping for 8K–1M windows, calibrated profiles,
config normalization, profile precedence, conservative estimation, evidence
retention/de-duplication/trimming, summary packing (protected overflow, no
mid-section starts, single recall note), budgeted and legacy planning
(tool-pair invariants, capacity exception, progress guard), and controller
behaviour (trigger source, evidence retention, verification, shadow mode,
refusal, legacy parity, staged-entry/abort handling).
