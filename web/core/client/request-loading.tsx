import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { LoadingSpinner } from "./plugin-system/LoadingSpinner.tsx";
import { requestActivity } from "./request-activity.ts";
import { REQUEST_LOADING_IDLE, requestLoadingTick, type RequestLoadingState } from "./request-loading-state.ts";

/**
 * Whether the loading card is worth showing right now.
 *
 * The reveal and hide delays live in `request-loading-state.ts`; this hook only
 * applies them, so a prompt's quick overlapping fetches cannot blink the card.
 */
function useRequestLoading(): { visible: boolean; pending: number } {
  const pending = useSyncExternalStore(requestActivity.subscribe, requestActivity.getSnapshot);
  const [state, setState] = useState<RequestLoadingState>(REQUEST_LOADING_IDLE);
  useEffect(() => {
    const tick = requestLoadingTick(state, { pending, now: Date.now() });
    if (tick.state !== state) setState(tick.state);
    if (tick.action.kind === "hold") return;
    // The cleanup is the point: work that ends before the deadline clears the
    // timer, so the card never appears for a request that already finished.
    const timer = setTimeout(() => {
      setState(tick.action.kind === "show"
        ? { pendingSince: tick.state.pendingSince ?? Date.now(), visibleSince: Date.now() }
        : REQUEST_LOADING_IDLE);
    }, tick.action.delayMs);
    return () => clearTimeout(timer);
  }, [pending, state]);
  return { visible: state.visibleSince !== null, pending };
}

/** Always above panels/dialogs, but never intercepts taps or moves the layout. */
export function RequestLoading() {
  const { visible, pending } = useRequestLoading();
  if (!visible) return null;
  // Escape the fixed root's stacking context, just like dialog portals do.
  return createPortal(
    <div className="app-request-loading" data-testid="request-loading">
      <LoadingSpinner label="Loading… Please wait." />
      {pending > 1 ? <span className="app-request-count">{pending} requests</span> : null}
    </div>,
    document.body,
  );
}
