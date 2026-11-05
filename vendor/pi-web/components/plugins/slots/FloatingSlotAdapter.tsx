"use client";

import React, { useState } from "react";
import type { WebPluginDescriptor, WebView } from "@/lib/web-plugins-host";
import { PluginViewRenderer } from "../PluginViewRenderer";
import type { PluginWithView } from "./TopSlotAdapter";

interface FloatingSlotAdapterProps {
  pluginsWithViews: readonly PluginWithView[];
}

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

export function FloatingSlotAdapter({ pluginsWithViews }: FloatingSlotAdapterProps) {
  if (pluginsWithViews.length === 0) return null;

  return (
    <aside className="plugin-slot-region plugin-slot-floating" aria-label="Floating plugins">
      {pluginsWithViews.map((item) => (
        <FloatingWidgetItem key={item.plugin.id} plugin={item.plugin} view={item.view} />
      ))}
    </aside>
  );
}
