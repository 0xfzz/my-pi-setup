// The loading card is feedback for work that is actually slow, but every fetch
// publishes: a prompt fires several overlapping requests that settle in
// milliseconds, and publishing each transition makes the card blink on and off
// in the corner. Two bounds fix that without hiding genuinely slow work — the
// card is revealed only after work has been outstanding for a moment, and once
// revealed it stays long enough to be read.

/** How long work must stay outstanding before the card is worth showing. */
export const REQUEST_LOADING_REVEAL_MS = 250;
/** Once shown, the minimum time on screen: a reveal must not flash away. */
export const REQUEST_LOADING_MIN_VISIBLE_MS = 500;

export interface RequestLoadingState {
  /** When the current stretch of outstanding work began; null while idle. */
  pendingSince: number | null;
  /** When the card became visible; null while hidden. */
  visibleSince: number | null;
}

/** The resting state: nothing pending, nothing shown. */
export const REQUEST_LOADING_IDLE: RequestLoadingState = { pendingSince: null, visibleSince: null };

export type RequestLoadingAction =
  | { kind: "hold" }
  /** Reveal after `delayMs`; the change is skipped when the work ends first. */
  | { kind: "show"; delayMs: number }
  /** Hide after `delayMs`, never before the minimum visible time. */
  | { kind: "hide"; delayMs: number };

export interface RequestLoadingTick {
  /** The state to keep; the same object when nothing changed, so a hook does not re-render. */
  state: RequestLoadingState;
  action: RequestLoadingAction;
}

const HOLD: RequestLoadingAction = { kind: "hold" };

/**
 * One step of the reveal/hide decision.
 *
 * The clock is an argument, so the timing rules are testable without timers.
 */
export function requestLoadingTick(
  state: RequestLoadingState,
  input: { pending: number; now: number },
): RequestLoadingTick {
  const { pending, now } = input;
  if (pending > 0) {
    // Work is outstanding: remember when this stretch began, so overlapping
    // requests share one reveal deadline instead of restarting it.
    const pendingSince = state.pendingSince ?? now;
    const kept = state.pendingSince === pendingSince ? state : { ...state, pendingSince };
    if (state.visibleSince !== null) return { state: kept, action: HOLD };
    return { state: kept, action: { kind: "show", delayMs: Math.max(0, REQUEST_LOADING_REVEAL_MS - (now - pendingSince)) } };
  }
  if (state.visibleSince === null) {
    // Idle and hidden: forget the last stretch so the next one starts fresh.
    return { state: state.pendingSince === null ? state : { ...state, pendingSince: null }, action: HOLD };
  }
  return { state, action: { kind: "hide", delayMs: Math.max(0, REQUEST_LOADING_MIN_VISIBLE_MS - (now - state.visibleSince)) } };
}
