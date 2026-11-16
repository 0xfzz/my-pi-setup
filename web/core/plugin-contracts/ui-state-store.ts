/**
 * The unified per-session UI state store.
 *
 * Producers (pi extensions, the host) publish validated `ui.*` events; the SSE
 * stream reads snapshots. State is synchronous and delivery is asynchronous:
 * a listener is notified once per microtask, never inside `publish`, so a
 * producer can never be blocked — or re-entered — by a consumer.
 *
 * Every bound here exists so one misbehaving producer cannot exhaust the
 * server: event frequency per stream, sessions per process, keys per component
 * bag, journal length and retention.
 */
import {
  validateWebUiEvent,
  type WebNotification,
  type WebUiEvent,
  type WebUiType,
  type WorkingModel,
} from "./ui-event-models.ts";
import type { WebPluginPlacement } from "./ui-contracts.ts";
import type { WebView } from "./view.ts";

export interface WebUiSessionState {
  revision: number;
  project?: string;
  running: boolean;
  closed: boolean;
  working: WorkingModel;
  statuses: Record<string, string>;
  widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
  custom: Record<string, { method: string; lines: string[] | null }>;
  title: string;
  editor: string;
  views: Record<string, WebView>;
  layouts: Record<string, WebPluginPlacement>;
  /** Transient toasts, newest last, bounded; the client expires them. */
  notifications: WebNotification[];
}

export interface WebUiDiagnostic {
  sessionId: string;
  sourceKey: string;
  message: string;
  timestamp: number;
}

export interface WebUiSnapshot {
  version: 1;
  epoch: string;
  revision: number;
  sessions: Record<string, WebUiSessionState>;
  diagnostics: WebUiDiagnostic[];
  metrics: { accepted: number; rejected: number; coalesced: number; dropped: number };
}

interface StoredEvent {
  revision: number;
  event: WebUiEvent;
}

/** Producer rate ceiling: events per window, per session and source key. */
const RATE_WINDOW_MS = 1_000;
const RATE_LIMIT = 120;
/** Bounds on the state one process will hold. */
const SESSION_CAPACITY = 128;
const COMPONENT_KEY_CAPACITY = 128;
const STREAM_CAPACITY = 8_192;
const RATE_KEY_CAPACITY = 4_096;
/** Bounds on what is remembered for replay. */
const DEFAULT_RETENTION_MS = 300_000;
const DEFAULT_MAX_EVENTS = 512;
const DIAGNOSTIC_LIMIT = 100;
const NOTIFICATION_LIMIT = 8;
/** Session-lifecycle events are neither rate-limited nor coalesced. */
const LIFECYCLE_TYPES: ReadonlySet<WebUiType> = new Set<WebUiType>([
  "ui.session.lifecycle",
  "ui.plugin.action-requested",
]);
function freshSession(): WebUiSessionState {
  return {
    revision: 0,
    running: false,
    closed: false,
    working: { message: null, visible: true, frames: null, intervalMs: 80, messageSegments: null, frameColors: null, messageFrames: null, messageIntervalMs: null },
    statuses: {},
    widgets: {},
    custom: {},
    title: "",
    editor: "",
    views: {},
    layouts: {},
    notifications: [],
  };
}

/** Snapshots are immutable: a consumer cannot mutate the store's state. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function isLifecycle(type: WebUiType): boolean {
  return LIFECYCLE_TYPES.has(type);
}

/**
 * The ordering streams an event belongs to. A working update carries several
 * independent fields, so each field gets its own stream and one field cannot
 * supersede another.
 */
function streamParts(event: WebUiEvent): string[] {
  return event.type === "ui.working.changed" ? Object.keys(event.payload) : [""];
}

/**
 * The identity two events share when they supersede each other. Working fields
 * are sorted, so `{message}` and `{message}` coalesce whatever the key order.
 */
function coalesceField(event: WebUiEvent): string {
  return event.type === "ui.working.changed" ? Object.keys(event.payload).sort().join(",") : "";
}

function componentBag(session: WebUiSessionState, type: WebUiType): Record<string, unknown> | undefined {
  switch (type) {
    case "ui.status.changed": return session.statuses;
    case "ui.widget.changed": return session.widgets;
    case "ui.custom.changed": return session.custom;
    case "ui.view.changed": return session.views;
    case "ui.layout.changed": return session.layouts;
    default: return undefined;
  }
}

/** The key an event writes into its component bag. */
function componentKey(event: WebUiEvent): string {
  switch (event.type) {
    case "ui.status.changed":
    case "ui.widget.changed": return event.payload.key;
    case "ui.custom.changed": return event.payload.id;
    case "ui.view.changed": return event.payload.pluginId;
    case "ui.layout.changed": return `${event.payload.pluginId}/${event.payload.contributionId}`;
    default: return "";
  }
}

function nextNotifications(current: WebNotification[], event: WebUiEvent): WebNotification[] {
  if (event.type !== "ui.notify") return current;
  const last = current[current.length - 1];
  const { message, level } = event.payload;
  // An identical repeat refreshes its twin instead of stacking, so a looping
  // producer cannot fill the screen.
  if (last !== undefined && last.message === message && last.level === level) {
    return [...current.slice(0, -1), { ...last, timestamp: event.timestamp }];
  }
  return [...current, { id: event.eventId, message, level, timestamp: event.timestamp }].slice(-NOTIFICATION_LIMIT);
}

export class WebUiStore {
  private state: WebUiSnapshot = {
    version: 1,
    epoch: crypto.randomUUID(),
    revision: 0,
    sessions: {},
    diagnostics: [],
    metrics: { accepted: 0, rejected: 0, coalesced: 0, dropped: 0 },
  };
  private journal: StoredEvent[] = [];
  private readonly lastSequence = new Map<string, number>();
  private readonly rates = new Map<string, { at: number; count: number }>();
  private sequence = 0;
  private scheduled = false;
  private readonly listeners = new Set<(revision: number) => void>();
  private readonly retentionMs: number;
  private readonly maxEvents: number;

  constructor(options: { retentionMs?: number; maxEvents?: number } = {}) {
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  }

  /** Publish one event. The caller supplies session, type and payload; the host owns ordering. */
  publish(
    sessionId: string,
    type: WebUiType,
    payload: unknown,
    sourceKey = "ctx.ui",
    source: "extension" | "host" = "extension",
  ): boolean {
    return this.accept({
      version: 1,
      eventId: crypto.randomUUID(),
      sessionId,
      source,
      sourceKey,
      type,
      timestamp: Date.now(),
      sequence: ++this.sequence,
      payload,
    });
  }

  /** Record a refusal: it is visible to the operator and never reaches the state. */
  reject(sessionId: string, sourceKey: string, message: string): false {
    this.state.metrics.rejected++;
    this.state.diagnostics = [...this.state.diagnostics, {
      sessionId: sessionId.slice(0, 160),
      sourceKey: sourceKey.slice(0, 160),
      message: message.slice(0, 400),
      timestamp: Date.now(),
    }].slice(-DIAGNOSTIC_LIMIT);
    this.state.revision++;
    this.notify();
    return false;
  }

  /** Validate and admit one raw event. */
  accept(input: unknown): boolean {
    const validation = validateWebUiEvent(input);
    const envelope = input as Partial<WebUiEvent> | null;
    if (!validation.ok) {
      return this.reject(String(envelope?.sessionId ?? "unknown"), String(envelope?.sourceKey ?? "unknown"), validation.error);
    }
    const event = validation.event;
    if (event.source === "browser") {
      return this.reject(event.sessionId, event.sourceKey, "browser cannot publish extension events");
    }
    const refusal = this.admissionFailure(event, streamParts(event));
    if (refusal !== undefined) return this.reject(event.sessionId, event.sourceKey, refusal);
    this.commit(event);
    return true;
  }

  /** Why this event must be refused, or undefined when it may be applied. */
  private admissionFailure(event: WebUiEvent, parts: readonly string[]): string | undefined {
    const streams = parts.map((part) => this.streamKey(event, part));
    if (streams.some((stream) => (this.lastSequence.get(stream) ?? 0) >= event.sequence)) {
      return "stale or duplicate event";
    }
    const newStreams = streams.filter((stream) => !this.lastSequence.has(stream));
    if (newStreams.length > 0 && this.lastSequence.size + newStreams.length > STREAM_CAPACITY) {
      return "event stream capacity reached";
    }
    if (this.rateLimited(event)) return `event frequency exceeds ${RATE_LIMIT}/s`;
    if (this.exceedsSessionCapacity(event.sessionId)) return "session state capacity reached";
    if (this.exceedsComponentCapacity(event)) return "component state capacity reached";
    return undefined;
  }

  private streamKey(event: WebUiEvent, part: string): string {
    return `${event.sessionId}/${event.type}/${event.sourceKey}/${part}`;
  }

  /**
   * Count this event against its producer's rate and say whether it is over the
   * ceiling. The counter advances even when a later check refuses the event, so
   * a producer cannot evade the limit by also tripping another bound.
   */
  private rateLimited(event: WebUiEvent): boolean {
    if (isLifecycle(event.type)) return false;
    const now = Date.now();
    const key = `${event.sessionId}/${event.sourceKey}`;
    const rate = this.rates.get(key);
    const withinWindow = rate !== undefined && now - rate.at < RATE_WINDOW_MS;
    if (withinWindow && rate.count >= RATE_LIMIT) {
      this.state.metrics.dropped++;
      return true;
    }
    if (withinWindow) rate.count++;
    else this.rates.set(key, { at: now, count: 1 });
    if (this.rates.size > RATE_KEY_CAPACITY) {
      const oldest = this.rates.keys().next();
      if (!oldest.done) this.rates.delete(oldest.value);
    }
    return false;
  }

  private exceedsSessionCapacity(sessionId: string): boolean {
    if (Object.hasOwn(this.state.sessions, sessionId)) return false;
    return Object.keys(this.state.sessions).length >= SESSION_CAPACITY;
  }

  private exceedsComponentCapacity(event: WebUiEvent): boolean {
    const session = this.state.sessions[event.sessionId];
    if (session === undefined) return false;
    const bag = componentBag(session, event.type);
    if (bag === undefined) return false;
    const key = componentKey(event);
    return !Object.hasOwn(bag, key) && Object.keys(bag).length >= COMPONENT_KEY_CAPACITY;
  }

  /** Apply an admitted event: state, journal, then one coalesced notification. */
  private commit(event: WebUiEvent): void {
    for (const part of streamParts(event)) {
      this.lastSequence.set(this.streamKey(event, part), event.sequence);
    }
    this.state.revision++;
    const session = this.state.sessions[event.sessionId] ?? freshSession();
    this.applyEvent(session, event);
    session.revision = this.state.revision;
    this.state.sessions[event.sessionId] = session;
    this.state.metrics.accepted++;
    this.journalize(event);
    this.notify();
  }

  /** The state change one event type makes. */
  private applyEvent(session: WebUiSessionState, event: WebUiEvent): void {
    switch (event.type) {
      case "ui.working.changed":
        session.working = { ...session.working, ...event.payload };
        return;
      case "ui.status.changed":
        if (event.payload.text === null) delete session.statuses[event.payload.key];
        else session.statuses[event.payload.key] = event.payload.text;
        return;
      case "ui.widget.changed":
        if (event.payload.lines === null) delete session.widgets[event.payload.key];
        else session.widgets[event.payload.key] = { lines: event.payload.lines, placement: event.payload.placement };
        return;
      case "ui.custom.changed":
        if (event.payload.lines === null) delete session.custom[event.payload.id];
        else session.custom[event.payload.id] = { method: event.payload.method, lines: event.payload.lines };
        return;
      case "ui.title.changed":
        session.title = event.payload.text;
        return;
      case "ui.editor.changed":
        session.editor = event.payload.text;
        return;
      case "ui.view.changed":
        session.views[event.payload.pluginId] = event.payload.view;
        return;
      case "ui.layout.changed":
        session.layouts[`${event.payload.pluginId}/${event.payload.contributionId}`] = event.payload.placement;
        return;
      case "ui.session.lifecycle":
        session.running = event.payload.running;
        session.closed = event.payload.closed ?? false;
        if (event.payload.project !== undefined) session.project = event.payload.project;
        return;
      case "ui.plugin.action-requested":
        // A relay marker: it advances the revision, it changes no state.
        return;
      case "ui.notify":
        session.notifications = nextNotifications(session.notifications, event);
        return;
    }
  }

  /**
   * Keep the bounded replay journal: drop what aged out, let a newer event
   * replace its twin, then cap the length.
   */
  private journalize(event: WebUiEvent): void {
    const now = Date.now();
    this.journal = this.journal.filter((item) => now - item.event.timestamp <= this.retentionMs);
    if (!isLifecycle(event.type)) this.coalesce(event);
    this.journal.push({ revision: this.state.revision, event });
    if (this.journal.length > this.maxEvents) {
      this.journal = this.journal.slice(this.journal.length - this.maxEvents);
    }
  }

  /** Remove the event this one supersedes, if the journal still holds it. */
  private coalesce(event: WebUiEvent): void {
    const field = coalesceField(event);
    const index = this.journal.findIndex((item) => item.event.sessionId === event.sessionId
      && item.event.type === event.type
      && item.event.sourceKey === event.sourceKey
      && coalesceField(item.event) === field);
    if (index < 0) return;
    this.journal.splice(index, 1);
    this.state.metrics.coalesced++;
  }

  snapshot(): WebUiSnapshot {
    return deepFreeze(structuredClone(this.state));
  }

  /**
   * The durable per-session plugin view values, excluding transient dialogs.
   * This is the "session stores the value" projection: the UI only displays
   * what is here. Backed up to disk by the host and restored on boot.
   */
  persistableViews(): Record<string, Record<string, WebView>> {
    const out: Record<string, Record<string, WebView>> = {};
    for (const [sessionId, session] of Object.entries(this.state.sessions)) {
      const views: Record<string, WebView> = {};
      for (const [pluginId, view] of Object.entries(session.views)) {
        if (view.type !== "dialog") views[pluginId] = view;
      }
      if (Object.keys(views).length > 0) out[sessionId] = views;
    }
    return out;
  }

  /** Recover the durable view values a previous process wrote down. */
  restoreViews(viewsBySession: Record<string, Record<string, WebView>>): void {
    if (!viewsBySession || typeof viewsBySession !== "object") return;
    for (const [sessionId, views] of Object.entries(viewsBySession)) {
      if (!views || typeof views !== "object") continue;
      const session = this.state.sessions[sessionId] ?? freshSession();
      for (const [pluginId, view] of Object.entries(views)) {
        if (view && typeof view === "object" && view.type !== "dialog") session.views[pluginId] = view;
      }
      this.state.sessions[sessionId] = session;
    }
    this.state.revision++;
    this.notify();
  }

  /**
   * Events after `cursor`. A coalesced, expired or foreign-process cursor
   * recovers by full snapshot, never by an incomplete replay.
   */
  replay(cursor: number, epoch: string = this.state.epoch): { snapshot?: WebUiSnapshot; events: StoredEvent[]; revision: number } {
    const events = this.journal.filter((item) => item.revision > cursor);
    const complete = epoch === this.state.epoch
      && cursor >= 0
      && cursor <= this.state.revision
      && events.length === this.state.revision - cursor;
    return complete
      ? { events: structuredClone(events), revision: this.state.revision }
      : { snapshot: this.snapshot(), events: [], revision: this.state.revision };
  }

  subscribe(listener: (revision: number) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      sessions: {},
      diagnostics: [],
      metrics: { accepted: 0, rejected: 0, coalesced: 0, dropped: 0 },
    };
    this.journal = [];
    this.lastSequence.clear();
    this.rates.clear();
    this.notify();
  }

  /** One notification per microtask, whatever the burst size. */
  private notify(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      for (const listener of this.listeners) {
        try {
          listener(this.state.revision);
        } catch {
          // A listener failure cannot interrupt a producer.
        }
      }
    });
  }
}

