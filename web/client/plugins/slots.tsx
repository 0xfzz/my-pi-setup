// Slot host and adapters — ported from the vendored app's slots: plugins
// declare a slot surface (top/center/bottom/floating); the host resolves
// each plugin's view for the selected session and renders the region.
// Views are already the selected session's (the event stream filters).

import React, { useState } from "react";
import { CaretDown, CaretRight, SidebarSimple, X } from "@phosphor-icons/react";
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

/**
 * Center-slot item: when status-only (e.g. "No child agents"), it renders
 * as a clean compact strip so the chat is not interrupted by a large empty box.
 * When rich (kv/list/graph), it renders as a neat card with collapsible body
 * and a button to open in the Right Sidebar panel.
 */
function CenterSlotItem({
  plugin,
  view,
  onOpenSidePanel,
  isOpenInSidePanel,
}: PluginWithView & {
  onOpenSidePanel?: (pluginId: string) => void;
  isOpenInSidePanel?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const isDocked = isOpenInSidePanel === true;

  // Status view: keep it a single clean line — never a tall empty box.
  if (view.type === "status") {
    return (
      <div className="plugin-slot-center-item is-compact" data-plugin-id={plugin.id}>
        <div className="plugin-slot-center-header">
          <span className="plugin-slot-title">{plugin.title}</span>
          <span className="plugin-slot-sep">: </span>
          <span className={`plugin-slot-chip plugin-status-chip tone-${view.tone}`}>{view.text}</span>
          {onOpenSidePanel ? (
            <button
              type="button"
              className="plugin-slot-page-link"
              onClick={() => onOpenSidePanel(plugin.id)}
              title={`Open ${plugin.title} in side panel`}
            >
              {isDocked ? "Viewing in panel" : "Open"}
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className={`plugin-slot-center-item${isDocked ? " is-docked" : ""}`} data-plugin-id={plugin.id}>
      <div className="plugin-slot-center-header">
        <button
          type="button"
          className="plugin-slot-center-title-btn"
          onClick={() => setCollapsed((prev) => !prev)}
          aria-expanded={!collapsed && !isDocked}
          title={collapsed ? `Expand ${plugin.title}` : `Collapse ${plugin.title}`}
        >
          <span className="plugin-slot-title">{plugin.title}</span>
          {!isDocked ? (
            <span className="plugin-slot-collapse-indicator" aria-hidden="true">
              {collapsed ? <CaretRight size={12} /> : <CaretDown size={12} />}
            </span>
          ) : null}
        </button>
        <div className="plugin-slot-center-actions">
          {onOpenSidePanel ? (
            <button
              type="button"
              className={`plugin-slot-center-action${isDocked ? " is-active" : ""}`}
              onClick={() => onOpenSidePanel(plugin.id)}
              title={isDocked ? `Viewing ${plugin.title} in side panel` : `Open ${plugin.title} in side panel`}
              aria-label={`Open ${plugin.title} in side panel`}
            >
              <SidebarSimple size={14} />
            </button>
          ) : null}
        </div>
      </div>
      {!collapsed && !isDocked ? (
        <div className="plugin-slot-center-body">
          <PluginViewRenderer view={view} hideTitle={true} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Floating widget: renders the dock chip at bottom-right. Clicking delegates
 * to opening the Right Sidebar panel when available, or toggles local card.
 */
function FloatingWidgetItem({
  plugin,
  view,
  onOpenSidePanel,
  isActive,
}: PluginWithView & {
  onOpenSidePanel?: (pluginId: string) => void;
  isActive?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const handleClick = () => {
    if (onOpenSidePanel) {
      onOpenSidePanel(plugin.id);
      return;
    }
    setExpanded((prev) => !prev);
  };

  // When the side panel is already open showing this plugin, hide the floating chip to avoid redundancy.
  if (isActive) return null;

  return (
    <div className="plugin-slot-floating-widget">
      <button
        type="button"
        className={`plugin-slot-floating-chip${isActive ? " is-active" : ""}`}
        data-plugin-id={plugin.id}
        onClick={handleClick}
        aria-expanded={isActive || expanded}
        title={`${isActive ? "Close" : "Open"} ${plugin.title}`}
      >
        <span className="plugin-slot-floating-title">{plugin.title}</span>
      </button>
      {!onOpenSidePanel && expanded ? (
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
              <X size={14} />
            </button>
          </div>
          <div className="plugin-slot-floating-body">
            <PluginViewRenderer view={view} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export interface SlotHostProps {
  slot: SlotPosition;
  plugins: readonly WebPluginDescriptor[];
  views: Record<string, WebView> | null;
  onOpenSidePanel?: (pluginId: string) => void;
  activeSidePluginId?: string | null;
  sidePanelOpen?: boolean;
}

export function SlotHost({
  slot,
  plugins,
  views,
  onOpenSidePanel,
  activeSidePluginId,
  sidePanelOpen,
}: SlotHostProps) {
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
          <CenterSlotItem
            key={plugin.id}
            plugin={plugin}
            view={view}
            onOpenSidePanel={onOpenSidePanel}
            isOpenInSidePanel={sidePanelOpen && activeSidePluginId === plugin.id}
          />
        ))}
      </div>
    );
  }

  return (
    <aside className="plugin-slot-region plugin-slot-floating" aria-label="Floating plugins">
      {withViews.map((item) => (
        <FloatingWidgetItem
          key={item.plugin.id}
          plugin={item.plugin}
          view={item.view}
          onOpenSidePanel={onOpenSidePanel}
          isActive={sidePanelOpen && activeSidePluginId === item.plugin.id}
        />
      ))}
    </aside>
  );
}
