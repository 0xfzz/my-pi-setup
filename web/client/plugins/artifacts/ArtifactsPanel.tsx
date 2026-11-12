// The Artifacts panel chrome: reuses the right side panel's container classes
// so the catalog reads like any other plugin panel, while owning its own
// header/close and the catalog ↔ preview switch.

import { useEffect, useMemo, useState } from "react";
import { X } from "@phosphor-icons/react";
import type { WebView } from "../contract.ts";
import { ArtifactCatalog, type ArtifactRow } from "./ArtifactCatalog.tsx";
import { ArtifactPreview } from "./ArtifactPreview.tsx";

function normalize(view: WebView | null | undefined): ArtifactRow[] {
  if (view === null || view === undefined || view.type !== "list") return [];
  return view.items.map((item) =>
    typeof item === "string"
      ? { title: item, detail: null }
      : { title: item.text, detail: item.detail ?? null },
  );
}

export interface ArtifactsPanelProps {
  open: boolean;
  onClose: () => void;
  view: WebView | null | undefined;
}

export function ArtifactsPanel({ open, onClose, view }: ArtifactsPanelProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const rows = useMemo(() => normalize(view), [view]);

  // A new session's view must not keep the previous session's open artifact.
  useEffect(() => {
    setSelected(null);
  }, [view]);

  // Auto-close on Esc, never swallowing an Escape a nested menu already handled.
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

  const selectedRow = selected !== null ? rows[selected] ?? null : null;

  return (
    <>
      <div className="app-side-panel-scrim" onClick={onClose} aria-hidden="true" />
      <aside
        id="plugin-side-panel"
        className="app-side-panel"
        role="complementary"
        aria-label="Artifacts panel"
      >
        <div className="app-side-panel-header">
          <span className="app-side-panel-title">Artifacts{rows.length > 0 ? ` · ${rows.length}` : ""}</span>
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
        <div className="app-side-panel-body app-artifacts-panel-body">
          {selectedRow !== null ? (
            <ArtifactPreview title={selectedRow.title} detail={selectedRow.detail} onBack={() => setSelected(null)} />
          ) : rows.length === 0 ? (
            <div className="artifacts-empty">No artifacts recorded on this branch yet.</div>
          ) : (
            <ArtifactCatalog items={rows} onSelect={setSelected} />
          )}
        </div>
      </aside>
    </>
  );
}