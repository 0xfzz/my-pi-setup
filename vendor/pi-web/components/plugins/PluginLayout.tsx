"use client";

import React, { useState, type CSSProperties, type ReactNode } from "react";
import { normalizeContributions, type WebUiAnchor, type WebUiRegion, type WebPluginUiContribution, type WebPluginPlacement } from "../../../../lib/web-plugins/ui-contract.ts";
import type { WebPluginDescriptor } from "../../../../lib/web-plugins/descriptor.ts";
import type { WebUiSessionState } from "../../../../lib/web-plugins/ui-store.ts";
import type { WebView } from "../../../../lib/web-plugins/view.ts";
import { useWebUiState } from "@/hooks/useWebUiState";
import { useIsMobile } from "@/hooks/useIsMobile";
import { SessionStatusDot } from "./PluginViewRenderer";
import { UiComponent } from "./UiComponent";
import "./plugins.css";

function location(p: WebPluginPlacement, mobile: boolean): string {
  if (mobile && p.mobileFallback) return p.mobileFallback;
  return p.kind === "region" ? p.region : p.kind === "anchor" ? p.anchor : p.anchor ?? "viewport.overlay";
}
function scopedSession(scope: WebPluginUiContribution["scope"], sessionId: string | null | undefined, project: string | null | undefined, sessions: Record<string, WebUiSessionState>): [string, WebUiSessionState] | undefined {
  // A selected session only ever shows its own state. With no selection at all
  // the most recent session still hosts session-scoped UI, as the legacy slots did.
  if (scope === "session") {
    if (sessionId) return Object.hasOwn(sessions, sessionId) ? [sessionId, sessions[sessionId]] : undefined;
    return Object.entries(sessions).filter(([, s]) => !s.closed).sort((a, b) => b[1].revision - a[1].revision || a[0].localeCompare(b[0]))[0];
  }
  return Object.entries(sessions).filter(([, s]) => scope === "global" || (!!project && s.project === project)).sort((a, b) => b[1].revision - a[1].revision || a[0].localeCompare(b[0]))[0];
}
function contributionStyle(p: WebPluginPlacement): CSSProperties {
  return {
    minWidth: p.collision === "shrink" ? 0 : p.minWidth ? `min(${p.minWidth}px, 100%)` : undefined,
    maxWidth: p.maxWidth ? `min(${p.maxWidth}px, 100%)` : "100%",
    minHeight: p.minHeight, maxHeight: p.maxHeight ? `min(${p.maxHeight}px, 100%)` : undefined,
    flexShrink: p.collision === "stack" ? 0 : 1,
    zIndex: p.zIndex === "overlay" ? 3 : p.zIndex === "raised" ? 2 : 1,
    ...(p.kind === "overlay" ? { marginTop: p.inset?.top, marginRight: p.inset?.right, marginBottom: p.inset?.bottom, marginLeft: p.inset?.left } : {}),
  };
}
function Contribution({ plugin, contribution: c, state, sessionId, view, place, mobile, running }: { plugin: WebPluginDescriptor; contribution: WebPluginUiContribution; state: WebUiSessionState; sessionId: string; view?: WebView; place: WebPluginPlacement; mobile: boolean; running: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [closed, setClosed] = useState(false);
  const owner = `${plugin.id}/${c.id}`;
  if (closed) return null;
  const region = place.kind === "region" ? place.region : undefined;
  const overlay = place.kind === "overlay" && !(mobile && place.mobileFallback);
  const collapsible = region === "center" || region === "floating";
  let model: Parameters<typeof UiComponent>[0]["model"];
  if (c.component === "ui.working-indicator.v1") model = { kind: "working", value: state.working };
  else if (c.component === "ui.extension-status.v1") model = { kind: "status", value: state.statuses };
  else {
    if (!view) return null;
    model = { kind: "view", value: view };
  }
  const compact = (region === "top" || region === "bottom") && model.kind === "view";
  const page = plugin.surfaces.find(s => s.kind === "page");
  const content = <UiComponent component={c.component} sessionId={sessionId} model={model} fallback={compact && model.kind === "view" ? <span className="plugin-slot-content">{model.value.type === "status" ? model.value.text : model.value.type === "kv" ? model.value.rows[0] ? `${model.value.rows[0].label}: ${model.value.rows[0].value}` : "" : `${model.value.items.length} items (${model.value.items[0] ?? ""})`}</span> : undefined} />;
  const title = <><SessionStatusDot sessionId={sessionId} running={running} /><span className={region === "center" ? "plugin-slot-center-title" : "plugin-slot-title"}>{plugin.title}</span></>;
  return <section tabIndex={overlay ? 0 : undefined} data-plugin-id={plugin.id} data-contribution-id={c.id} data-ui-owner={owner} data-scope={c.scope} data-collision={place.collision ?? "stack"}
    className={`web-ui-contribution ${overlay ? "web-ui-overlay" : ""} ${region === "center" ? "plugin-slot-center-panel" : region === "floating" ? "plugin-slot-floating-widget" : "plugin-slot-row"}`}
    style={contributionStyle(place)}>
    {collapsible ? <>
      <button type="button" className={region === "center" ? "plugin-slot-center-header" : "plugin-slot-floating-chip"} onClick={() => setExpanded(v => !v)} aria-expanded={expanded}>{title}</button>
      {expanded && <div className={region === "center" ? "plugin-slot-center-body" : "plugin-slot-floating-card"}>
        {region === "floating" && <button type="button" className="plugin-slot-floating-close" aria-label={`Collapse ${plugin.title}`} onClick={() => setExpanded(false)}>✕</button>}
        <div className={region === "floating" ? "plugin-slot-floating-body" : undefined}>{content}</div>
      </div>}
    </> : <>
      <header className="web-ui-contribution-header">{title}{overlay && <button type="button" aria-label={`Close ${plugin.title}`} onClick={event => {
        // Keep keyboard focus within the verified host, never leave it on a removed overlay.
        const host = event.currentTarget.closest<HTMLElement>("[data-web-ui-anchor]");
        host?.focus(); setClosed(true);
      }}>✕</button>}</header>
      {content}{page?.kind === "page" && <a href={page.path} className="plugin-slot-page-link">Open</a>}
    </>}
  </section>;
}
export function PluginAnchor({ anchor, region, sessionId, project, children }: { anchor?: WebUiAnchor; region?: WebUiRegion; sessionId?: string | null; project?: string | null; children?: ReactNode }) {
  const data = useWebUiState();
  const mobile = useIsMobile();
  const target = anchor ?? region;
  const nodes: { key: string; order: number; node: ReactNode }[] = [];
  for (const plugin of data.plugins) for (const c of normalizeContributions(plugin)) {
    if (c.override) continue; // Override declarations are consumed at the target, not duplicated.
    const scoped = scopedSession(c.scope, sessionId, project, data.ui?.sessions ?? {});
    if (!scoped) continue;
    const [id, state] = scoped;
    const place = state.layouts[`${plugin.id}/${c.id}`] ?? c.placement;
    if (location(place, mobile) !== target) continue;
    const view = data.views[id]?.[c.view ?? plugin.id];
    const running = data.sessions[id]?.running ?? state.running;
    if ((c.visibleWhen === "running" && !running) || (c.visibleWhen === "idle" && running) || (c.visibleWhen === "has-view" && !view)) continue;
    nodes.push({ key: `${plugin.id}/${c.id}`, order: place.order ?? 0, node: <Contribution key={`${id}/${plugin.id}/${c.id}`} plugin={plugin} contribution={c} state={state} sessionId={id} view={view} place={place} mobile={mobile} running={running} /> });
  }
  nodes.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  if (!nodes.length && !children) return null;
  return <div tabIndex={-1} data-web-ui-anchor={target} className={`web-ui-anchor${region ? ` plugin-slot-region plugin-slot-${region}` : ""}${anchor === "viewport.overlay" ? " web-ui-overlay-safe" : ""}`}>
    {children}{nodes.map(n => n.node)}
  </div>;
}
