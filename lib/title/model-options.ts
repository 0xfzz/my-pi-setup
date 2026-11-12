import type { ThinkingLevel } from "@earendil-works/pi-ai/compat";

/**
 * Request budget for a title on a given model. Pure.
 *
 * A title needs no reasoning. Thinking is turned off whenever the model allows
 * it; a model that cannot turn it off gets the lowest thinking level it does
 * support and a larger budget, so the reasoning pass cannot use up the title.
 */

export const TITLE_MAX_TOKENS = 64;
export const TITLE_REASONING_MAX_TOKENS = 1_024;
/** Retry budget after a `length` stop: a truncated title is never accepted. */
const LENGTH_RETRY_FACTOR = 4;
const LEVELS_LOWEST_FIRST: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** The subset of a pi model these options read. */
export interface TitleModelLike {
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
}

export interface TitleRequestOptions {
  /** Omitted means thinking off. */
  reasoning?: ThinkingLevel;
  maxTokens: number;
}

export function titleRequestOptions(model: TitleModelLike): TitleRequestOptions {
  if (!model.reasoning) return { maxTokens: TITLE_MAX_TOKENS };
  const levels = model.thinkingLevelMap ?? {};
  if (levels.off !== null) return { maxTokens: TITLE_MAX_TOKENS };
  const lowest: ThinkingLevel = LEVELS_LOWEST_FIRST.find((level) => levels[level] !== null) ?? LEVELS_LOWEST_FIRST[0];
  return { reasoning: lowest, maxTokens: TITLE_REASONING_MAX_TOKENS };
}

/** The budget for the single retry after a `length` stop. */
export function lengthRetryOptions(options: TitleRequestOptions): TitleRequestOptions {
  return { ...options, maxTokens: options.maxTokens * LENGTH_RETRY_FACTOR };
}
