// Context-window usage formatting for the composer's meter. Pure helpers so
// the thresholds and token formatting are unit-tested without a browser.

/** The session state already carries this shape; reusing it keeps the meter honest. */
export interface ContextUsage {
  percent: number;
  contextWindow: number;
  tokens: number;
}

export type ContextLevel = "normal" | "warning" | "critical";

export const WARNING_PERCENT = 80;
export const CRITICAL_PERCENT = 95;

export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

export function contextLevel(percent: number): ContextLevel {
  const value = clampPercent(percent);
  if (value >= CRITICAL_PERCENT) return "critical";
  if (value >= WARNING_PERCENT) return "warning";
  return "normal";
}

/** "999", "8.4k", "200k", "1.2M" — tabular, one decimal only under 10k. */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** Parts the composer renders, ready to display even when some data is missing. */
export interface ContextUsageDisplay {
  /** "42%", or "—" when the window is unknown. */
  percentLabel: string;
  /** "84k" used tokens, or "—" when no usage reading exists. */
  tokensLabel: string;
  /** "200k" window, or "—" when the window is unknown. */
  maxLabel: string;
  /** 0–100 fill length; 0 when the percentage is unknown. */
  fillPercent: number;
  level: ContextLevel;
}

/**
 * Format a context usage for the bar. A missing window (or a missing whole
 * reading) renders as em-dashes rather than a misleading `0 / 0`, so a new
 * session and an existing session with an unknown window stay honest.
 */
export function contextUsageDisplay(usage: ContextUsage | null | undefined): ContextUsageDisplay {
  if (usage === null || usage === undefined) {
    return { percentLabel: "—", tokensLabel: "—", maxLabel: "—", fillPercent: 0, level: "normal" };
  }

  const hasWindow = Number.isFinite(usage.contextWindow) && usage.contextWindow > 0;
  const hasTokens = Number.isFinite(usage.tokens) && usage.tokens >= 0;
  const percent = hasWindow && Number.isFinite(usage.percent)
    ? clampPercent(usage.percent)
    : null;

  return {
    percentLabel: percent === null ? "—" : `${Math.round(percent)}%`,
    tokensLabel: hasTokens ? formatTokens(usage.tokens) : "—",
    maxLabel: hasWindow ? formatTokens(usage.contextWindow) : "—",
    fillPercent: percent === null ? 0 : percent,
    level: percent === null ? "normal" : contextLevel(percent),
  };
}