// The web port of the TUI's UI primitives — the "design system" side:
// toasts (ui.notify), status chips (ui.status.changed), editor widgets
// (ui.widget.changed), custom popup panels (ui.custom.changed) and the
// TUI-dialog-waiting banner (ui_prompt_start). Extensions drive all of them
// through the same publishWebUi events the TUI uses; nothing here is
// web-plugin-specific, which is what makes it a core surface to extend on.

import { useEffect, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import { useModalFocus } from "./dialogs.tsx";
import type { UiPromptLike } from "./use-session.ts";
import type { CustomPanelLike, WebNotificationLike, WidgetModelLike } from "./plugin-system/contract.ts";

/** How long a toast stays on screen. */
const TOAST_TTL_MS = 6_000;

/** Transient notifications, bottom-right, auto-expiring. */
export function ToastStack({
  notifications,
}: {
  notifications: WebNotificationLike[];
}) {
  const [, setTick] = useState(0);

  // Expire old toasts client-side: the server keeps the bounded list, the
  // clock lives here.
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, []);

  const now = Date.now();
  const live = notifications.filter((toast) => now - toast.timestamp < TOAST_TTL_MS).slice(-4);
  if (live.length === 0) return null;

  return (
    <div className="app-toasts" role="status" aria-live="polite">
      {live.map((toast) => (
        <div key={`${toast.id}-${toast.timestamp}`} className={`app-toast app-toast-${toast.level}`}>
          <span className="app-toast-message">{toast.message}</span>
        </div>
      ))}
    </div>
  );
}

/** Footer-style status chips: the latest status text, dim, in the header. */
export function StatusChips({ statuses }: { statuses: Record<string, string> }) {
  const entries = Object.entries(statuses).slice(0, 6);
  if (entries.length === 0) return null;
  return (
    <span className="app-status-chips">
      {entries.map(([key, text]) => (
        <span key={key} className="app-status-chip" title={text}>
          {text}
        </span>
      ))}
    </span>
  );
}

/** Editor widgets: bordered line blocks above or below the composer. */
export function EditorWidgets({
  widgets,
  placement,
}: {
  widgets: Record<string, WidgetModelLike>;
  placement: "aboveEditor" | "belowEditor";
}) {
  const matching = Object.entries(widgets).filter(([, widget]) => widget.placement === placement);
  if (matching.length === 0) return null;
  return (
    <div className={`app-widgets app-widgets-${placement}`}>
      {matching.map(([key, widget]) => (
        <pre key={key} className="app-widget-lines">{widget.lines.join("\n")}</pre>
      ))}
    </div>
  );
}

function popupSignature(id: string, panel: CustomPanelLike): string {
  return `${id}\u0000${(panel.lines ?? []).join("\n")}`;
}

function CustomPopup({
  id,
  panel,
  onDismiss,
}: {
  id: string;
  panel: CustomPanelLike;
  onDismiss: (signature: string) => void;
}) {
  const titleId = `app-custom-popup-title-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return (
    <div
      className="app-custom-popup app-popup-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <div className="app-custom-popup-head">
        <span id={titleId} className="app-custom-popup-title">{panel.method}</span>
        <button type="button" className="app-dialog-close app-popup-close" aria-label="Close popup" onClick={() => onDismiss(popupSignature(id, panel))}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {(panel.lines ?? []).length === 0 ? (
        <div className="app-custom-popup-empty">No details.</div>
      ) : (
        <pre className="app-custom-popup-lines">{(panel.lines ?? []).join("\n")}</pre>
      )}
    </div>
  );
}

/** Custom popups: centered panels of lines, one per open custom id. */
export function CustomPopups({ custom }: { custom: Record<string, CustomPanelLike> }) {
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const entries = Object.entries(custom).filter(([id, panel]) =>
    panel.lines !== null && !dismissed.includes(popupSignature(id, panel)));
  const backdropRef = useRef<HTMLDivElement>(null);
  useModalFocus(backdropRef, { enabled: entries.length > 0 });
  if (entries.length === 0) return null;
  return (
    <div ref={backdropRef} data-modal-root tabIndex={-1} className="app-custom-popups">
      {entries.map(([id, panel]) => (
        <CustomPopup
          key={id}
          id={id}
          panel={panel}
          onDismiss={(signature) => setDismissed((previous) => [...previous, signature])}
        />
      ))}
    </div>
  );
}

/** A TUI-side dialog has focus: pi is blocked there until it is answered. */
export function UiPromptBanner({ prompt }: { prompt: UiPromptLike | null }) {
  if (prompt === null) return null;
  return (
    <div className="app-tui-prompt-banner" role="status" aria-live="polite">
      pi is waiting on a {prompt.kind} dialog{prompt.title !== undefined ? ` — “${prompt.title}”` : ""} in the
      terminal. Answer it there.
    </div>
  );
}

/** A /reload or code-change reload is in flight: a quiet, functional "still loading" strip. */
export function ReloadingBanner({ active, message }: { active: boolean; message?: string | null }) {
  if (!active) return null;
  return (
    <div className="app-reloading-banner" role="status" aria-live="polite">
      <span className="app-reloading-spinner" aria-hidden="true" />
      {message ?? "pi is reloading…"}
    </div>
  );
}
