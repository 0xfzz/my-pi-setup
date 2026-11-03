import test from "node:test";
import assert from "node:assert/strict";
import { describeBudget, mergeTuning, resolveBudget } from "../lib/vcc/budget.ts";
import {
  normalizeAutoCompactConfig,
  resolvePolicyMode,
  resolveProfile,
} from "../lib/vcc/config.ts";
import { estimateMessageTokens, estimateTextTokens } from "../lib/vcc/estimate.ts";

const windows = [8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 1_048_576];

test("every window yields ordered budgets inside its own capacity", () => {
  for (const window of windows) {
    const budget = resolveBudget({ contextWindow: window });
    assert.ok(budget, `window ${window} must resolve`);
    assert.ok(budget.inputAllowance > 0);
    assert.ok(budget.inputAllowance < window, "output and safety reserves are subtracted");
    assert.ok(budget.qualityTarget <= budget.inputAllowance, "trigger cannot exceed capacity");
    assert.ok(budget.postCompactionTarget < budget.qualityTarget, "must land strictly below the trigger");
    assert.ok(budget.summaryBudget > 0 && budget.summaryBudget < budget.postCompactionTarget);
    assert.ok(budget.tailMin <= budget.tailMax);
    assert.ok(budget.tailMax > 0);
    assert.equal(budget.calibrated, false, "a fallback target is never reported as calibrated");
    assert.equal(budget.source, "fallback");
  }
});

test("small windows keep a usable summary instead of a percentage of a percentage", () => {
  const budget = resolveBudget({ contextWindow: 16_000 })!;
  // The previous policy produced a 800-token tail here; the budget policy keeps
  // at least the summary meaningful and does not shave the trigger to nothing.
  assert.ok(budget.qualityTarget > 5_000);
  assert.ok(budget.summaryBudget >= 1_000);
  assert.match(describeBudget(budget), /trigger .* summary .* fallback/);
});

test("a calibrated profile overrides the fallback target and is attributed", () => {
  const budget = resolveBudget({
    contextWindow: 32_000,
    profile: { qualityTargetRatio: 0.45, calibrated: true, source: "sweep-2026-05" },
  })!;
  const fallback = resolveBudget({ contextWindow: 32_000 })!;
  assert.ok(budget.qualityTarget < fallback.qualityTarget);
  assert.equal(budget.calibrated, true);
  assert.equal(budget.source, "profile");
  assert.equal(budget.profileKey, "sweep-2026-05");
});

test("absolute quality targets are clamped to real capacity", () => {
  const budget = resolveBudget({
    contextWindow: 16_000,
    profile: { qualityTargetTokens: 1_000_000, calibrated: true },
  })!;
  assert.equal(budget.qualityTarget, budget.inputAllowance);
});

test("output reserve never exceeds the provider cap or half the window", () => {
  const budget = resolveBudget({ contextWindow: 8_000, modelMaxOutputTokens: 900_000 })!;
  assert.equal(budget.outputReserve, 4_000);
  assert.equal(budget.inputAllowance, 8_000 - 4_000 - budget.safetyMargin);
});

test("invalid windows resolve to undefined instead of a bogus budget", () => {
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(resolveBudget({ contextWindow: value }), undefined);
  }
});

test("tuning merges fallback < defaults < profile", () => {
  const tuning = mergeTuning({ summaryRatio: 0.2 }, { summaryRatio: 0.3, evidenceRatio: 0.5 });
  assert.equal(tuning.summaryRatio, 0.3);
  assert.equal(tuning.evidenceRatio, 0.5);
  assert.equal(tuning.qualityTargetRatio, 0.7, "unset keys keep the fallback");
});

test("policy mode defaults to budgeted and preserves explicit legacy configs", () => {
  assert.equal(resolvePolicyMode({}), "budgeted");
  assert.equal(resolvePolicyMode({ enabled: true }), "budgeted");
  assert.equal(resolvePolicyMode({ maxPercent: 20 }), "legacy");
  assert.equal(resolvePolicyMode({ mode: "budgeted", maxPercent: 20 }), "budgeted");
  assert.equal(resolvePolicyMode({ mode: "legacy" }), "legacy");
});

test("configuration normalization drops invalid values instead of throwing", () => {
  const config = normalizeAutoCompactConfig({
    enabled: "yes",
    mode: "nonsense",
    maxPercent: 250,
    shadow: true,
    profiles: { "p/m": { qualityTargetRatio: 0.5, calibrated: true, bogus: 1 }, bad: null },
    telemetry: { enabled: false },
  });
  assert.equal(config.enabled, undefined);
  assert.equal(config.mode, undefined);
  assert.equal(config.maxPercent, undefined, "out-of-range percentages are ignored");
  assert.equal(config.shadow, true);
  assert.deepEqual(Object.keys(config.profiles ?? {}), ["p/m"]);
  assert.equal(config.profiles?.["p/m"].calibrated, true);
  assert.equal(config.telemetry?.enabled, false);
  assert.deepEqual(normalizeAutoCompactConfig(null), {});
  assert.deepEqual(normalizeAutoCompactConfig([1, 2]), {});
});

test("profiles resolve provider/model, then model, then wildcard", () => {
  const config = normalizeAutoCompactConfig({
    profiles: {
      "openai/gpt": { qualityTargetRatio: 0.6 },
      gpt: { qualityTargetRatio: 0.5 },
      "*": { qualityTargetRatio: 0.4 },
    },
  });
  assert.equal(resolveProfile(config, "openai", "gpt").key, "openai/gpt");
  assert.equal(resolveProfile(config, "other", "gpt").key, "gpt");
  assert.equal(resolveProfile(config, "other", "x").key, "*");
  assert.deepEqual(resolveProfile({}, "a", "b"), {});
});

test("estimates are conservative for wide scripts and honour the multiplier", () => {
  const latin = estimateTextTokens("a".repeat(350));
  assert.equal(latin, 100);
  const cjk = estimateTextTokens("日".repeat(50));
  assert.equal(cjk, 50, "wide code points cost one token each");
  assert.ok(estimateTextTokens("日本語のテキスト", 4) > 0);
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimateMessageTokens({ role: "compactionSummary", summary: "a".repeat(350) }), 100);
  assert.equal(estimateMessageTokens({ role: "toolResult", content: [{ type: "image" }] }), 1200);
});

test("estimateTextTokens fast path agrees with the code-point count", () => {
  assert.equal(estimateTextTokens("abcdefg"), 2);
  assert.equal(estimateTextTokens("日本語"), 3);
  assert.equal(estimateTextTokens("日本語abcdefg"), 3 + 2);
  assert.equal(estimateTextTokens("é".repeat(7)), 2, "Latin-1 stays narrow");
});
