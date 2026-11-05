"use client";

import React from "react";
import type { WebPluginDescriptor, WebView } from "@/lib/web-plugins-host";
import { TopSlotAdapter, type PluginWithView } from "./TopSlotAdapter";
import { BottomSlotAdapter } from "./BottomSlotAdapter";
import { CenterSlotAdapter } from "./CenterSlotAdapter";
import { FloatingSlotAdapter } from "./FloatingSlotAdapter";
import "@/components/plugins/plugins.css";

export type SlotPosition = "top" | "center" | "bottom" | "floating";

interface SlotHostProps {
  slot: SlotPosition;
  plugins: readonly WebPluginDescriptor[];
  views?: Record<string, Record<string, WebView>> | null;
  preferredSessionId?: string | null;
}

export function resolvePluginView(
  pluginId: string,
  views?: Record<string, Record<string, WebView>> | null,
  preferredSessionId?: string | null,
): WebView | null {
  if (!views) return null;
  if (preferredSessionId && views[preferredSessionId]?.[pluginId]) {
    return views[preferredSessionId][pluginId];
  }
  // Fall back to latest published view across any session
  for (const sessId of Object.keys(views)) {
    if (views[sessId]?.[pluginId]) {
      return views[sessId][pluginId];
    }
  }
  return null;
}

export function SlotHost({ slot, plugins, views, preferredSessionId }: SlotHostProps) {
  // 1. Find plugins declaring this slot surface
  const matchingPlugins = plugins.filter((plugin) =>
    plugin.surfaces.some((s) => s.kind === "slot" && "slot" in s && s.slot === slot),
  );

  // 2. Resolve views per plugin
  const pluginsWithViews: PluginWithView[] = [];
  for (const plugin of matchingPlugins) {
    const view = resolvePluginView(plugin.id, views, preferredSessionId);
    if (view) {
      pluginsWithViews.push({ plugin, view });
    }
  }

  // Empty slots render nothing at all (no empty chrome)
  if (pluginsWithViews.length === 0) {
    return null;
  }

  // Stacking order = descriptor order (already preserved by filter)
  switch (slot) {
    case "top":
      return <TopSlotAdapter pluginsWithViews={pluginsWithViews} />;
    case "bottom":
      return <BottomSlotAdapter pluginsWithViews={pluginsWithViews} />;
    case "center":
      return <CenterSlotAdapter pluginsWithViews={pluginsWithViews} />;
    case "floating":
      return <FloatingSlotAdapter pluginsWithViews={pluginsWithViews} />;
    default:
      return null;
  }
}
