// First-party web plugin host: the store, session-bus attach, action relay
// and audit that connect the root repo's plugin contract and kernel to this
// server. Ported from the vendored app's web-plugins-host.ts with direct
// imports — the contract modules (view, actions, descriptor, ui state,
// kernel) live in the root repo and are shared, not copied.

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { WEB_PLUGINS } from "../../web-plugins/index.ts";
import {
  WEB_PLUGIN_VIEW_EVENT,
  validateView,
  type KvWebView,
  type ListWebView,
  type StatusWebView,
  type ValidateViewResult,
  type WebView,
} from "../../lib/web-plugins/view.ts";
import { WEB_PLUGIN_ACTION_REQUEST_EVENT, type ActionDescriptor } from "../../lib/web-plugins/actions.ts";
import type { WebPluginDescriptor } from "../../lib/web-plugins/descriptor.ts";
import { WebUiStore, type WebUiSnapshot, type WebUiSessionState } from "../../lib/web-plugins/ui-state-store.ts";
import { WEB_UI_EVENT, extensionUiUpdate, type WebUiType } from "../../lib/web-plugins/ui-event-models.ts";
import { normalizeContributions } from "../../lib/web-plugins/ui-contracts.ts";
import { createPluginHost, type PluginHost } from "../../lib/web-plugins/kernel/host.ts";

const uiGlobal = globalThis as Record<PropertyKey, unknown>;
const uiStoreKey = Symbol.for("pi-web:unified-ui:v1");
export const webUiStore = (uiGlobal[uiStoreKey] ??= new WebUiStore()) as WebUiStore;

/** Lifecycle and extension-UI events from the agent stream, projected into the unified UI state. */
export function recordExtensionUi(
  sessionId: string,
  event: Record<string, unknown>,
): void {
  if (event.type === "extension_ui_request") {
    const update = extensionUiUpdate(event);
    if (update) webUiStore.publish(sessionId, update.type, update.payload, update.sourceKey);
  } else if (event.type === "extension_ui_closed") {
    webUiStore.publish(sessionId, "ui.custom.changed", { id: event.id, method: "closed", lines: null }, String(event.id));
  } else if (["agent_start", "agent_settled", "session_shutdown"].includes(String(event.type))) {
    webUiStore.publish(
      sessionId,
      "ui.session.lifecycle",
      { running: event.type === "agent_start", closed: event.type === "session_shutdown" },
      "lifecycle",
      "host",
    );
  }
}

export function recordWorkingUi(sessionId: string, payload: unknown): boolean {
  return webUiStore.publish(sessionId, "ui.working.changed", payload, "ctx.ui.working");
}

// ---------------------------------------------------------------------------
// Plugin kernel: discovery of user/project plugins, enable state, hooks.
// One host per process; the Symbol.for guard keeps double evaluation safe.

const webPluginsDir = fileURLToPath(new URL("../../web-plugins", import.meta.url));

// Test processes get their own state file so a suite never writes into a real home directory.
function defaultPluginStatePath(): string {
  return process.env.NODE_TEST_CONTEXT
    ? join(tmpdir(), "pi-web-plugin-state", `${process.pid}.json`)
    : join(homedir(), ".pi", "agent", "web-plugins.json");
}

const jiti = createJiti(import.meta.url);

interface DiscoveredPluginLike {
  dir: string;
  manifest: { main?: { server?: string } };
}

const pluginHostKey = Symbol.for("pi-web:plugin-host:v1");
export const pluginHost: PluginHost<WebPluginDescriptor> = (uiGlobal[pluginHostKey] ??= createPluginHost<WebPluginDescriptor>({
  descriptors: WEB_PLUGINS,
  descriptorDir: webPluginsDir,
  statePath: process.env.PI_WEB_PLUGIN_STATE ?? defaultPluginStatePath(),
  roots: {
    user: join(homedir(), ".pi", "agent", "web-plugins"),
    project: join(process.cwd(), ".pi", "web-plugins"),
  },
  env: process.env,
  // Only plugins with a server entry reach the loader; descriptors are declarative.
  loader: (plugin: DiscoveredPluginLike) => {
    const entry = plugin.manifest.main?.server;
    if (!entry) return {};
    const mod = jiti(join(plugin.dir, entry)) as { default?: object };
    return (mod.default ?? mod) as object;
  },
})) as PluginHost<WebPluginDescriptor>;

pluginHost.ready.catch((error: unknown) => {
  console.error("[pi-web-minimal] web plugin host failed to boot:", error);
});

/** Read registered descriptors (enabled, unquarantined). */
export function getRegisteredPlugins(): readonly WebPluginDescriptor[] {
  return pluginHost.visible();
}

/** Undefined while the plugin is switched off, quarantined, or hidden. */
export function getPluginDescriptor(id: string): WebPluginDescriptor | undefined {
  return pluginHost.descriptor(id);
}

export const WEB_PLUGINS_VISIBLE_EVENT_BUS = WEB_UI_EVENT;

// ---------------------------------------------------------------------------
// Plugin views store: per-session views validated through the contract,
// backed by the unified UI store so the SSE merge sees every change.

export interface ActionAuditEntry {
  requestId: string;
  sessionId: string;
  pluginId: string;
  actionId: string;
  timestamp: number;
}

export interface InFlightAction {
  requestId: string;
  expiresAt: number;
}

export interface MinimalEventBus {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit?(channel: string, data: unknown): void;
}

export interface WebPluginsState {
  version: 1;
  revision: number;
  views: Map<string, Map<string, WebView>>;
  latestByPlugin: Map<string, { sessionId: string; view: WebView; timestamp: number }>;
  sessionBuses: Map<string, MinimalEventBus>;
  knownSessions: Set<string>;
  auditLog: ActionAuditEntry[];
  inFlightActions: Map<string, InFlightAction>;
  recordView(sessionId: string, pluginId: string, view: unknown): boolean;
  getView(sessionId: string, pluginId: string): WebView | undefined;
  getLatestView(pluginId: string): WebView | undefined;
  getAllViews(): Record<string, Record<string, WebView>>;
  getRevision(): number;
  subscribeChanges(cb: (revision: number) => void): () => void;
  clear(): void;
}

const WEB_PLUGINS_STORE_KEY = "@pi-workflow-extensions/web-plugins-store/v1";

function createStore(): WebPluginsState {
  const views = new Map<string, Map<string, WebView>>();
  const latestByPlugin = new Map<string, { sessionId: string; view: WebView; timestamp: number }>();
  const sessionBuses = new Map<string, MinimalEventBus>();
  const knownSessions = new Set<string>();
  const auditLog: ActionAuditEntry[] = [];
  const inFlightActions = new Map<string, InFlightAction>();

  const state: WebPluginsState = {
    version: 1,
    revision: 0,
    views,
    latestByPlugin,
    sessionBuses,
    knownSessions,
    auditLog,
    inFlightActions,

    recordView(sessionId: string, pluginId: string, rawView: unknown): boolean {
      if (!sessionId || typeof sessionId !== "string") return false;
      if (!pluginId || typeof pluginId !== "string") return false;

      const validation = validateView(rawView);
      if (!validation.ok) return false;

      if (!webUiStore.publish(sessionId, "ui.view.changed", { pluginId, view: validation.view }, pluginId)) {
        return false;
      }
      // The store freezes and clones; read the safe view back out of the snapshot.
      const safeView = webUiStore.snapshot().sessions[sessionId]?.views[pluginId];
      if (!safeView) return false;
      let sessionMap = views.get(sessionId);
      if (!sessionMap) {
        sessionMap = new Map();
        views.set(sessionId, sessionMap);
      }
      sessionMap.set(pluginId, safeView);
      latestByPlugin.set(pluginId, { sessionId, view: safeView, timestamp: Date.now() });

      state.revision = webUiStore.snapshot().revision;
      return true;
    },

    getView(sessionId: string, pluginId: string): WebView | undefined {
      return views.get(sessionId)?.get(pluginId);
    },

    getLatestView(pluginId: string): WebView | undefined {
      return latestByPlugin.get(pluginId)?.view;
    },

    getAllViews(): Record<string, Record<string, WebView>> {
      const result: Record<string, Record<string, WebView>> = {};
      for (const [sessionId, sessionMap] of views.entries()) {
        const sessionObj: Record<string, WebView> = {};
        for (const [pluginId, view] of sessionMap.entries()) {
          sessionObj[pluginId] = view;
        }
        result[sessionId] = sessionObj;
      }
      return result;
    },

    getRevision(): number {
      return webUiStore.snapshot().revision;
    },

    subscribeChanges(cb: (revision: number) => void): () => void {
      return webUiStore.subscribe(cb);
    },

    clear(): void {
      webUiStore.clear();
      views.clear();
      latestByPlugin.clear();
      sessionBuses.clear();
      knownSessions.clear();
      auditLog.length = 0;
      inFlightActions.clear();
      state.revision += 1;
    },
  };

  return state;
}

const storeKey = Symbol.for(WEB_PLUGINS_STORE_KEY);
export const webPluginsStore: WebPluginsState = (uiGlobal[storeKey] ??= createStore()) as WebPluginsState;

/** Reset all plugin state (tests). */
export function clearWebPluginStateForTests(): void {
  webPluginsStore.clear();
}

// ---------------------------------------------------------------------------
// Session attach: subscribe a live session's extension event bus.

const attachedWrappers = new WeakSet<object>();

interface MinimalWrapper {
  sessionId: string;
  inner?: {
    resourceLoader?: { eventBus?: MinimalEventBus };
    _resourceLoader?: { eventBus?: MinimalEventBus };
  };
  onEvent?: (listener: (event: { type?: string }) => void) => () => void;
}

/**
 * Subscribe a session wrapper to web-plugin view and UI events.
 * The wrapper shape matches the vendored host's: { sessionId, inner, onEvent }.
 */
export function attachSessionPlugins(wrapper: unknown): () => void {
  if (!wrapper || typeof wrapper !== "object") return () => {};
  if (attachedWrappers.has(wrapper)) return () => {};

  const w = wrapper as MinimalWrapper;
  const sessionId = w.sessionId;
  if (!sessionId || typeof sessionId !== "string") return () => {};

  webPluginsStore.knownSessions.add(sessionId);

  const eventBus = w.inner?.resourceLoader?.eventBus ?? w.inner?._resourceLoader?.eventBus;
  if (!eventBus || typeof eventBus.on !== "function") {
    return () => {};
  }

  attachedWrappers.add(wrapper);
  webPluginsStore.sessionBuses.set(sessionId, eventBus);

  const unsubUi = eventBus.on(WEB_UI_EVENT, (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const event = raw as { type?: WebUiType; payload?: unknown; sourceKey?: string; source?: string; sessionId?: string };
    const sourceKey = typeof event.sourceKey === "string" ? event.sourceKey : "extension";
    // Session identity/source/ordering are assigned by the owning host, not the bus payload.
    if (event.sessionId !== undefined && event.sessionId !== sessionId) {
      webUiStore.reject(sessionId, sourceKey, "cross-session event rejected");
      return;
    }
    if (
      event.source === "browser"
      || event.type === "ui.plugin.action-requested"
      || event.type === "ui.session.lifecycle"
    ) {
      webUiStore.reject(sessionId, sourceKey, "reserved host event");
      return;
    }
    if (event.type === "ui.layout.changed") {
      const p = event.payload as { pluginId?: string; contributionId?: string } | undefined;
      const plugin = getPluginDescriptor(p?.pluginId ?? "");
      if (!plugin || !normalizeContributions(plugin).some((c) => c.id === p?.contributionId)) {
        webUiStore.reject(sessionId, sourceKey, "unknown plugin/contribution layout target");
        return;
      }
    }
    if (event.type) webUiStore.publish(sessionId, event.type, event.payload, sourceKey);
  });

  const unsubViews = eventBus.on(WEB_PLUGIN_VIEW_EVENT, (payload: unknown) => {
    if (payload && typeof payload === "object" && "pluginId" in payload && "view" in payload) {
      const { pluginId, view } = payload as { pluginId: string; view: unknown };
      webPluginsStore.recordView(sessionId, pluginId, view);
    }
  });

  let cleanedUp = false;
  let unsubOnEvent: (() => void) | undefined;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (webPluginsStore.sessionBuses.get(sessionId) === eventBus) {
      webPluginsStore.sessionBuses.delete(sessionId);
    }
    try {
      unsubViews();
      unsubUi();
    } catch {
      // Ignore
    }
    if (unsubOnEvent) {
      try {
        unsubOnEvent();
      } catch {
        // Ignore
      }
    }
  };

  if (typeof w.onEvent === "function") {
    try {
      unsubOnEvent = w.onEvent((event) => {
        if (event?.type === "session_shutdown") {
          cleanup();
        }
      });
    } catch {
      // Ignore
    }
  }

  return cleanup;
}

export function isKnownSession(sessionId: string): boolean {
  if (!sessionId || typeof sessionId !== "string") return false;
  if (webPluginsStore.knownSessions.has(sessionId)) return true;
  if (webPluginsStore.sessionBuses.has(sessionId)) return true;
  if (webPluginsStore.views.has(sessionId)) return true;
  return false;
}

export function relayActionRequest(
  sessionId: string,
  pluginId: string,
  actionId: string,
  requestId?: string,
): { relayed: boolean } {
  if (!sessionId || !pluginId || !actionId) {
    return { relayed: false };
  }
  const bus = webPluginsStore.sessionBuses.get(sessionId);
  if (!bus || typeof bus.emit !== "function") {
    return { relayed: false };
  }
  try {
    const rid = requestId || crypto.randomUUID();
    webUiStore.publish(sessionId, "ui.plugin.action-requested", { pluginId, actionId, requestId: rid }, pluginId, "host");
    bus.emit(WEB_PLUGIN_ACTION_REQUEST_EVENT, { requestId: rid, sessionId, pluginId, actionId });
    return { relayed: true };
  } catch {
    return { relayed: false };
  }
}

export function checkAndSetInFlightAction(
  sessionId: string,
  requestId: string,
  ttlMs = 60_000,
): boolean {
  const now = Date.now();
  const current = webPluginsStore.inFlightActions.get(sessionId);
  if (current && current.expiresAt > now) {
    return false;
  }
  webPluginsStore.inFlightActions.set(sessionId, { requestId, expiresAt: now + ttlMs });
  return true;
}

export function recordActionAudit(entry: ActionAuditEntry): void {
  webPluginsStore.auditLog.push(entry);
}

export function getActionAuditLog(): readonly ActionAuditEntry[] {
  return webPluginsStore.auditLog;
}

// ---------------------------------------------------------------------------
// Test fixtures (PI_WEB_TEST_PLUGIN_VIEWS=1) — the same seeds the vendored
// e2e used, so Phase E's Playwright suite can drive the plugin surfaces
// without a live pi session.

const seededWorkingSessions = new Set<string>();

/** Seeded delegated-work graph for the subagent monitor (test fixtures only). */
function monitorFixtureGraph(lastRequest: string) {
  return {
    type: "graph" as const,
    title: "Delegated work graph",
    nodes: [
      { id: "parent", label: "Fixture parent", kind: "parent" as const, status: "active" as const },
      {
        id: "child:worker-slots",
        label: `worker-slots · ${lastRequest}`,
        kind: "child" as const,
        status: "active" as const,
        detail: `**Task:** Port slot adapters\n**Last request:** ${lastRequest}`,
      },
    ],
    edges: [{ from: "parent", to: "child:worker-slots", label: "handoff" }],
  };
}

export function checkAndSeedFixtures(store = webPluginsStore): void {
  if (process.env.PI_WEB_TEST_PLUGIN_VIEWS === "1") {
    const testSessionId = "__test_session__";
    store.knownSessions.add(testSessionId);
    if (!store.sessionBuses.has(testSessionId)) {
      store.sessionBuses.set(testSessionId, {
        on: () => () => {},
        emit: (ch: string, data: unknown) => {
          if (ch === WEB_PLUGIN_ACTION_REQUEST_EVENT) {
            const d = data as { requestId?: string };
            store.recordView(testSessionId, "subagent-monitor", monitorFixtureGraph(d?.requestId || "synced"));
          }
        },
      });
    }
    if (!store.getView(testSessionId, "cache-stats")) {
      store.recordView(testSessionId, "cache-stats", {
        type: "kv",
        title: "Cache health test",
        rows: [
          { label: "XSS Test", value: "<script>alert('xss')</script>" },
          { label: "Hit rate", value: "94.2%" },
        ],
      });
    }
    if (!store.getView(testSessionId, "todo")) {
      store.recordView(testSessionId, "todo", {
        type: "list",
        title: "Active tasks",
        items: ["Implement frontend slots", "Verify e2e test suite"],
      });
    }
    if (!store.getView(testSessionId, "artifacts")) {
      store.recordView(testSessionId, "artifacts", {
        type: "list",
        title: "Artifacts",
        items: ["prd-phase-6.md", "slot-architecture.png"],
      });
    }
    if (!store.getView(testSessionId, "subagent-checkpoints")) {
      store.recordView(testSessionId, "subagent-checkpoints", {
        type: "kv",
        title: "Delegated work",
        rows: [
          { label: "Active child", value: "worker-slots" },
          { label: "Status", value: "In progress" },
        ],
      });
    }
    if (!store.getView(testSessionId, "subagent-monitor")) {
      store.recordView(testSessionId, "subagent-monitor", monitorFixtureGraph("seeded"));
    }
    if (!seededWorkingSessions.has(testSessionId)) {
      recordWorkingUi(testSessionId, { message: "Ratiocinating..." });
      seededWorkingSessions.add(testSessionId);
    }
  }
}

checkAndSeedFixtures();

export type { WebView, KvWebView, ListWebView, StatusWebView, ValidateViewResult, ActionDescriptor, WebPluginDescriptor, WebUiSnapshot, WebUiSessionState };
