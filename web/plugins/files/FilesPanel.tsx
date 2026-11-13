// The Files panel chrome: reuses the right side panel's container classes so
// the built-in Files feature looks and behaves like every plugin panel, while
// owning its own header/close and the browser ↔ preview switch.

import { useEffect, useState } from "react";
import { X } from "@phosphor-icons/react";
import type { FileRef } from "./files-api.ts";
import { FileBrowser } from "./FileBrowser.tsx";
import { FilePreview } from "./FilePreview.tsx";

export interface FilesPanelProps {
  open: boolean;
  onClose: () => void;
  sessionId: string | null;
  rootLabel: string;
}

export function FilesPanel({ open, onClose, sessionId, rootLabel }: FilesPanelProps) {
  const [selected, setSelected] = useState<FileRef | null>(null);

  // Auto-close on Esc, but never swallow an Escape a nested control (the ⋯
  // menu) already handled.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="app-side-panel-scrim" onClick={onClose} aria-hidden="true" />
      <aside
        id="plugin-side-panel"
        className="app-side-panel"
        role="complementary"
        aria-label="Files panel"
      >
        <div className="app-side-panel-header">
          <span className="app-side-panel-title" title={rootLabel}>Files · {rootLabel}</span>
          <div className="app-side-panel-actions">
            <button
              type="button"
              className="app-side-panel-action-btn"
              onClick={onClose}
              title="Close panel"
              aria-label="Close panel"
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="app-side-panel-body app-files-panel-body">
          {sessionId === null ? (
            <div className="files-empty">No session selected.</div>
          ) : selected !== null ? (
            <FilePreview sessionId={sessionId} file={selected} onBack={() => setSelected(null)} />
          ) : (
            <FileBrowser sessionId={sessionId} onOpenFile={setSelected} />
          )}
        </div>
      </aside>
    </>
  );
}