import { createJiti } from "jiti";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ActionDescriptor } from "./web-ui-actions";
import type { WebPluginDescriptor } from "./web-ui-descriptor";
import type {
  WebView,
  KvWebView,
  ListWebView,
  StatusWebView,
  ValidateViewResult,
} from "./web-ui-views";

import { WebUiStore } from "./web-ui-state-store";
import { WEB_UI_EVENT, extensionUiUpdate, type WebUiType } from "./web-ui-event-models";
import { normalizeContributions } from "./web-ui-contracts";

const uiGlobal = globalThis as Record<PropertyKey, unknown>;
const uiStoreKey = Symbol.for("pi-web:unified-ui:v1");
export const webUiStore = (uiGlobal[uiStoreKey] ??= new WebUiStore()) as WebUiStore;

/** Called before legacy delivery; UI projection never consumes dialog responses. */
export function recordExtensionUi(sessionId: string, event: Record<string, unknown>, project?: string): void {
  if (event.type === "extension_ui_request") {
    const update = extensionUiUpdate(event);
    if (update) webUiStore.publish(sessionId, update.type, update.payload, update.sourceKey);
  } else if (event.type === "extension_ui_closed") {
    webUiStore.publish(sessionId, "ui.custom.changed", { id: event.id, method: "closed", lines: null }, String(event.id));
  } else if (["agent_start", "agent_settled", "session_shutdown"].includes(String(event.type))) {
    webUiStore.publish(sessionId, "ui.session.lifecycle", { running: event.type === "agent_start", closed: event.type === "session_shutdown", ...(project ? { project } : {}) }, "lifecycle", "host");
  }
}
export function recordWorkingUi(sessionId: string, payload: unknown): boolean {
  return webUiStore.publish(sessionId, "ui.working.changed", payload, "ctx.ui.working");
}
const jiti = createJiti(process.cwd());

const seededWorkingSessions = new Set<string>();

function resolveRepoPath(relPath: string): string {
  const twoUp = resolve(process.cwd(), "../../", relPath);
  if (existsSync(twoUp)) return twoUp;
  const direct = resolve(process.cwd(), relPath);
  if (existsSync(direct)) return direct;
  return twoUp;
}

const webPluginsIndex = resolveRepoPath("web-plugins/index.ts");
const webPluginsView = resolveRepoPath("lib/web-plugins/view.ts");
const webPluginsActions = resolveRepoPath("lib/web-plugins/actions.ts");

const loadedIndex = jiti(webPluginsIndex) as { WEB_PLUGINS: readonly WebPluginDescriptor[] };
const loadedView = jiti(webPluginsView) as {
  WEB_PLUGIN_VIEW_EVENT: string;
  validateView: (input: unknown) => ValidateViewResult;
};
const loadedActions = jiti(webPluginsActions) as {
  WEB_PLUGIN_ACTION_REQUEST_EVENT: string;
};

export const WEB_PLUGINS: readonly WebPluginDescriptor[] = loadedIndex.WEB_PLUGINS;

/** The plugin kernel's host facade (lib/web-plugins/kernel/host.ts), loaded from the outer repo. */
interface KernelHost {
  ready: Promise<unknown>;
  warnings: readonly string[];
  visible(): WebPluginDescriptor[];
  descriptor(id: string): WebPluginDescriptor | undefined;
}
const loadedKernel = jiti(resolveRepoPath("lib/web-plugins/kernel/host.ts")) as {
  createPluginHost: (options: Record<string, unknown>) => KernelHost;
};
const userPluginRoot = join(homedir(), ".pi", "agent", "web-plugins");
// Test processes get their own state file so a suite never writes into a real home directory.
function defaultPluginStatePath(): string {
  return process.env.NODE_TEST_CONTEXT
    ? join(tmpdir(), "pi-web-plugin-state", `${process.pid}.json`)
    : join(homedir(), ".pi", "agent", "web-plugins.json");
}
// One host per process: Next.js can evaluate this module more than once, and each evaluation
// must not start the manager again (that would count as a second start for the crash-loop guard).
const pluginHostKey = Symbol.for("pi-web:plugin-host:v1");
export const pluginHost: KernelHost = (uiGlobal[pluginHostKey] ??= loadedKernel.createPluginHost({
  descriptors: WEB_PLUGINS,
  descriptorDir: resolveRepoPath("web-plugins"),
  statePath: process.env.PI_WEB_PLUGIN_STATE ?? defaultPluginStatePath(),
  roots: { user: userPluginRoot, project: join(process.cwd(), ".pi", "web-plugins") },
  env: process.env,
  // Only plugins with a server entry reach the loader; descriptors are declarative.
  loader: (plugin: { dir: string; manifest: { main: { server?: string } } }) => {
    const mod = jiti(join(plugin.dir, plugin.manifest.main.server ?? "")) as { default?: object };
    return mod.default ?? mod;
  },
})) as KernelHost;
pluginHost.ready.catch((error: unknown) => {
  console.error("web plugin host failed to boot:", error);
});
export const WEB_PLUGIN_VIEW_EVENT: string = loadedView.WEB_PLUGIN_VIEW_EVENT;
export const WEB_PLUGIN_ACTION_REQUEST_EVENT: string = loadedActions.WEB_PLUGIN_ACTION_REQUEST_EVENT;
export const validateView = loadedView.validateView;

export const WEB_PLUGINS_STORE_KEY = "@pi-workflow-extensions/web-plugins-store/v1";

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
  changeListeners: Set<(revision: number) => void>;
  // sessionId -> pluginId -> WebView
  views: Map<string, Map<string, WebView>>;
  // pluginId -> { sessionId, view, timestamp }
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

function createStore(): WebPluginsState {
  const changeListeners = new Set<(revision: number) => void>();
  const views = new Map<string, Map<string, WebView>>();
  const latestByPlugin = new Map<string, { sessionId: string; view: WebView; timestamp: number }>();
  const sessionBuses = new Map<string, MinimalEventBus>();
  const knownSessions = new Set<string>();
  const auditLog: ActionAuditEntry[] = [];
  const inFlightActions = new Map<string, InFlightAction>();

  const state: WebPluginsState = {
    version: 1,
    revision: 0,
    changeListeners,
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
      if (!validation.ok) {
        return false;
      }

      if (!webUiStore.publish(sessionId, "ui.view.changed", { pluginId, view: validation.view }, pluginId)) return false;
      const safeView = webUiStore.snapshot().sessions[sessionId].views[pluginId];
      let sessionMap = this.views.get(sessionId);
      if (!sessionMap) {
        sessionMap = new Map();
        this.views.set(sessionId, sessionMap);
      }
      sessionMap.set(pluginId, safeView);
      this.latestByPlugin.set(pluginId, {
        sessionId,
        view: safeView,
        timestamp: Date.now(),
      });

      this.revision = webUiStore.snapshot().revision;
      return true;
    },

    getView(sessionId: string, pluginId: string): WebView | undefined {
      return this.views.get(sessionId)?.get(pluginId);
    },

    getLatestView(pluginId: string): WebView | undefined {
      const entry = this.latestByPlugin.get(pluginId);
      return entry?.view;
    },

    getAllViews(): Record<string, Record<string, WebView>> {
      const result: Record<string, Record<string, WebView>> = {};
      for (const [sessionId, sessionMap] of this.views.entries()) {
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
      seededWorkingSessions.clear();
      this.views.clear();
      this.latestByPlugin.clear();
      this.sessionBuses.clear();
      this.knownSessions.clear();
      this.auditLog.length = 0;
      this.inFlightActions.clear();
      this.revision += 1;
      const currentRev = this.revision;
      for (const listener of this.changeListeners) {
        try {
          listener(currentRev);
        } catch {
          // Best effort
        }
      }
    },
  };

  return state;
}

function getStore(): WebPluginsState {
  const store = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for(WEB_PLUGINS_STORE_KEY);
  const existing = store[key] as WebPluginsState | undefined;
  if (
    existing &&
    typeof existing === "object" &&
    existing.version === 1 &&
    typeof existing.recordView === "function"
  ) {
    if (!existing.sessionBuses) existing.sessionBuses = new Map();
    if (!existing.knownSessions) existing.knownSessions = new Set();
    if (!existing.auditLog) existing.auditLog = [];
    if (!existing.inFlightActions) existing.inFlightActions = new Map();
    if (typeof existing.revision !== "number") existing.revision = 0;
    if (!(existing.changeListeners instanceof Set)) existing.changeListeners = new Set();
    const fresh = createStore();
    existing.recordView = fresh.recordView.bind(existing);
    existing.getRevision = () => webUiStore.snapshot().revision;
    existing.subscribeChanges = fresh.subscribeChanges.bind(existing);
    existing.clear = fresh.clear.bind(existing);
    return existing;
  }
  const created = createStore();
  store[key] = created;
  return created;
}

export const webPluginsStore = getStore();

export function getPluginsRevision(): number {
  return webPluginsStore.getRevision();
}

export function subscribePluginChanges(cb: (revision: number) => void): () => void {
  return webPluginsStore.subscribeChanges(cb);
}

/**
 * Seed fixture views for tests when PI_WEB_TEST_PLUGIN_VIEWS is enabled.
 */
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
            store.recordView(testSessionId, "dashboard", {
              type: "kv",
              title: "Delegated work snapshot",
              rows: [
                { label: "Status", value: "Synchronized" },
                { label: "Last Request", value: d?.requestId || "synced" },
              ],
            });
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
        items: [
          "Implement frontend slots",
          "Verify e2e test suite",
        ],
      });
    }
    if (!store.getView(testSessionId, "artifacts")) {
      store.recordView(testSessionId, "artifacts", {
        type: "list",
        title: "Artifacts",
        items: [
          "prd-phase-6.md",
          "slot-architecture.png",
        ],
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
    // Reference working UI state (PRD phase 6): Bubbly's standard ctx.ui
    // working message flows through the unified stream, not a special view.
    if (!seededWorkingSessions.has(testSessionId)) {
      recordWorkingUi(testSessionId, { message: "Ratiocinating..." });
      seededWorkingSessions.add(testSessionId);
    }
  }
}

// Auto-seed if flag is present at import time
checkAndSeedFixtures();

/**
 * Read registered descriptors from the workflow extension index.
 */
export function getRegisteredPlugins(): readonly WebPluginDescriptor[] {
  return pluginHost.visible();
}

/** Undefined while the plugin is switched off, quarantined, or hidden in safe mode. */
export function getPluginDescriptor(id: string): WebPluginDescriptor | undefined {
  return pluginHost.descriptor(id);
}

const attachedWrappers = new WeakSet<object>();

interface MinimalWrapper {
  sessionId: string;
  inner?: {
    resourceLoader?: {
      eventBus?: MinimalEventBus;
    };
    _resourceLoader?: {
      eventBus?: MinimalEventBus;
    };
  };
  onEvent?: (listener: (event: { type?: string }) => void) => () => void;
}

/**
 * Subscribe a session wrapper to web-plugin:view events.
 */
export function attachSessionPlugins(wrapper: unknown): () => void {
  if (!wrapper || typeof wrapper !== "object") return () => {};
  if (attachedWrappers.has(wrapper)) return () => {};

  const w = wrapper as MinimalWrapper;
  const sessionId = w.sessionId;
  if (!sessionId || typeof sessionId !== "string") return () => {};

  webPluginsStore.knownSessions.add(sessionId);

  const eventBus =
    w.inner?.resourceLoader?.eventBus ??
    w.inner?._resourceLoader?.eventBus;

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
    if (event.sessionId !== undefined && event.sessionId !== sessionId) { webUiStore.reject(sessionId, sourceKey, "cross-session event rejected"); return; }
    if (event.source === "browser" || event.type === "ui.plugin.action-requested" || event.type === "ui.session.lifecycle") { webUiStore.reject(sessionId, sourceKey, "reserved host event"); return; }
    if (event.type === "ui.layout.changed") {
      const p = event.payload as { pluginId?: string; contributionId?: string } | undefined;
      const plugin = getPluginDescriptor(p?.pluginId ?? "");
      if (!plugin || !normalizeContributions(plugin).some(c => c.id === p?.contributionId)) { webUiStore.reject(sessionId, sourceKey, "unknown plugin/contribution layout target"); return; }
    }
    if (event.type) webUiStore.publish(sessionId, event.type, event.payload, sourceKey);
  });

  const unsubEventBus = eventBus.on(WEB_PLUGIN_VIEW_EVENT, (payload: unknown) => {
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
      unsubEventBus();
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
    bus.emit(WEB_PLUGIN_ACTION_REQUEST_EVENT, {
      requestId: rid,
      sessionId,
      pluginId,
      actionId,
    });
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
  webPluginsStore.inFlightActions.set(sessionId, {
    requestId,
    expiresAt: now + ttlMs,
  });
  return true;
}

export function recordActionAudit(entry: ActionAuditEntry): void {
  webPluginsStore.auditLog.push(entry);
}

export function getActionAuditLog(): readonly ActionAuditEntry[] {
  return webPluginsStore.auditLog;
}

export {
  type WebView,
  type KvWebView,
  type ListWebView,
  type StatusWebView,
  type WebPluginDescriptor,
  type ActionDescriptor,
  type ValidateViewResult,
};
