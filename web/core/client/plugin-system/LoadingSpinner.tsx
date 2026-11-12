// A small spinning loader (Phosphor SpinnerGap + CSS spin) used wherever the
// Files and Artifacts panels are waiting on a fetch or a lazy chunk. Reuses
// the plugin CSS tokens so it reads the same in both light and dark themes.

import { SpinnerGap } from "@phosphor-icons/react";

export function LoadingSpinner({ label, size = 16 }: { label?: string; size?: number }) {
  return (
    <span
      className="loading-spinner"
      role="status"
      aria-live="polite"
      aria-label={label ?? "Loading"}
    >
      <SpinnerGap size={size} className="loading-spinner-icon" aria-hidden="true" />
      {label !== undefined ? <span className="loading-spinner-label">{label}</span> : null}
    </span>
  );
}