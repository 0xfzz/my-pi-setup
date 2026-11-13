import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { LoadingSpinner } from "./plugin-system/LoadingSpinner.tsx";
import { requestActivity } from "./request-activity.ts";

/** Always above panels/dialogs, but never intercepts taps or moves the layout. */
export function RequestLoading() {
  const pending = useSyncExternalStore(requestActivity.subscribe, requestActivity.getSnapshot);
  if (pending === 0) return null;
  // Escape the fixed root's stacking context, just like dialog portals do.
  return createPortal(
    <div className="app-request-loading" data-testid="request-loading">
      <LoadingSpinner label="Loading… Please wait." />
      {pending > 1 ? <span className="app-request-count">{pending} requests</span> : null}
    </div>,
    document.body,
  );
}
