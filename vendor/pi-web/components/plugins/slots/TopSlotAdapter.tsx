"use client";

import React from "react";
import type { WebPluginDescriptor, WebView } from "@/lib/web-plugins-host";

export interface PluginWithView {
  plugin: WebPluginDescriptor;
  view: WebView;
}

interface TopSlotAdapterProps {
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
    return view.text;
  }
  return "";
}

export function TopSlotAdapter({ pluginsWithViews }: TopSlotAdapterProps) {
  if (pluginsWithViews.length === 0) return null;

  return (
    <div className="plugin-slot-region plugin-slot-top" role="region" aria-label="Top plugins">
      {pluginsWithViews.map(({ plugin, view }) => {
        const pageSurface = plugin.surfaces.find((s) => s.kind === "page");
        const pagePath = pageSurface && "path" in pageSurface ? (pageSurface.path as string) : null;

        if (view.type === "status") {
          return (
            <div key={plugin.id} className="plugin-slot-row plugin-slot-top-row" data-plugin-id={plugin.id}>
              <span className="plugin-slot-title">{plugin.title}</span>
              <span className="plugin-slot-sep">: </span>
              <span
                className={`plugin-slot-chip plugin-status-chip ${plugin.id === "bubbly-spinner" ? "plugin-bubbly-chip" : ""} tone-${view.tone}`}
                data-testid={plugin.id === "bubbly-spinner" ? "bubbly-chip" : undefined}
              >
                {view.text}
              </span>
              {pagePath && (
                <a href={pagePath} className="plugin-slot-page-link" title={`Open ${plugin.title} page`}>
                  Open
                </a>
              )}
            </div>
          );
        }

        const summary = formatCompactView(view);

        return (
          <div key={plugin.id} className="plugin-slot-row plugin-slot-top-row" data-plugin-id={plugin.id}>
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
