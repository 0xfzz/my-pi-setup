import { validateWebUiEvent, type WebUiEvent, type WebUiType, type WorkingModel, type WebNotification } from "./ui-event-models.ts";
import type { WebPluginPlacement } from "./ui-contracts.ts";
import type { WebView } from "./view.ts";

export interface WebUiSessionState {
  revision: number; project?: string; running: boolean; closed: boolean;
  working: WorkingModel;
  statuses: Record<string, string>;
  widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
  custom: Record<string, { method: string; lines: string[] | null }>;
  title: string; editor: string;
  views: Record<string, WebView>;
  layouts: Record<string, WebPluginPlacement>;
  /** Transient toasts, newest last, bounded; the client expires them. */
  notifications: WebNotification[];
}
export interface WebUiDiagnostic { sessionId: string; sourceKey: string; message: string; timestamp: number }
export interface WebUiSnapshot {
  version: 1; epoch: string; revision: number;
  sessions: Record<string, WebUiSessionState>;
  diagnostics: WebUiDiagnostic[];
  metrics: { accepted: number; rejected: number; coalesced: number; dropped: number };
}
interface StoredEvent { revision: number; event: WebUiEvent }
function freshSession(): WebUiSessionState {
  return { revision: 0, running: false, closed: false, working: { message: null, visible: true, frames: null, intervalMs: 80 }, statuses: {}, widgets: {}, custom: {}, title: "", editor: "", views: {}, layouts: {}, notifications: [] };
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); for (const v of Object.values(value)) deepFreeze(v); }
  return value;
}
/** State is synchronous, delivery asynchronous. Producers never call browser listeners. */
export class WebUiStore {
  private state: WebUiSnapshot = { version: 1, epoch: crypto.randomUUID(), revision: 0, sessions: {}, diagnostics: [], metrics: { accepted: 0, rejected: 0, coalesced: 0, dropped: 0 } };
  private journal: StoredEvent[] = [];
  private lastSequence = new Map<string, number>();
  private rates = new Map<string, { at: number; count: number }>();
  private sequence = 0;
  private scheduled = false;
  private listeners = new Set<(revision: number) => void>();
  private retentionMs: number;
  private maxEvents: number;
  constructor(options: { retentionMs?: number; maxEvents?: number } = {}) { this.retentionMs = options.retentionMs ?? 300000; this.maxEvents = options.maxEvents ?? 512; }
  publish(sessionId: string, type: WebUiType, payload: unknown, sourceKey = "ctx.ui", source: "extension" | "host" = "extension"): boolean {
    return this.accept({ version: 1, eventId: crypto.randomUUID(), sessionId, source, sourceKey, type, timestamp: Date.now(), sequence: ++this.sequence, payload });
  }
  reject(sessionId: string, sourceKey: string, message: string): false {
    this.state.metrics.rejected++;
    this.state.diagnostics.push({ sessionId: sessionId.slice(0, 160), sourceKey: sourceKey.slice(0, 160), message: message.slice(0, 400), timestamp: Date.now() });
    this.state.diagnostics = this.state.diagnostics.slice(-100);
    this.state.revision++;
    this.notify();
    return false;
  }
  accept(input: unknown): boolean {
    const validation = validateWebUiEvent(input);
    const raw = input as Partial<WebUiEvent> | null;
    if (!validation.ok) return this.reject(String(raw?.sessionId ?? "unknown"), String(raw?.sourceKey ?? "unknown"), validation.error);
    const e = validation.event;
    if (e.source === "browser") return this.reject(e.sessionId, e.sourceKey, "browser cannot publish extension events");
    // The source key identifies the producer; component field keys are separate so
    // independent working patches cannot supersede one another in a coalesced batch.
    const field = e.type === "ui.working.changed" ? Object.keys(e.payload).sort().join(",") : "";
    const streams = (e.type === "ui.working.changed" ? Object.keys(e.payload) : [field]).map(part => `${e.sessionId}/${e.type}/${e.sourceKey}/${part}`);
    if (streams.some(stream => (this.lastSequence.get(stream) ?? 0) >= e.sequence)) return this.reject(e.sessionId, e.sourceKey, "stale or duplicate event");
    if (streams.some(stream => !this.lastSequence.has(stream)) && this.lastSequence.size + streams.length > 8192) return this.reject(e.sessionId, e.sourceKey, "event stream capacity reached");
    const now = Date.now();
    const rateKey = `${e.sessionId}/${e.sourceKey}`;
    const rate = this.rates.get(rateKey);
    const lifecycle = e.type === "ui.session.lifecycle" || e.type === "ui.plugin.action-requested";
    if (!lifecycle && rate && now - rate.at < 1000 && rate.count >= 120) { this.state.metrics.dropped++; return this.reject(e.sessionId, e.sourceKey, "event frequency exceeds 120/s"); }
    if (rate && now - rate.at < 1000) rate.count++;
    else this.rates.set(rateKey, { at: now, count: 1 });
    if (!Object.hasOwn(this.state.sessions, e.sessionId) && Object.keys(this.state.sessions).length >= 128) return this.reject(e.sessionId, e.sourceKey, "session state capacity reached");
    const s = this.state.sessions[e.sessionId] ?? freshSession();
    // Bound keyed state as well as the journal; floods of unique keys cannot grow memory.
    const bag = e.type === "ui.status.changed" ? s.statuses : e.type === "ui.widget.changed" ? s.widgets : e.type === "ui.custom.changed" ? s.custom : e.type === "ui.view.changed" ? s.views : e.type === "ui.layout.changed" ? s.layouts : undefined;
    const bagKey = "key" in e.payload ? e.payload.key : "id" in e.payload ? e.payload.id : "pluginId" in e.payload ? e.type === "ui.layout.changed" ? `${e.payload.pluginId}/${e.payload.contributionId}` : e.payload.pluginId : "";
    if (bag && !Object.hasOwn(bag, bagKey) && Object.keys(bag).length >= 128) return this.reject(e.sessionId, e.sourceKey, "component state capacity reached");
    for (const stream of streams) this.lastSequence.set(stream, e.sequence);
    if (this.rates.size > 4096) this.rates.delete(this.rates.keys().next().value!);
    this.state.revision++;
    s.revision = this.state.revision;
    switch (e.type) {
      case "ui.working.changed": s.working = { ...s.working, ...e.payload }; break;
      case "ui.status.changed": if (e.payload.text === null) delete s.statuses[e.payload.key]; else s.statuses[e.payload.key] = e.payload.text; break;
      case "ui.widget.changed": if (e.payload.lines === null) delete s.widgets[e.payload.key]; else s.widgets[e.payload.key] = { lines: e.payload.lines, placement: e.payload.placement }; break;
      case "ui.custom.changed": if (e.payload.lines === null) delete s.custom[e.payload.id]; else s.custom[e.payload.id] = { method: e.payload.method, lines: e.payload.lines }; break;
      case "ui.title.changed": s.title = e.payload.text; break;
      case "ui.editor.changed": s.editor = e.payload.text; break;
      case "ui.view.changed": s.views[e.payload.pluginId] = e.payload.view; break;
      case "ui.layout.changed": s.layouts[`${e.payload.pluginId}/${e.payload.contributionId}`] = e.payload.placement; break;
      case "ui.session.lifecycle": s.running = e.payload.running; s.closed = e.payload.closed ?? false; if (e.payload.project !== undefined) s.project = e.payload.project; break;
      case "ui.plugin.action-requested": break;
      case "ui.notify": {
        // Newest last; identical consecutive messages replace their twin so
        // a looping producer cannot stack duplicates.
        const last = s.notifications[s.notifications.length - 1];
        if (last !== undefined && last.message === e.payload.message && last.level === e.payload.level) {
          s.notifications[s.notifications.length - 1] = { ...last, timestamp: e.timestamp };
        } else {
          s.notifications.push({
            id: e.eventId,
            message: e.payload.message,
            level: e.payload.level,
            timestamp: e.timestamp,
          });
        }
        if (s.notifications.length > 8) s.notifications.splice(0, s.notifications.length - 8);
        break;
      }
    }
    this.state.sessions[e.sessionId] = s;
    this.state.metrics.accepted++;
    this.journal = this.journal.filter(item => now - item.event.timestamp <= this.retentionMs);
    if (!lifecycle) {
      const previous = this.journal.findIndex(item => item.event.sessionId === e.sessionId && item.event.type === e.type && item.event.sourceKey === e.sourceKey && (e.type !== "ui.working.changed" || Object.keys(item.event.payload).sort().join(",") === field));
      if (previous >= 0) { this.journal.splice(previous, 1); this.state.metrics.coalesced++; }
    }
    this.journal.push({ revision: this.state.revision, event: e });
    if (this.journal.length > this.maxEvents) this.journal.splice(0, this.journal.length - this.maxEvents);
    this.notify();
    return true;
  }
  snapshot(): WebUiSnapshot { return deepFreeze(structuredClone(this.state)); }
  /** Coalesced/expired cursors recover by full snapshot, never an incomplete replay. */
  replay(cursor: number, epoch = this.state.epoch): { snapshot?: WebUiSnapshot; events: StoredEvent[]; revision: number } {
    const events = this.journal.filter(item => item.revision > cursor);
    const complete = epoch === this.state.epoch && cursor >= 0 && cursor <= this.state.revision && events.length === this.state.revision - cursor;
    return complete ? { events: structuredClone(events), revision: this.state.revision } : { snapshot: this.snapshot(), events: [], revision: this.state.revision };
  }
  subscribe(listener: (revision: number) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  clear(): void {
    const revision = this.state.revision + 1;
    this.state = { ...this.state, revision, sessions: {}, diagnostics: [], metrics: { accepted: 0, rejected: 0, coalesced: 0, dropped: 0 } };
    this.journal = []; this.lastSequence.clear(); this.rates.clear(); this.notify();
  }
  private notify(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; for (const listener of this.listeners) { try { listener(this.state.revision); } catch { /* listener failure cannot interrupt a producer */ } } });
  }
}
