"use client";

import React, { useState } from "react";
import type { WebPluginDescriptor, WebView } from "@/lib/web-plugins-host";
import {
  PluginViewRenderer,
  SessionStatusDot,
  usePluginData,
  type PluginSessionState,
} from "../PluginViewRenderer";
import "@/components/plugins/plugins.css";

export type SlotPosition = "top" | "center" | "bottom" | "floating";

export interface PluginWithViewAndSession {
  plugin: WebPluginDescriptor;
  view: WebView;
  sessionId: string;
}

export interface SlotHostProps {
  slot: SlotPosition;
  plugins: readonly WebPluginDescriptor[];
  views?: Record<string, Record<string, WebView>> | null;
  preferredSessionId?: string | null;
  sessions?: Record<string, PluginSessionState> | null;
}

export function resolvePluginView(
  pluginId: string,
  views?: Record<string, Record<string, WebView>> | null,
  preferredSessionId?: string | null,
): WebView | null {
  const resolved = resolvePluginViewAndSession(pluginId, views, preferredSessionId);
  return resolved ? resolved.view : null;
}

export function resolvePluginViewAndSession(
  pluginId: string,
  views?: Record<string, Record<string, WebView>> | null,
  preferredSessionId?: string | null,
): { view: WebView; sessionId: string } | null {
  if (!views) return null;
  if (preferredSessionId && views[preferredSessionId]?.[pluginId]) {
    return { view: views[preferredSessionId][pluginId], sessionId: preferredSessionId };
  }
  // Fall back to latest published view across any session
  for (const sessId of Object.keys(views)) {
    if (views[sessId]?.[pluginId]) {
      return { view: views[sessId][pluginId], sessionId: sessId };
    }
  }
  return null;
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

function CenterPanelItem({
  plugin,
  view,
  sessionId,
  sessionInfo,
}: PluginWithViewAndSession & { sessionInfo?: PluginSessionState }) {
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
        <SessionStatusDot
          running={sessionInfo?.running}
          awaitingInput={sessionInfo?.awaitingInput}
          sessionId={sessionId}
        />
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

function FloatingWidgetItem({
  plugin,
  view,
  sessionId,
  sessionInfo,
}: PluginWithViewAndSession & { sessionInfo?: PluginSessionState }) {
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
        <SessionStatusDot
          running={sessionInfo?.running}
          awaitingInput={sessionInfo?.awaitingInput}
          sessionId={sessionId}
        />
        <span className="plugin-slot-floating-title">{plugin.title}</span>
      </button>
    );
  }

  return (
    <div className="plugin-slot-floating-card" data-plugin-id={plugin.id}>
      <div className="plugin-slot-floating-header">
        <SessionStatusDot
          running={sessionInfo?.running}
          awaitingInput={sessionInfo?.awaitingInput}
          sessionId={sessionId}
        />
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

export function SlotHost({
  slot,
  plugins,
  views,
  preferredSessionId,
  sessions: explicitSessions,
}: SlotHostProps) {
  const hookData = usePluginData();
  const effectiveSessions = explicitSessions ?? hookData.sessions;

  // 1. Find plugins declaring this slot surface
  const matchingPlugins = plugins.filter((plugin) =>
    plugin.surfaces.some((s) => s.kind === "slot" && "slot" in s && s.slot === slot),
  );

  // 2. Resolve views per plugin
  const pluginsWithViews: PluginWithViewAndSession[] = [];
  for (const plugin of matchingPlugins) {
    const resolved = resolvePluginViewAndSession(plugin.id, views, preferredSessionId);
    if (resolved) {
      pluginsWithViews.push({ plugin, view: resolved.view, sessionId: resolved.sessionId });
    }
  }

  // Empty slots render nothing at all (no empty chrome)
  if (pluginsWithViews.length === 0) {
    return null;
  }

  switch (slot) {
    case "top":
      return (
        <div className="plugin-slot-region plugin-slot-top" role="region" aria-label="Top plugins">
          {pluginsWithViews.map(({ plugin, view, sessionId }) => {
            const pageSurface = plugin.surfaces.find((s) => s.kind === "page");
            const pagePath = pageSurface && "path" in pageSurface ? (pageSurface.path as string) : null;
            const sessionInfo = effectiveSessions?.[sessionId];

            if (view.type === "status") {
              return (
                <div key={plugin.id} className="plugin-slot-row plugin-slot-top-row" data-plugin-id={plugin.id}>
                  <SessionStatusDot
                    running={sessionInfo?.running}
                    awaitingInput={sessionInfo?.awaitingInput}
                    sessionId={sessionId}
                  />
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
                <SessionStatusDot
                  running={sessionInfo?.running}
                  awaitingInput={sessionInfo?.awaitingInput}
                  sessionId={sessionId}
                />
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

    case "bottom":
      return (
        <div className="plugin-slot-region plugin-slot-bottom" role="region" aria-label="Bottom plugins">
          {pluginsWithViews.map(({ plugin, view, sessionId }) => {
            const pageSurface = plugin.surfaces.find((s) => s.kind === "page");
            const pagePath = pageSurface && "path" in pageSurface ? (pageSurface.path as string) : null;
            const summary = formatCompactView(view);
            const sessionInfo = effectiveSessions?.[sessionId];

            return (
              <div key={plugin.id} className="plugin-slot-row plugin-slot-bottom-row" data-plugin-id={plugin.id}>
                <SessionStatusDot
                  running={sessionInfo?.running}
                  awaitingInput={sessionInfo?.awaitingInput}
                  sessionId={sessionId}
                />
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

    case "center":
      return (
        <div className="plugin-slot-region plugin-slot-center" role="region" aria-label="Center plugins">
          {pluginsWithViews.map((item) => (
            <CenterPanelItem
              key={item.plugin.id}
              plugin={item.plugin}
              view={item.view}
              sessionId={item.sessionId}
              sessionInfo={effectiveSessions?.[item.sessionId]}
            />
          ))}
        </div>
      );

    case "floating":
      return (
        <aside className="plugin-slot-region plugin-slot-floating" aria-label="Floating plugins">
          {pluginsWithViews.map((item) => (
            <FloatingWidgetItem
              key={item.plugin.id}
              plugin={item.plugin}
              view={item.view}
              sessionId={item.sessionId}
              sessionInfo={effectiveSessions?.[item.sessionId]}
            />
          ))}
        </aside>
      );

    default:
      return null;
  }
}
