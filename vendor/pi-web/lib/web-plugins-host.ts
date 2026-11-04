import { createJiti } from "jiti";
import { resolve } from "node:path";
import type { WebPluginDescriptor } from "../../../lib/web-plugins/descriptor.ts";
import type {
  WebView,
  KvWebView,
  ListWebView,
  StatusWebView,
  ValidateViewResult,
} from "../../../lib/web-plugins/view.ts";

const jiti = createJiti(process.cwd());

const webPluginsIndex = resolve(process.cwd(), "../../web-plugins/index.ts");
const webPluginsView = resolve(process.cwd(), "../../lib/web-plugins/view.ts");

const loadedIndex = jiti(webPluginsIndex) as { WEB_PLUGINS: readonly WebPluginDescriptor[] };
const loadedView = jiti(webPluginsView) as {
  WEB_PLUGIN_VIEW_EVENT: string;
  validateView: (input: unknown) => ValidateViewResult;
};

export const WEB_PLUGINS: readonly WebPluginDescriptor[] = loadedIndex.WEB_PLUGINS;
export const WEB_PLUGIN_VIEW_EVENT: string = loadedView.WEB_PLUGIN_VIEW_EVENT;
export const validateView = loadedView.validateView;

export const WEB_PLUGINS_STORE_KEY = "@pi-workflow-extensions/web-plugins-store/v1";

export interface WebPluginsState {
  version: 1;
  // sessionId -> pluginId -> WebView
  views: Map<string, Map<string, WebView>>;
  // pluginId -> { sessionId, view, timestamp }
  latestByPlugin: Map<string, { sessionId: string; view: WebView; timestamp: number }>;
  recordView(sessionId: string, pluginId: string, view: unknown): boolean;
  getView(sessionId: string, pluginId: string): WebView | undefined;
  getLatestView(pluginId: string): WebView | undefined;
  getAllViews(): Record<string, Record<string, WebView>>;
  clear(): void;
}

function createStore(): WebPluginsState {
  const views = new Map<string, Map<string, WebView>>();
  const latestByPlugin = new Map<string, { sessionId: string; view: WebView; timestamp: number }>();

  function recordView(sessionId: string, pluginId: string, rawView: unknown): boolean {
    if (!sessionId || typeof sessionId !== "string") return false;
    if (!pluginId || typeof pluginId !== "string") return false;

    const validation = validateView(rawView);
    if (!validation.ok) {
      return false;
    }

    let sessionMap = views.get(sessionId);
    if (!sessionMap) {
      sessionMap = new Map();
      views.set(sessionId, sessionMap);
    }
    sessionMap.set(pluginId, validation.view);
    latestByPlugin.set(pluginId, {
      sessionId,
      view: validation.view,
      timestamp: Date.now(),
    });
    return true;
  }

  function getView(sessionId: string, pluginId: string): WebView | undefined {
    return views.get(sessionId)?.get(pluginId);
  }

  function getLatestView(pluginId: string): WebView | undefined {
    const entry = latestByPlugin.get(pluginId);
    return entry?.view;
  }

  function getAllViews(): Record<string, Record<string, WebView>> {
    const result: Record<string, Record<string, WebView>> = {};
    for (const [sessionId, sessionMap] of views.entries()) {
      const sessionObj: Record<string, WebView> = {};
      for (const [pluginId, view] of sessionMap.entries()) {
        sessionObj[pluginId] = view;
      }
      result[sessionId] = sessionObj;
    }
    return result;
  }

  function clear(): void {
    views.clear();
    latestByPlugin.clear();
  }

  return {
    version: 1,
    views,
    latestByPlugin,
    recordView,
    getView,
    getLatestView,
    getAllViews,
    clear,
  };
}

function getStore(): WebPluginsState {
  const store = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for(WEB_PLUGINS_STORE_KEY);
  const existing = store[key];
  if (
    existing &&
    typeof existing === "object" &&
    (existing as WebPluginsState).version === 1 &&
    typeof (existing as WebPluginsState).recordView === "function"
  ) {
    return existing as WebPluginsState;
  }
  const created = createStore();
  store[key] = created;
  return created;
}

export const webPluginsStore = getStore();

/**
 * Seed fixture views for tests when PI_WEB_TEST_PLUGIN_VIEWS is enabled.
 */
export function checkAndSeedFixtures(store = webPluginsStore): void {
  if (process.env.PI_WEB_TEST_PLUGIN_VIEWS === "1") {
    const testSessionId = "__test_session__";
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
  }
}

// Auto-seed if flag is present at import time
checkAndSeedFixtures();

/**
 * Read registered descriptors from the workflow extension index.
 */
export function getRegisteredPlugins(): readonly WebPluginDescriptor[] {
  return WEB_PLUGINS;
}

export function getPluginDescriptor(id: string): WebPluginDescriptor | undefined {
  return WEB_PLUGINS.find((plugin) => plugin.id === id);
}

const attachedWrappers = new WeakSet<object>();

interface MinimalEventBus {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit?(channel: string, data: unknown): void;
}

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

  const eventBus =
    w.inner?.resourceLoader?.eventBus ??
    w.inner?._resourceLoader?.eventBus;

  if (!eventBus || typeof eventBus.on !== "function") {
    return () => {};
  }

  attachedWrappers.add(wrapper);

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
    try {
      unsubEventBus();
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

export {
  type WebView,
  type KvWebView,
  type ListWebView,
  type StatusWebView,
  type WebPluginDescriptor,
  type ValidateViewResult,
};
