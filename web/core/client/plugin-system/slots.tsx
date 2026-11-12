// Slot host and adapters — plugins declare a slot surface (top/center/bottom/
// floating) and a placement in their ui contribution (strategy, bounds,
// collision). The host resolves each plugin's view for the selected session
// and renders it under that slot's policy (slot-policy.ts): a compact strategy
// is one summary line, bounds clamp the card, and collision decides what gives
// way on a phone. Views are already the selected session's (the event stream
// filters).

import React, { useState, type CSSProperties } from "react";
import { CaretDown, CaretRight, SidebarSimple, X } from "@phosphor-icons/react";
import type { WebPluginDescriptor, WebView } from "./contract.ts";
import { PluginViewRenderer } from "./PluginViewRenderer.tsx";
import { compactSummary, slotPolicy, startsCollapsed, type SlotCollision, type SlotPolicy, type SlotPosition } from "./slot-policy.ts";

export type { SlotPosition } from "./slot-policy.ts";

interface PluginWithView {
  plugin: WebPluginDescriptor;
  view: WebView;
}

function pagePathFor(plugin: WebPluginDescriptor): string | null {
  const surface = plugin.surfaces.find((s) => s.kind === "page");
  return surface && "path" in surface ? (surface.path as string) : null;
}

/** One-line row for the top and bottom strips, and for compact-strategy slots. */
function CompactRow({ plugin, view, collision }: PluginWithView & { collision: SlotCollision }) {
  const pagePath = pagePathFor(plugin);
  const pageLink = pagePath ? (
    <a href={pagePath} className="plugin-slot-page-link" title={`Open ${plugin.title} page`}>
      Open
    </a>
  ) : null;
  if (view.type === "status") {
    return (
      <div className="plugin-slot-row plugin-slot-top-row" data-plugin-id={plugin.id} data-collision={collision}>
        <span className="plugin-slot-title">{plugin.title}</span>
        <span className="plugin-slot-sep">: </span>
        <span className={`plugin-slot-chip plugin-status-chip tone-${view.tone}`}>{view.text}</span>
        {pageLink}
      </div>
    );
  }
  const summary = compactSummary(view);
  return (
    <div className="plugin-slot-row plugin-slot-top-row" data-plugin-id={plugin.id} data-collision={collision}>
      <span className="plugin-slot-title">{plugin.title}</span>
      {summary ? <span className="plugin-slot-sep">: </span> : null}
      {summary ? <span className="plugin-slot-content">{summary}</span> : null}
      {pageLink}
    </div>
  );
}

/**
 * Center-slot item: when status-only (e.g. "No child agents"), it renders
 * as a clean compact strip so the chat is not interrupted by a large empty box.
 * When rich (kv/list/graph), it renders as a neat card with collapsible body
 * and a button to open in the Right Sidebar panel. The body is bounded by the
 * slot policy, so a long view scrolls inside its card.
 */
function CenterSlotItem({
  plugin,
  view,
  policy,
  onOpenSidePanel,
  isOpenInSidePanel,
}: PluginWithView & {
  policy: SlotPolicy;
  onOpenSidePanel?: (pluginId: string) => void;
  isOpenInSidePanel?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(() => startsCollapsed(window.innerWidth));
  const isDocked = isOpenInSidePanel === true;

  // Status view: keep it a single clean line — never a tall empty box.
  if (view.type === "status") {
    return (
      <div className="plugin-slot-center-item is-compact" data-plugin-id={plugin.id} data-collision={policy.collision}>
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
    <div
      className={`plugin-slot-center-item${isDocked ? " is-docked" : ""}`}
      data-plugin-id={plugin.id}
      data-collision={policy.collision}
    >
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
        <div
          className="plugin-slot-center-body"
          style={{ "--plugin-body-max-height": `${policy.bodyMaxHeight}px` } as CSSProperties}
        >
          <PluginViewRenderer view={view} hideTitle={true} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Floating widget: renders the dock chip at the top-right of the transcript.
 * Clicking delegates to opening the Right Sidebar panel when available, or
 * toggles a local card bounded by the slot policy.
 */
function FloatingWidgetItem({
  plugin,
  view,
  policy,
  onOpenSidePanel,
  isActive,
}: PluginWithView & {
  policy: SlotPolicy;
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
    <div className="plugin-slot-floating-widget" data-collision={policy.collision}>
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
        <div
          className="plugin-slot-floating-card"
          data-plugin-id={plugin.id}
          style={{
            "--plugin-card-width": `${policy.cardMaxWidth}px`,
            "--plugin-body-max-height": `${policy.bodyMaxHeight}px`,
          } as CSSProperties}
        >
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
          <CompactRow
            key={item.plugin.id}
            plugin={item.plugin}
            view={item.view}
            collision={slotPolicy(item.plugin, slot).collision}
          />
        ))}
      </div>
    );
  }

  if (slot === "center") {
    return (
      <div className="plugin-slot-region plugin-slot-center" role="region" aria-label="Center plugins">
        {withViews.map(({ plugin, view }) => {
          const policy = slotPolicy(plugin, slot);
          if (policy.compact) {
            return <CompactRow key={plugin.id} plugin={plugin} view={view} collision={policy.collision} />;
          }
          return (
            <CenterSlotItem
              key={plugin.id}
              plugin={plugin}
              view={view}
              policy={policy}
              onOpenSidePanel={onOpenSidePanel}
              isOpenInSidePanel={sidePanelOpen && activeSidePluginId === plugin.id}
            />
          );
        })}
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
          policy={slotPolicy(item.plugin, slot)}
          onOpenSidePanel={onOpenSidePanel}
          isActive={sidePanelOpen && activeSidePluginId === item.plugin.id}
        />
      ))}
    </aside>
  );
}
