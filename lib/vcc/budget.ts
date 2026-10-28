/**
 * Model-aware context budget resolution.
 *
 * Three numbers are kept separate, because conflating them is what made the
 * previous 20%-of-window policy wrong for small models:
 *
 *   A (inputAllowance)       hard capacity: what the provider will accept
 *   T (qualityTarget)        where compaction should start, for this model
 *   P (postCompactionTarget) where the request should land after compaction
 *
 * Quality targets are *not* derivable from the advertised window. A profile may
 * carry a calibrated `qualityTargetRatio`/`qualityTargetTokens`; otherwise this
 * resolver applies documented fallback seeds and reports `calibrated: false` so
 * telemetry never confuses a guess with a measurement.
 */

export const DEFAULT_CHARS_PER_TOKEN = 3.5;
const TOKENS_PER_K = 1000;
const MIN_SECTION_TOKENS = 192;
const MIN_EVIDENCE_TOKENS = 96;

export interface BudgetTuning {
  /** Conservative characters-per-token divisor for narrow scripts. */
  charsPerToken?: number;
  /** Fraction of the input allowance used as the compaction trigger. Fallback only. */
  qualityTargetRatio?: number;
  /** Absolute quality target in tokens; overrides `qualityTargetRatio`. */
  qualityTargetTokens?: number;
  /** Where post-compaction usage should land, as a fraction of the quality target. */
  postCompactionRatio?: number;
  /** Share of the post-compaction target reserved for the summary. */
  summaryRatio?: number;
  /** Share of the summary budget reserved for retained observations. */
  evidenceRatio?: number;
  /** Upper bound for the retained recent tail, as a fraction of the quality target. */
  tailMaxRatio?: number;
  /** Absolute cap for the retained recent tail. */
  maxTailTokens?: number;
  /** Absolute floor for the retained recent tail. */
  minTailTokens?: number;
  /** Safety margin as a fraction of the context window. */
  safetyMarginRatio?: number;
  safetyMarginMin?: number;
  safetyMarginMax?: number;
  /** Output/reasoning reservation as a fraction of the context window. */
  outputReserveRatio?: number;
  /** Minimum share of the input allowance that must remain summarizable. */
  minQualityRatio?: number;
  /** Minimum new (non-summary) tokens before another compaction is allowed. */
  minProgressRatio?: number;
  /** Accepted overshoot of the post-compaction target before it is an exception. */
  headroomToleranceRatio?: number;
}

export interface BudgetProfile extends BudgetTuning {
  /** True only when the target came from measured evaluation for this model/task. */
  calibrated?: boolean;
  /** Provenance for a calibrated target, e.g. an evaluation run id or date. */
  source?: string;
}

export interface ResolveBudgetInput {
  contextWindow: number;
  /** Provider/model output cap, when the runtime exposes it. */
  modelMaxOutputTokens?: number;
  /** Output tokens the next request is expected to request. */
  requestedOutputTokens?: number;
  profile?: BudgetProfile;
  defaults?: BudgetProfile;
}

export interface ContextBudget {
  contextWindow: number;
  /** A: hard input capacity after output and safety reserves. */
  inputAllowance: number;
  /** T: whole-request usage at which compaction starts. */
  qualityTarget: number;
  /** P: whole-request usage the compacted request should land under. */
  postCompactionTarget: number;
  /** Token budget for the compacted summary (headers + evidence + brief). */
  summaryBudget: number;
  /** Token budget for retained tool-result evidence inside the summary. */
  evidenceBudget: number;
  tailMin: number;
  tailMax: number;
  /** Minimum new tokens before another compaction is allowed. */
  minProgressTokens: number;
  outputReserve: number;
  safetyMargin: number;
  charsPerToken: number;
  calibrated: boolean;
  source: "profile" | "defaults" | "fallback";
  profileKey?: string;
  tuning: Required<BudgetTuning>;
}

export const FALLBACK_TUNING: Required<BudgetTuning> = {
  charsPerToken: DEFAULT_CHARS_PER_TOKEN,
  // Engineering seeds to evaluate, not research-proven optima.
  qualityTargetRatio: 0.7,
  qualityTargetTokens: 0,
  postCompactionRatio: 0.7,
  summaryRatio: 0.25,
  evidenceRatio: 0.35,
  tailMaxRatio: 0.6,
  maxTailTokens: 40 * TOKENS_PER_K,
  minTailTokens: 128,
  safetyMarginRatio: 0.02,
  safetyMarginMin: 256,
  safetyMarginMax: 4096,
  outputReserveRatio: 0.15,
  minQualityRatio: 0.1,
  minProgressRatio: 0.1,
  headroomToleranceRatio: 1.05,
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

/** Merge tuning in precedence order: fallback < defaults < profile. */
export function mergeTuning(
  ...layers: Array<BudgetProfile | undefined>
): Required<BudgetTuning> {
  const merged: Required<BudgetTuning> = { ...FALLBACK_TUNING };
  for (const layer of layers) {
    if (!layer) continue;
    for (const key of Object.keys(FALLBACK_TUNING) as Array<keyof BudgetTuning>) {
      const value = layer[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

/**
 * Resolve the whole-request budgets for one model.
 * Returns `undefined` only when the context window is unusable.
 */
export function resolveBudget(input: ResolveBudgetInput): ContextBudget | undefined {
  const window = Math.floor(input.contextWindow);
  if (!Number.isFinite(window) || window <= 0) return undefined;

  const tuning = mergeTuning(input.defaults, input.profile);
  const profileTarget = positive(input.profile?.qualityTargetTokens);
  const defaultTarget = positive(input.defaults?.qualityTargetTokens);

  // Output reserve: never reserve more than half the window, and never more
  // than the provider's own output cap when one is known.
  const halfWindow = Math.floor(window / 2);
  const outputCap = positive(input.modelMaxOutputTokens);
  const requestedReserve =
    positive(input.requestedOutputTokens) ??
    outputCap ??
    Math.ceil(window * tuning.outputReserveRatio);
  const outputReserve = clamp(
    Math.floor(requestedReserve),
    0,
    outputCap !== undefined ? Math.min(outputCap, halfWindow) : halfWindow,
  );

  const safetyMargin = clamp(
    Math.ceil(window * tuning.safetyMarginRatio),
    tuning.safetyMarginMin,
    tuning.safetyMarginMax,
  );

  const inputAllowance = Math.max(1, window - outputReserve - safetyMargin);

  const minQuality = clamp(
    Math.ceil(inputAllowance * tuning.minQualityRatio),
    Math.min(256, inputAllowance),
    inputAllowance,
  );
  const rawTarget =
    profileTarget ?? defaultTarget ?? Math.ceil(inputAllowance * tuning.qualityTargetRatio);
  const qualityTarget = clamp(Math.floor(rawTarget), minQuality, inputAllowance);

  const postFloor = Math.min(
    qualityTarget,
    Math.max(256, Math.ceil(inputAllowance * 0.15)),
  );
  const postCompactionTarget = clamp(
    Math.ceil(qualityTarget * tuning.postCompactionRatio),
    postFloor,
    qualityTarget,
  );

  const summaryCap = Math.max(1, Math.floor(postCompactionTarget * 0.5));
  const summaryBudget = clamp(
    Math.ceil(postCompactionTarget * tuning.summaryRatio),
    Math.min(MIN_SECTION_TOKENS, summaryCap),
    summaryCap,
  );

  const evidenceBudget = clamp(
    Math.ceil(summaryBudget * tuning.evidenceRatio),
    Math.min(MIN_EVIDENCE_TOKENS, summaryBudget),
    summaryBudget,
  );

  const tailMax = Math.max(
    tuning.minTailTokens,
    Math.min(tuning.maxTailTokens, Math.ceil(qualityTarget * tuning.tailMaxRatio)),
  );
  const tailMin = Math.min(tailMax, tuning.minTailTokens);

  const minProgressTokens = clamp(
    Math.ceil(qualityTarget * tuning.minProgressRatio),
    128,
    Math.min(4096, Math.max(128, qualityTarget)),
  );

  const calibrated = input.profile?.calibrated === true;
  const source: ContextBudget["source"] =
    input.profile !== undefined ? "profile" : input.defaults !== undefined ? "defaults" : "fallback";

  return {
    contextWindow: window,
    inputAllowance,
    qualityTarget,
    postCompactionTarget,
    summaryBudget,
    evidenceBudget,
    tailMin,
    tailMax,
    minProgressTokens,
    outputReserve,
    safetyMargin,
    charsPerToken: tuning.charsPerToken,
    calibrated,
    source,
    profileKey: input.profile?.source,
    tuning,
  };
}

/** Compact single-line rendering for status lines and command output. */
export function describeBudget(budget: ContextBudget): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return (
    `window ${k(budget.contextWindow)} · trigger ${k(budget.qualityTarget)} · ` +
    `land ${k(budget.postCompactionTarget)} · summary ${k(budget.summaryBudget)} · ` +
    `tail ${k(budget.tailMin)}-${k(budget.tailMax)} · ` +
    `${budget.calibrated ? "calibrated" : "fallback"}`
  );
}
