/**
 * Auto-compaction configuration.
 *
 * Lives inside the existing `~/.pi/agent/pi-vcc-config.json` under `autoCompact`
 * so one file owns the whole VCC behaviour. Legacy fields are preserved but only
 * honoured in explicit `mode: "legacy"` compatibility mode.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BudgetProfile } from "./budget.ts";

export type AutoCompactMode = "budgeted" | "legacy";

export interface AutoCompactTelemetryConfig {
  enabled?: boolean;
  /** JSONL destination. Defaults to `<agentDir>/vcc-compaction-telemetry.jsonl`. */
  path?: string;
}

export interface AutoCompactConfig {
  enabled?: boolean;
  /**
   * `budgeted` (default) uses the model-aware budget controller.
   * `legacy` reproduces the old `maxPercent`-of-window controller exactly.
   */
  mode?: AutoCompactMode;
  /** Legacy only: trigger at this percentage of the context window. */
  maxPercent?: number;
  /** Compute and log the budgeted plan without committing a compaction. */
  shadow?: boolean;
  /** Tuning applied to every model before a profile override. */
  defaults?: BudgetProfile;
  /** Model profiles keyed by `provider/model`, `model`, or `*`. */
  profiles?: Record<string, BudgetProfile>;
  telemetry?: AutoCompactTelemetryConfig;
}

export const DEFAULT_PROFILE_KEY = "*";

export function agentDir(): string {
  return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function defaultConfigPath(): string {
  return process.env.PI_VCC_CONFIG_PATH ?? join(agentDir(), "pi-vcc-config.json");
}

export function defaultTelemetryPath(configPath: string = defaultConfigPath()): string {
  return join(dirname(configPath), "vcc-compaction-telemetry.jsonl");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeProfile = (value: unknown): BudgetProfile | undefined => {
  if (!isRecord(value)) return undefined;
  const profile: BudgetProfile = {};
  const numericKeys = [
    "charsPerToken",
    "qualityTargetRatio",
    "qualityTargetTokens",
    "postCompactionRatio",
    "summaryRatio",
    "evidenceRatio",
    "tailMaxRatio",
    "maxTailTokens",
    "minTailTokens",
    "safetyMarginRatio",
    "safetyMarginMin",
    "safetyMarginMax",
    "outputReserveRatio",
    "minQualityRatio",
    "minProgressRatio",
    "headroomToleranceRatio",
  ] as const;
  for (const key of numericKeys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      profile[key] = candidate;
    }
  }
  if (typeof value.calibrated === "boolean") profile.calibrated = value.calibrated;
  if (typeof value.source === "string" && value.source.trim()) profile.source = value.source.trim();
  return Object.keys(profile).length > 0 ? profile : undefined;
};

/**
 * Normalize an arbitrary parsed `autoCompact` value.
 * Invalid fields are dropped rather than throwing: a broken config must never
 * disable compaction silently or crash a turn.
 */
export function normalizeAutoCompactConfig(raw: unknown): AutoCompactConfig {
  if (!isRecord(raw)) return {};
  const config: AutoCompactConfig = {};
  if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
  if (raw.mode === "budgeted" || raw.mode === "legacy") config.mode = raw.mode;
  if (typeof raw.maxPercent === "number" && Number.isFinite(raw.maxPercent) &&
      raw.maxPercent > 0 && raw.maxPercent < 100) {
    config.maxPercent = raw.maxPercent;
  }
  if (typeof raw.shadow === "boolean") config.shadow = raw.shadow;
  const defaults = normalizeProfile(raw.defaults);
  if (defaults) config.defaults = defaults;
  if (isRecord(raw.profiles)) {
    const profiles: Record<string, BudgetProfile> = {};
    for (const [key, value] of Object.entries(raw.profiles)) {
      const profile = normalizeProfile(value);
      if (profile) profiles[key] = profile;
    }
    if (Object.keys(profiles).length > 0) config.profiles = profiles;
  }
  if (isRecord(raw.telemetry)) {
    const telemetry: AutoCompactTelemetryConfig = {};
    if (typeof raw.telemetry.enabled === "boolean") telemetry.enabled = raw.telemetry.enabled;
    if (typeof raw.telemetry.path === "string" && raw.telemetry.path.trim()) {
      telemetry.path = raw.telemetry.path.trim();
    }
    config.telemetry = telemetry;
  }
  return config;
}

/**
 * Resolve the policy.
 * Explicit `mode` always wins. A bare `maxPercent` with no mode is treated as
 * legacy so existing configs and tests keep their documented behaviour; new
 * configs should set `mode: "budgeted"`.
 */
export function resolvePolicyMode(config: AutoCompactConfig): AutoCompactMode {
  if (config.mode) return config.mode;
  if (typeof config.maxPercent === "number") return "legacy";
  return "budgeted";
}

export interface ResolvedProfile {
  key?: string;
  profile?: BudgetProfile;
}

/**
 * Look up the most specific profile: `provider/model`, then `model`, then `*`.
 */
export function resolveProfile(
  config: AutoCompactConfig,
  provider: string | undefined,
  modelId: string | undefined,
): ResolvedProfile {
  const profiles = config.profiles;
  if (!profiles) return {};
  const candidates: string[] = [];
  if (provider && modelId) candidates.push(`${provider}/${modelId}`);
  if (modelId) candidates.push(modelId);
  candidates.push(DEFAULT_PROFILE_KEY);
  for (const key of candidates) {
    const profile = profiles[key];
    if (profile) return { key, profile };
  }
  return {};
}
