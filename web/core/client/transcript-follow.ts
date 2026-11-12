// Follow policy for the transcript: whether the view stays pinned to the
// newest content. Nothing here reads a clock. The view moves only when the
// reader is at the end (new content follows them), when they ask for the end
// (the jump button), or when they send a prompt. A reader who scrolled away
// to read is never pulled back by a timer or by a stream tick.

/** Within this distance of the bottom the reader counts as at the end. */
export const FOLLOW_THRESHOLD_PX = 48;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface FollowState {
  /** The view tracks the newest content. */
  pinned: boolean;
  /** Content arrived while the reader was away from the end. */
  unread: boolean;
}

export type FollowEvent =
  | { kind: "scrolled"; metrics: ScrollMetrics }
  | { kind: "grew" }
  | { kind: "jumped" };

export const INITIAL_FOLLOW: FollowState = { pinned: true, unread: false };

export function isNearEnd(metrics: ScrollMetrics): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < FOLLOW_THRESHOLD_PX;
}

export function reduceFollow(state: FollowState, event: FollowEvent): FollowState {
  if (event.kind === "jumped") return INITIAL_FOLLOW;
  if (event.kind === "scrolled") {
    const pinned = isNearEnd(event.metrics);
    return { pinned, unread: pinned ? false : state.unread };
  }
  if (state.pinned) return INITIAL_FOLLOW;
  return { pinned: false, unread: true };
}
