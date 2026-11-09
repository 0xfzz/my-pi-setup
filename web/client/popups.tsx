// The web port of the TUI's UI primitives — the "design system" side:
// toasts (ui.notify), status chips (ui.status.changed), editor widgets
// (ui.widget.changed), custom popup panels (ui.custom.changed) and the
// TUI-dialog-waiting banner (ui_prompt_start). Extensions drive all of them
// through the same publishWebUi events the TUI uses; nothing here is
// web-plugin-specific, which is what makes it a core surface to extend on.

import { useEffect, useState } from "react";
import type { CustomPanelLike, UiPromptLike, WebNotificationLike, WidgetModelLike } from "./use-session.ts";

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

/** Custom popups: centered panels of lines, one per open custom id. */
export function CustomPopups({ custom }: { custom: Record<string, CustomPanelLike> }) {
  const entries = Object.entries(custom).filter(([, panel]) => panel.lines !== null);
  if (entries.length === 0) return null;
  return (
    <div className="app-custom-popups">
      {entries.map(([id, panel]) => (
        <div key={id} className="app-custom-popup" role="dialog" aria-label={panel.method}>
          <div className="app-custom-popup-head">
            <span className="app-custom-popup-title">{panel.method}</span>
          </div>
          <pre className="app-custom-popup-lines">{(panel.lines ?? []).join("\n")}</pre>
        </div>
      ))}
    </div>
  );
}

/** A TUI-side dialog has focus: pi is blocked there until it is answered. */
export function UiPromptBanner({ prompt }: { prompt: UiPromptLike | null }) {
  if (prompt === null) return null;
  return (
    <div className="app-tui-prompt-banner" role="status">
      pi is waiting on a {prompt.kind} dialog{prompt.title !== undefined ? ` — “${prompt.title}”` : ""} in the
      terminal. Answer it there.
    </div>
  );
}
