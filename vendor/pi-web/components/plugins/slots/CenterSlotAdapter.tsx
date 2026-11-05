"use client";

import React, { useState } from "react";
import type { WebPluginDescriptor, WebView } from "@/lib/web-plugins-host";
import { PluginViewRenderer } from "../PluginViewRenderer";
import type { PluginWithView } from "./TopSlotAdapter";

interface CenterSlotAdapterProps {
  pluginsWithViews: readonly PluginWithView[];
}

function CenterPanelItem({ plugin, view }: PluginWithView) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="plugin-slot-center-panel" data-plugin-id={plugin.id}>
      <button
        type="button"
        className="plugin-slot-center-header"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        title={expanded ? `Collapse ${plugin.title}` : `Expand ${plugin.title}`}
      >
        <span className="plugin-slot-center-title">{plugin.title}</span>
        <span className="plugin-slot-collapse-indicator" aria-hidden="true">
          {expanded ? "▼" : "▶"}
        </span>
      </button>
      {expanded && (
        <div className="plugin-slot-center-body">
          <PluginViewRenderer view={view} />
        </div>
      )}
    </div>
  );
}

export function CenterSlotAdapter({ pluginsWithViews }: CenterSlotAdapterProps) {
  if (pluginsWithViews.length === 0) return null;

  return (
    <div className="plugin-slot-region plugin-slot-center" role="region" aria-label="Center plugins">
      {pluginsWithViews.map((item) => (
        <CenterPanelItem key={item.plugin.id} plugin={item.plugin} view={item.view} />
      ))}
    </div>
  );
}
