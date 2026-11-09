// Slot host and adapters — ported from the vendored app's slots: plugins
// declare a slot surface (top/center/bottom/floating); the host resolves
// each plugin's view for the selected session and renders the region.
// Views are already the selected session's (the event stream filters).

import React, { useState } from "react";
import type { WebPluginDescriptor, WebView } from "./contract.ts";
import { PluginViewRenderer } from "./PluginViewRenderer.tsx";

export type SlotPosition = "top" | "center" | "bottom" | "floating";

interface PluginWithView {
  plugin: WebPluginDescriptor;
  view: WebView;
}

function formatCompactView(view: WebView): string {
  if (view.type === "kv") {
    if (view.rows.length === 0) return "";
    const first = view.rows[0];
    return `${first.label}: ${first.value}`;
  }
  if (view.type === "list") {
    const count = view.items.length;
    const countText = `${count} ${count === 1 ? "item" : "items"}`;
    if (count > 0 && view.items[0]) {
      const first = view.items[0];
      const text = typeof first === "string" ? first : first.text;
      return `${countText} (${text})`;
    }
    return countText;
  }
  if (view.type === "status") {
    return view.text;
  }
  return "";
}

function pagePathFor(plugin: WebPluginDescriptor): string | null {
  const surface = plugin.surfaces.find((s) => s.kind === "page");
  return surface && "path" in surface ? (surface.path as string) : null;
}

/** Compact one-line row for the top and bottom strips. */
function CompactRow({ plugin, view }: PluginWithView) {
  const pagePath = pagePathFor(plugin);
  if (view.type === "status") {
    return (
      <div className="plugin-slot-row plugin-slot-top-row" data-plugin-id={plugin.id}>
        <span className="plugin-slot-title">{plugin.title}</span>
        <span className="plugin-slot-sep">: </span>
        <span className={`plugin-slot-chip plugin-status-chip tone-${view.tone}`}>{view.text}</span>
        {pagePath ? (
          <a href={pagePath} className="plugin-slot-page-link" title={`Open ${plugin.title} page`}>
            Open
          </a>
        ) : null}
      </div>
    );
  }
  const summary = formatCompactView(view);
  return (
    <div className="plugin-slot-row plugin-slot-top-row" data-plugin-id={plugin.id}>
      <span className="plugin-slot-title">{plugin.title}</span>
      {summary ? <span className="plugin-slot-sep">: </span> : null}
      {summary ? <span className="plugin-slot-content">{summary}</span> : null}
      {pagePath ? (
        <a href={pagePath} className="plugin-slot-page-link" title={`Open ${plugin.title} page`}>
          Open
        </a>
      ) : null}
    </div>
  );
}

/** Floating widget: a chip when collapsed, a full view card when expanded. */
function FloatingWidgetItem({ plugin, view }: PluginWithView) {
  const [expanded, setExpanded] = useState(false);

  if (!expanded) {
    return (
      <button
        type="button"
        className="plugin-slot-floating-chip"
        data-plugin-id={plugin.id}
        onClick={() => setExpanded(true)}
        aria-expanded={false}
        title={`Expand ${plugin.title}`}
      >
        <span className="plugin-slot-floating-title">{plugin.title}</span>
      </button>
    );
  }

  return (
    <div className="plugin-slot-floating-card" data-plugin-id={plugin.id}>
      <div className="plugin-slot-floating-header">
        <span className="plugin-slot-floating-card-title">{plugin.title}</span>
        <button
          type="button"
          className="plugin-slot-floating-close"
          onClick={() => setExpanded(false)}
          aria-expanded={true}
          title={`Collapse ${plugin.title}`}
          aria-label={`Collapse ${plugin.title}`}
        >
          ✕
        </button>
      </div>
      <div className="plugin-slot-floating-body">
        <PluginViewRenderer view={view} />
      </div>
    </div>
  );
}

export interface SlotHostProps {
  slot: SlotPosition;
  plugins: readonly WebPluginDescriptor[];
  views: Record<string, WebView> | null;
}

export function SlotHost({ slot, plugins, views }: SlotHostProps) {
  const withViews: PluginWithView[] = [];
  for (const plugin of plugins) {
    const hasSlot = plugin.surfaces.some(
      (surface) => surface.kind === "slot" && surface.slot === slot,
    );
    if (!hasSlot) continue;
    const view = views?.[plugin.id];
    if (view !== undefined && view !== null) {
      withViews.push({ plugin, view });
    }
  }
  if (withViews.length === 0) return null;

  if (slot === "top" || slot === "bottom") {
    return (
      <div className={`plugin-slot-region plugin-slot-${slot}`} role="region" aria-label={`${slot} plugins`}>
        {withViews.map((item) => (
          <CompactRow key={item.plugin.id} plugin={item.plugin} view={item.view} />
        ))}
      </div>
    );
  }

  if (slot === "center") {
    return (
      <div className="plugin-slot-region plugin-slot-center" role="region" aria-label="Center plugins">
        {withViews.map(({ plugin, view }) => (
          <div key={plugin.id} className="plugin-slot-center-item" data-plugin-id={plugin.id}>
            <div className="plugin-slot-center-header">
              <span className="plugin-slot-title">{plugin.title}</span>
            </div>
            <PluginViewRenderer view={view} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <aside className="plugin-slot-region plugin-slot-floating" aria-label="Floating plugins">
      {withViews.map((item) => (
        <FloatingWidgetItem key={item.plugin.id} plugin={item.plugin} view={item.view} />
      ))}
    </aside>
  );
}
