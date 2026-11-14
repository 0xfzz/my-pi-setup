// The per-session plugin bridge: subscribe a live session's event bus, relay
// declared actions back to the extension that owns them, and keep the small
// amount of session-scoped bookkeeping that needs.
//
// Everything here is per session and disposable: attaching returns a cleanup
// function, and a session that shuts down is forgotten so a long-lived server
// does not accumulate dead entries.

import { WEB_PLUGIN_VIEW_EVENT } from "../plugin-contracts/view.ts";
import { WEB_PLUGIN_ACTION_REQUEST_EVENT } from "../plugin-contracts/actions.ts";
import { WEB_PLUGIN_UI_SYNC_EVENT, WEB_UI_EVENT, type WebUiType } from "../plugin-contracts/ui-event-models.ts";
import { contributionsOf } from "../plugin-contracts/ui-contracts.ts";
import { getPluginDescriptor } from "./plugin-host.ts";
import { recordPluginView } from "./plugin-views.ts";
import { webUiStore } from "./ui-store.ts";

/** The subset of an event bus the bridge needs. */
export interface MinimalEventBus {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit?(channel: string, data: unknown): void;
}

export interface ActionAuditEntry {
  requestId: string;
  sessionId: string;
  pluginId: string;
  actionId: string;
  timestamp: number;
}

interface InFlightAction {
  requestId: string;
  expiresAt: number;
}

/**
 * A declared action stays locked for this long, per (session, plugin, action).
 * Long enough to swallow a double submit; short enough that a handler which
 * never reports back cannot lock the button for the rest of the session.
 */
export const IN_FLIGHT_ACTION_TTL_MS = 10_000;
const AUDIT_LOG_LIMIT = 500;

const knownSessions = new Set<string>();
const sessionBuses = new Map<string, MinimalEventBus>();
const inFlightActions = new Map<string, InFlightAction>();
const auditLog: ActionAuditEntry[] = [];

/** Test-only reset: the bridge keeps no state worth preserving across a suite. */
export function clearPluginSessionState(): void {
  knownSessions.clear();
  sessionBuses.clear();
  inFlightActions.clear();
  auditLog.length = 0;
}

/** The live session bus for `sessionId`, if that session has attached. */
export function sessionBus(sessionId: string): MinimalEventBus | undefined {
  return sessionBuses.get(sessionId);
}

/** Test-only: register a session bus with no pi wrapper behind it. */
export function registerSessionBusForTests(sessionId: string, bus: MinimalEventBus): void {
  knownSessions.add(sessionId);
  sessionBuses.set(sessionId, bus);
}

/**
 * Forget a session: its bus, its identity and any lock it held. `bus` narrows
 * the removal to that bus, so a newer attach for the same id survives an older
 * cleanup.
 */
export function detachSessionBus(sessionId: string, bus?: MinimalEventBus): void {
  if (bus !== undefined && sessionBuses.get(sessionId) !== bus) return;
  sessionBuses.delete(sessionId);
  knownSessions.delete(sessionId);
  releaseInFlightActions(sessionId);
}

export function isKnownSession(sessionId: string): boolean {
  if (typeof sessionId !== "string" || sessionId === "") return false;
  return knownSessions.has(sessionId) || sessionBuses.has(sessionId);
}

interface MinimalWrapper {
  sessionId: string;
  inner?: {
    resourceLoader?: { eventBus?: MinimalEventBus };
    _resourceLoader?: { eventBus?: MinimalEventBus };
  };
  onEvent?: (listener: (event: { type?: string }) => void) => () => void;
}

/** The session's event bus, whichever internal spelling this pi version uses. */
function eventBusOf(wrapper: MinimalWrapper): MinimalEventBus | undefined {
  const bus = wrapper.inner?.resourceLoader?.eventBus ?? wrapper.inner?._resourceLoader?.eventBus;
  return bus !== undefined && typeof bus.on === "function" ? bus : undefined;
}

/** A layout change must name a contribution the plugin actually declares. */
function isDeclaredLayoutTarget(payload: unknown): boolean {
  const target = payload as { pluginId?: string; contributionId?: string } | undefined;
  const plugin = getPluginDescriptor(target?.pluginId ?? "");
  if (plugin === undefined) return false;
  return contributionsOf(plugin).some((contribution) => contribution.id === target?.contributionId);
}

/** Event types the host owns: a producer may not forge them. */
function isReservedEvent(event: { source?: string; type?: WebUiType }): boolean {
  return event.source === "browser"
    || event.type === "ui.plugin.action-requested"
    || event.type === "ui.session.lifecycle";
}

interface BusUiEvent {
  type?: WebUiType;
  payload?: unknown;
  sourceKey?: string;
  source?: string;
  sessionId?: string;
}

/**
 * The bus subscription for one session. Session identity, source and ordering
 * are assigned by the host, never trusted from the payload.
 */
function subscribeUi(sessionId: string, bus: MinimalEventBus): () => void {
  return bus.on(WEB_UI_EVENT, (raw: unknown) => {
    if (raw === null || typeof raw !== "object") return;
    const event = raw as BusUiEvent;
    const sourceKey = typeof event.sourceKey === "string" ? event.sourceKey : "extension";
    if (event.sessionId !== undefined && event.sessionId !== sessionId) {
      webUiStore.reject(sessionId, sourceKey, "cross-session event rejected");
      return;
    }
    if (isReservedEvent(event)) {
      webUiStore.reject(sessionId, sourceKey, "reserved host event");
      return;
    }
    if (event.type === "ui.layout.changed" && !isDeclaredLayoutTarget(event.payload)) {
      webUiStore.reject(sessionId, sourceKey, "unknown plugin/contribution layout target");
      return;
    }
    if (event.type) webUiStore.publish(sessionId, event.type, event.payload, sourceKey);
  });
}

function subscribeViews(sessionId: string, bus: MinimalEventBus): () => void {
  return bus.on(WEB_PLUGIN_VIEW_EVENT, (payload: unknown) => {
    if (payload === null || typeof payload !== "object") return;
    if (!("pluginId" in payload) || !("view" in payload)) return;
    const { pluginId, view } = payload as { pluginId: string; view: unknown };
    recordPluginView(sessionId, pluginId, view);
  });
}

/**
 * Subscribe a session wrapper to its plugin view and UI events.
 *
 * The returned cleanup detaches the session (a later attach works again). A
 * `session_shutdown` event detaches it too, so a server that outlives many
 * sessions does not accumulate them.
 */
export function attachSessionPlugins(wrapper: unknown): () => void {
  if (wrapper === null || typeof wrapper !== "object") return () => {};
  const w = wrapper as MinimalWrapper;
  const sessionId = w.sessionId;
  if (typeof sessionId !== "string" || sessionId === "") return () => {};

  const bus = eventBusOf(w);
  if (bus === undefined) return () => {};
  // Re-attaching the same live session would double every event.
  if (sessionBuses.get(sessionId) === bus) return () => {};

  knownSessions.add(sessionId);
  sessionBuses.set(sessionId, bus);

  const unsubUi = subscribeUi(sessionId, bus);
  const unsubViews = subscribeViews(sessionId, bus);

  let detached = false;
  const detach = (): void => {
    if (detached) return;
    detached = true;
    unsubUi();
    unsubViews();
    unsubOnEvent?.();
    detachSessionBus(sessionId, bus);
  };

  const unsubOnEvent = typeof w.onEvent === "function"
    ? w.onEvent((event) => {
      if (event?.type === "session_shutdown") detach();
    })
    : undefined;

  // Subscribe-before-replay: ask the producers to re-emit their current values
  // now that this session's consumers are listening, so a consumer that
  // attached after the initial publication converges instead of staying empty.
  if (typeof bus.emit === "function") {
    try {
      bus.emit(WEB_PLUGIN_UI_SYNC_EVENT, {});
    } catch {
      // A bus that cannot replay just stays on the live stream.
    }
  }

  return detach;
}

export interface RelayResult {
  relayed: boolean;
}

/**
 * Hand one declared action to the extension that owns it.
 *
 * `confirm` travels only when present: the typed answer of an instant
 * ask-style action. A *declared* confirm is the byte-match check and never
 * reaches this point.
 */
export function relayActionRequest(
  sessionId: string,
  pluginId: string,
  actionId: string,
  requestId?: string,
  confirm?: string,
): RelayResult {
  if (!sessionId || !pluginId || !actionId) return { relayed: false };
  const bus = sessionBuses.get(sessionId);
  if (bus?.emit === undefined) return { relayed: false };

  const rid = requestId || crypto.randomUUID();
  const payload = { pluginId, actionId, requestId: rid, ...(confirm !== undefined ? { confirm } : {}) };
  try {
    webUiStore.publish(sessionId, "ui.plugin.action-requested", payload, pluginId, "host");
    bus.emit(WEB_PLUGIN_ACTION_REQUEST_EVENT, { ...payload, sessionId });
    return { relayed: true };
  } catch {
    return { relayed: false };
  }
}

function inFlightKey(sessionId: string, pluginId: string, actionId: string): string {
  return `${sessionId}\u0000${pluginId}\u0000${actionId}`;
}

/** One declared action submission: what to lock, and for how long. */
export interface InFlightClaim {
  sessionId: string;
  pluginId: string;
  actionId: string;
  requestId: string;
  ttlMs?: number;
}

/**
 * Claim the in-flight slot for a declared action. False while an earlier
 * submission of the *same* action is still held; a different action in the
 * same session is never blocked.
 */
export function checkAndSetInFlightAction(claim: InFlightClaim): boolean {
  const now = Date.now();
  const key = inFlightKey(claim.sessionId, claim.pluginId, claim.actionId);
  const current = inFlightActions.get(key);
  if (current !== undefined && current.expiresAt > now) return false;
  const ttlMs = claim.ttlMs ?? IN_FLIGHT_ACTION_TTL_MS;
  inFlightActions.set(key, { requestId: claim.requestId, expiresAt: now + ttlMs });
  return true;
}

/** Release every lock a session holds — a finished turn means nothing is pending. */
export function releaseInFlightActions(sessionId: string): void {
  for (const key of inFlightActions.keys()) {
    if (key.startsWith(`${sessionId}\u0000`)) inFlightActions.delete(key);
  }
}

export function recordActionAudit(entry: ActionAuditEntry): void {
  auditLog.push(entry);
  if (auditLog.length > AUDIT_LOG_LIMIT) auditLog.splice(0, auditLog.length - AUDIT_LOG_LIMIT);
}

export function getActionAuditLog(): readonly ActionAuditEntry[] {
  return auditLog;
}
