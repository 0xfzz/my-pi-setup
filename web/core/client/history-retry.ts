// How a conversation's history read recovers when it stalls or fails. A phone
// that switches networks can leave a fetch hanging for minutes; without a
// timeout the transcript stays on "Loading conversation…" and buffers every
// live reply behind it. Each attempt is bounded, and a failed attempt retries
// with a growing wait. Retries never give up: settling on an empty transcript
// after a slow network would hide the whole conversation, while a retry costs
// one small request every few seconds.

/**
 * How long one history read may take before it is abandoned. Generous on
 * purpose: a long conversation over a slow mobile link is a slow read, not a
 * stalled one, and aborting it only repeats the work.
 */
export const HISTORY_FETCH_TIMEOUT_MS = 30_000;

/** The wait before each early retry, in order; later retries use the last. */
const HISTORY_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];

/** The wait before retry number `attempt` (0 = the first retry). */
export function historyRetryDelayMs(attempt: number): number {
  const index = Number.isInteger(attempt) && attempt > 0 ? attempt : 0;
  return HISTORY_RETRY_DELAYS_MS[Math.min(index, HISTORY_RETRY_DELAYS_MS.length - 1)];
}
