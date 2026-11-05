"use client";

import React from "react";
import type { WebPluginDescriptor, WebView } from "@/lib/web-plugins-host";
import type { PluginWithView } from "./TopSlotAdapter";

interface BottomSlotAdapterProps {
  pluginsWithViews: readonly PluginWithView[];
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
      return `${countText} (${view.items[0]})`;
    }
    return countText;
  }
  if (view.type === "status") {
    return `[${view.tone}] ${view.text}`;
  }
  return "";
}

export function BottomSlotAdapter({ pluginsWithViews }: BottomSlotAdapterProps) {
  if (pluginsWithViews.length === 0) return null;

  return (
    <div className="plugin-slot-region plugin-slot-bottom" role="region" aria-label="Bottom plugins">
      {pluginsWithViews.map(({ plugin, view }) => {
        const pageSurface = plugin.surfaces.find((s) => s.kind === "page");
        const pagePath = pageSurface && "path" in pageSurface ? (pageSurface.path as string) : null;
        const summary = formatCompactView(view);

        return (
          <div key={plugin.id} className="plugin-slot-row plugin-slot-bottom-row" data-plugin-id={plugin.id}>
            <span className="plugin-slot-title">{plugin.title}</span>
            {summary && <span className="plugin-slot-sep">: </span>}
            {summary && <span className="plugin-slot-content">{summary}</span>}
            {pagePath && (
              <a href={pagePath} className="plugin-slot-page-link" title={`Open ${plugin.title} page`}>
                Open
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
