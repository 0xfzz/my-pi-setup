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

export interface ContextUsageView {
  /** 0–100, clamped. */
  percent: number;
  level: ContextLevel;
  /** "84% · 84k / 200k" */
  summary: string;
}

export function contextUsageView(usage: ContextUsage): ContextUsageView {
  const percent = clampPercent(usage.percent);
  return {
    percent,
    level: contextLevel(percent),
    summary: `${Math.round(percent)}% · ${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)}`,
  };
}