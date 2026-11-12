// Right-hand side panel for plugins (Artifacts, Delegated work, etc.).
// Replaces the awkward floating popup card in the corner with a first-class
// side panel docked beside the chat (like ChatGPT Canvas / Claude Artifacts).

import { useEffect } from "react";
import { ArrowSquareOut, X } from "@phosphor-icons/react";
import type { WebPluginDescriptor, WebView } from "./contract.ts";
import { PluginViewRenderer } from "./PluginViewRenderer.tsx";
import { PluginActions } from "./PluginActions.tsx";

export interface PluginSidePanelProps {
  open: boolean;
  activePluginId: string | null;
  onClose: () => void;
  plugins: readonly WebPluginDescriptor[];
  views: Record<string, WebView> | null;
  sessionId: string | null;
}

function pagePathFor(plugin: WebPluginDescriptor): string | null {
  const surface = plugin.surfaces.find((s) => s.kind === "page");
  return surface && "path" in surface ? (surface.path as string) : null;
}

export function PluginSidePanel({
  open,
  activePluginId,
  onClose,
  plugins,
  views,
  sessionId,
}: PluginSidePanelProps) {
  const activePlugin = plugins.find((plugin) =>
    plugin.id === activePluginId && views?.[plugin.id] != null,
  );

  // Auto-close on Esc
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open || activePlugin === undefined) return null;

  const currentView = views?.[activePlugin.id] ?? null;
  const pagePath = pagePathFor(activePlugin);

  return (
    <>
      <div className="app-side-panel-scrim" onClick={onClose} aria-hidden="true" />
      <aside
        id="plugin-side-panel"
        className="app-side-panel"
        role="complementary"
        aria-label={`${activePlugin.title} panel`}
      >
        <div className="app-side-panel-header">
          <span className="app-side-panel-title">{activePlugin.title}</span>
          <div className="app-side-panel-actions">
            {pagePath ? (
              <a
                href={pagePath}
                className="app-side-panel-action-btn"
                title={`Open full ${activePlugin.title} page`}
                aria-label={`Open full ${activePlugin.title} page`}
              >
                <ArrowSquareOut size={16} />
              </a>
            ) : null}
            <button
              type="button"
              className="app-side-panel-action-btn plugin-slot-floating-close"
              onClick={onClose}
              title="Close panel"
              aria-label="Close panel"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="app-side-panel-body">
          <PluginViewRenderer view={currentView} hideTitle={true} />
          {activePlugin.actions && activePlugin.actions.length > 0 ? (
            <PluginActions
              pluginId={activePlugin.id}
              sessionId={sessionId}
              actions={activePlugin.actions}
            />
          ) : null}
        </div>
      </aside>
    </>
  );
}
