"use client";

import React, { Component, useEffect, useState, type ReactNode } from "react";
import { normalizeContributions, resolveOverrides, type WebUiComponent, type OwnedContribution } from "@/lib/web-ui-contracts";
import { validateWebUiEvent, type WorkingModel } from "@/lib/web-ui-event-models";
import { validateView, type WebView } from "@/lib/web-ui-views";
import { reportUiFailure, useWebUiState } from "@/hooks/useWebUiState";
import { PluginViewRenderer } from "./PluginViewRenderer";

type UiModel = { kind: "working"; value: WorkingModel } | { kind: "view"; value: WebView } | { kind: "status"; value: Record<string, string> };
const disabled = new Map<string, Set<string>>();
function disabledFor(sessionId: string): Set<string> {
  if (!disabled.has(sessionId)) {
    if (disabled.size >= 128) disabled.delete(disabled.keys().next().value!);
    disabled.set(sessionId, new Set());
  }
  return disabled.get(sessionId)!;
}
export function getDisabledUiContributions(sessionId: string): readonly string[] {
  return [...(disabled.get(sessionId) ?? [])].sort();
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); for (const v of Object.values(value)) freeze(v); }
  return value;
}
function checkedModel(component: WebUiComponent, model: UiModel): UiModel {
  if (component === "ui.working-indicator.v1") {
    const valid = validateWebUiEvent({ version: 1, eventId: "render", sessionId: "render", source: "host", sourceKey: "render", type: "ui.working.changed", sequence: 1, timestamp: 0, payload: model.value });
    if (model.kind !== "working" || !valid.ok) throw new Error("working model/schema mismatch");
  } else if (component === "ui.extension-status.v1") {
    if (model.kind !== "status" || Object.values(model.value).some(v => typeof v !== "string")) throw new Error("status model/schema mismatch");
  } else if (model.kind !== "view" || !validateView(model.value).ok) throw new Error("view model/schema mismatch");
  return freeze(structuredClone(model));
}
function Working({ value, compact = false }: { value: WorkingModel; compact?: boolean }) {
  const [frame, setFrame] = useState(0);
  const frames = value.frames ?? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const signature = frames.join("\u0000");
  useEffect(() => {
    if (frames.length < 2 || !value.visible) return;
    const timer = setInterval(() => setFrame(n => n + 1), value.intervalMs);
    return () => clearInterval(timer);
  }, [signature, frames.length, value.intervalMs, value.visible]);
  if (!value.visible) return null;
  return <span className={`web-ui-working${compact ? " is-compact" : ""}`} data-testid="web-ui-working" data-frames={signature}>
    {frames.length > 0 && <span aria-hidden="true" className="web-ui-working-frame">{frames[frame % frames.length]}</span>}
    <span className="web-ui-working-message">{value.message ?? "Working…"}</span>
  </span>;
}
export function compactView(view: WebView): string {
  switch (view.type) {
    case "status": return view.text;
    case "kv": return view.rows[0] ? `${view.rows[0].label}: ${view.rows[0].value}` : "";
    case "list": {
      const count = view.items.length;
      const first = view.items[0];
      const firstText = typeof first === "string" ? first : first?.text;
      return `${count} ${count === 1 ? "item" : "items"}${firstText ? ` (${firstText})` : ""}`;
    }
    case "graph": {
      const count = view.nodes.length;
      return `${count} ${count === 1 ? "node" : "nodes"}${view.edges.length ? ` · ${view.edges.length} edges` : ""}`;
    }
  }
}
function strategy(model: UiModel, mode: "default" | "compact" | "card", children?: ReactNode): ReactNode {
  const started = performance.now();
  let result: ReactNode;
  if (children !== undefined) result = <div className={`web-ui-wrap web-ui-strategy-${mode}`}>{children}</div>;
  else if (model.kind === "working") result = <Working value={model.value} compact={mode === "compact"} />;
  else if (model.kind === "status") result = <span className="web-ui-status">{Object.entries(model.value).map(([key, text]) => <span key={key}>{text}</span>)}</span>;
  else result = mode === "compact" ? <span className="plugin-slot-content">{compactView(model.value)}</span> : <PluginViewRenderer view={model.value} />;
  if (performance.now() - started > 16) throw new Error("host render strategy exceeded 16ms budget");
  return mode === "card" && children === undefined ? <div className="web-ui-card">{result}</div> : result;
}
class RendererBoundary extends Component<{ fallback: ReactNode; owner: string; sessionId: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) {
    disabledFor(this.props.sessionId).add(this.props.owner);
    reportUiFailure(`${this.props.sessionId}/${this.props.owner}`, `renderer disabled; builtin fallback: ${error.message}`);
  }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
function OverrideTree({ component, model, entries, fallback, userChoice, sessionId }: { component: WebUiComponent; model: UiModel; entries: OwnedContribution[]; fallback: ReactNode; userChoice?: string; sessionId: string }) {
  const resolution = resolveOverrides(component, entries, disabledFor(sessionId), userChoice);
  // Once every faulty override is disabled, keep the already validated builtin
  // outside the failing override/model path. Diagnostics notifications may
  // rerender this boundary before the producer has changed its model again.
  if (!resolution.replacement && !resolution.wrappers.length) return <span data-ui-component={component} data-ui-replacement="builtin">{fallback}</span>;
  const immutable = checkedModel(component, model);
  let rendered = resolution.hidden ? null : resolution.replacement ? strategy(immutable, resolution.replacement.contribution.strategy ?? "default") : fallback;
  // Highest priority wrapper is outermost. All wrappers receive only this validated model.
  for (const wrap of [...resolution.wrappers].reverse()) rendered = <div data-ui-wrapper={`${wrap.pluginId}/${wrap.contribution.id}`}>{strategy(immutable, wrap.contribution.strategy ?? "card", rendered)}</div>;
  return <span data-ui-component={component} data-ui-replacement={resolution.replacement ? `${resolution.replacement.pluginId}/${resolution.replacement.contribution.id}` : "builtin"}>{rendered}</span>;
}
export function UiComponent({ component, model, sessionId, fallback, userChoice, renderStrategy = "default" }: { component: WebUiComponent; model: UiModel; sessionId: string; fallback?: ReactNode; userChoice?: string; renderStrategy?: "default" | "compact" | "card" }) {
  const data = useWebUiState();
  const state = data.ui?.sessions[sessionId];
  const running = data.sessions[sessionId]?.running ?? state?.running ?? false;
  const entries = data.plugins.flatMap(plugin => normalizeContributions(plugin).filter(contribution => {
    if (!state || state.closed) return false;
    if (contribution.visibleWhen === "running" && !running) return false;
    if (contribution.visibleWhen === "idle" && running) return false;
    if (contribution.visibleWhen === "has-view" && !data.views[sessionId]?.[contribution.view ?? plugin.id]) return false;
    return true;
  }).map(contribution => ({ pluginId: plugin.id, contribution })));
  const builtin = fallback ?? strategy(model, renderStrategy);
  const active = resolveOverrides(component, entries, disabledFor(sessionId), userChoice);
  const owner = active.replacement ? `${active.replacement.pluginId}/${active.replacement.contribution.id}` : active.wrappers[0] ? `${active.wrappers[0].pluginId}/${active.wrappers[0].contribution.id}` : "builtin";
  return <RendererBoundary key={`${sessionId}/${component}/${owner}`} owner={owner} sessionId={sessionId} fallback={builtin}>
    <OverrideTree component={component} model={model} entries={entries} fallback={builtin} userChoice={userChoice} sessionId={sessionId} />
  </RendererBoundary>;
}
export function WorkingIndicator({ sessionId, fallbackText, active }: { sessionId?: string | null; fallbackText: string; active: boolean }) {
  const data = useWebUiState();
  if (!sessionId || !active) return null;
  const working = data.ui?.sessions[sessionId]?.working ?? { message: null, visible: true, frames: null, intervalMs: 80 };
  return <div data-web-ui-anchor="chat.working" className="web-ui-working-host">
    <UiComponent component="ui.working-indicator.v1" model={{ kind: "working", value: { ...working, message: working.message ?? fallbackText } }} sessionId={sessionId} />
  </div>;
}
