"use client";

import { useEffect, useState } from "react";
import { validatePlugin, type WebPluginDescriptor } from "@/lib/web-ui-descriptor";
import { validateWebUiEvent } from "@/lib/web-ui-event-models";
import { validateView, type WebView } from "@/lib/web-ui-views";
import type { WebUiSessionState, WebUiSnapshot } from "@/lib/web-ui-state-store";

export interface PluginSessionState { running: boolean; awaitingInput?: boolean }
export interface PluginDataState {
  plugins: readonly WebPluginDescriptor[];
  views: Record<string, Record<string, WebView>>;
  sessions: Record<string, PluginSessionState>;
  ui: WebUiSnapshot | null;
  loading: boolean;
}
let shared: PluginDataState = { plugins: [], views: {}, sessions: {}, ui: null, loading: true };
const subscribers = new Set<() => void>();
let connection: EventSource | null = null;
let inFlight: Promise<PluginDataState> | null = null;
let dirty = false;
let expectedRevision = 0;
let expectedEpoch = "";
const localDiagnostics: string[] = [];
export function reportUiFailure(owner: string, message: string): void {
  localDiagnostics.push(`${owner}: ${message}`);
  if (localDiagnostics.length > 100) localDiagnostics.shift();
}
export function getUiDiagnostics(): readonly string[] { return [...localDiagnostics]; }
function notify() { for (const listener of subscribers) listener(); }

/** Revalidate the server projection; no unvalidated working model reaches a renderer. */
export function validateUiSnapshot(raw: unknown): WebUiSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as WebUiSnapshot;
  if (input.version !== 1 || typeof input.epoch !== "string" || input.epoch.length > 160 || !Number.isSafeInteger(input.revision) || input.revision < 0 || !input.sessions || typeof input.sessions !== "object" || Object.keys(input.sessions).length > 128) return null;
  const sessions: Record<string, WebUiSessionState> = {};
  for (const [sessionId, s] of Object.entries(input.sessions)) {
    const check = (type: string, payload: unknown) => validateWebUiEvent({ version: 1, eventId: "snapshot", sessionId, source: "host", sourceKey: "snapshot", sequence: 1, timestamp: 0, type, payload });
    if (!s || !check("ui.working.changed", s.working).ok || !check("ui.session.lifecycle", { running: s.running, closed: s.closed, ...(s.project ? { project: s.project } : {}) }).ok || !Number.isSafeInteger(s.revision)) return null;
    if (!check("ui.title.changed", { text: s.title }).ok || !check("ui.editor.changed", { text: s.editor }).ok) return null;
    for (const [bag, type, payload] of [
      [s.statuses, "ui.status.changed", (key: string, text: unknown) => ({ key, text })],
      [s.widgets, "ui.widget.changed", (key: string, widget: unknown) => ({ key, ...(widget as object) })],
      [s.views, "ui.view.changed", (pluginId: string, view: unknown) => ({ pluginId, view })],
      [s.custom, "ui.custom.changed", (id: string, value: unknown) => ({ id, ...(value as object) })],
    ] as const) {
      if (!bag || typeof bag !== "object" || Object.keys(bag).length > 128) return null;
      for (const [key, value] of Object.entries(bag)) if (!check(type, payload(key, value)).ok) return null;
    }
    if (!s.layouts || Object.keys(s.layouts).length > 128) return null;
    for (const [key, placement] of Object.entries(s.layouts)) {
      const [pluginId, contributionId] = key.split("/");
      if (!check("ui.layout.changed", { pluginId, contributionId, placement }).ok) return null;
    }
    // Server already normalized text; reject instead of forwarding changed/control-bearing strings.
    const copy = structuredClone(s);
    const working = check("ui.working.changed", copy.working);
    if (working.ok && working.event.type === "ui.working.changed") copy.working = working.event.payload as WebUiSessionState["working"];
    sessions[sessionId] = copy;
  }
  return { version: 1, epoch: input.epoch, revision: input.revision, sessions,
    diagnostics: Array.isArray(input.diagnostics) ? input.diagnostics.slice(-100).filter(d => d && typeof d.message === "string" && typeof d.sourceKey === "string" && typeof d.sessionId === "string" && typeof d.timestamp === "number") : [],
    metrics: { accepted: Number(input.metrics?.accepted) || 0, rejected: Number(input.metrics?.rejected) || 0, coalesced: Number(input.metrics?.coalesced) || 0, dropped: Number(input.metrics?.dropped) || 0 },
  };
}
async function refresh(): Promise<PluginDataState> {
  if (inFlight) { dirty = true; return inFlight; }
  inFlight = (async () => {
    try {
      const response = await fetch("/api/plugins", { cache: "no-store" });
      if (!response.ok) return shared;
      const data = await response.json();
      const ui = validateUiSnapshot(data.ui);
      if (!ui || (shared.ui?.epoch === ui.epoch && ui.revision < shared.ui.revision)) return shared;
      const plugins: WebPluginDescriptor[] = [];
      for (const candidate of Array.isArray(data.plugins) ? data.plugins.slice(0, 128) : []) {
        const valid = validatePlugin(candidate, [candidate.extension]);
        if (valid.ok) plugins.push(valid.plugin);
        else reportUiFailure(String(candidate.id), valid.error);
      }
      const views: Record<string, Record<string, WebView>> = {};
      for (const [id, session] of Object.entries(ui.sessions)) views[id] = session.views;
      // Compatibility for older hosts/fixtures still publishing view-only snapshots.
      for (const [id, values] of Object.entries(data.views ?? {}).slice(0, 128)) {
        if (!/^[a-zA-Z0-9_:@.-]{1,160}$/.test(id) || id === "__proto__" || !values || typeof values !== "object") continue;
        views[id] ??= {};
        for (const [key, value] of Object.entries(values).slice(0, 128)) {
          const valid = validateView(value);
          if (valid.ok && /^[a-z][a-z0-9-]{0,63}$/.test(key)) views[id][key] = valid.view;
        }
      }
      const sessions: Record<string, PluginSessionState> = {};
      for (const id of Object.keys(views)) sessions[id] = { running: data.sessions?.[id]?.running === true, awaitingInput: data.sessions?.[id]?.awaitingInput === true };
      shared = { plugins, views, sessions, ui, loading: false };
      if (expectedEpoch === ui.epoch && ui.revision < expectedRevision) dirty = true;
    } catch (error) { reportUiFailure("transport", error instanceof Error ? error.message : "snapshot failed"); }
    finally {
      inFlight = null;
      notify();
      if (dirty && subscribers.size) { dirty = false; void refresh(); }
    }
    return shared;
  })();
  return inFlight;
}
function start() {
  connection = new EventSource("/api/plugins/events");
  connection.onopen = () => { void refresh(); };
  connection.onmessage = event => {
    try {
      const change = JSON.parse(event.data);
      if (change.type !== "changed" || !Number.isSafeInteger(change.revision)) return;
      expectedRevision = change.revision;
      expectedEpoch = typeof change.epoch === "string" ? change.epoch : "";
      if (shared.ui?.revision !== expectedRevision || shared.ui?.epoch !== expectedEpoch) void refresh();
    } catch { reportUiFailure("transport", "invalid change notification"); }
  };
  window.addEventListener("online", onOnline);
  void refresh();
}
function onOnline() { void refresh(); }
export function useWebUiState(): PluginDataState & { refetch: () => Promise<PluginDataState> } {
  const [, tick] = useState(0);
  useEffect(() => {
    const listener = () => tick(n => n + 1);
    subscribers.add(listener);
    if (subscribers.size === 1) start();
    return () => {
      subscribers.delete(listener);
      if (!subscribers.size) { connection?.close(); connection = null; window.removeEventListener("online", onOnline); }
    };
  }, []);
  return { ...shared, refetch: refresh };
}
