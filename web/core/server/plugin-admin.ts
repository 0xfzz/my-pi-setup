// Plugin manager surface: the operator's read-and-control view of the kernel.
//
// Two endpoints, both under /api/plugin-manager:
//   GET  /api/plugin-manager                → status, safe mode, warnings, routes, audit
//   POST /api/plugin-manager/:id/:action    → enable | disable | reload | clear-quarantine
//
// The kernel owns every decision (capabilities, dependencies, the breaker); this
// module only adapts HTTP to `PluginManager`, so the UI and the CLI share one
// implementation.

import type { IncomingMessage, ServerResponse } from "node:http";
import { getPluginHost } from "./plugin-host.ts";
import { sendJson } from "./http.ts";
import type { PluginStatus } from "../plugin-contracts/kernel/manager.ts";

export const PLUGIN_MANAGER_ACTIONS = ["enable", "disable", "reload", "clear-quarantine"] as const;
export type PluginManagerAction = (typeof PLUGIN_MANAGER_ACTIONS)[number];

/** One row the manager UI renders: kernel status plus what the plugin contributes. */
export interface PluginManagerRow extends PluginStatus {
  title: string;
  description?: string;
  /** `/api/p/<id>/…` routes the plugin mounted. */
  routes: Array<{ method: string; path: string }>;
}

export interface PluginManagerReport {
  safeMode: boolean;
  warnings: string[];
  shadowed: Array<{ id: string; source: string; shadowedBy: string }>;
  plugins: PluginManagerRow[];
  audit: Array<{ seq: number; at: number; kind: string; pluginId: string; detail: string }>;
}

/** The whole kernel state the manager page needs, in one read. */
export function pluginManagerReport(): PluginManagerReport | null {
  const host = getPluginHost();
  if (host === null) return null;
  const routes = host.routes.list();
  const plugins: PluginManagerRow[] = host.manager.snapshot().map((status) => {
    const descriptor = host.descriptor(status.id);
    return {
      ...status,
      title: descriptor?.title ?? status.id,
      ...(descriptor?.description !== undefined ? { description: descriptor.description } : {}),
      routes: routes
        .filter((route) => route.pluginId === status.id)
        .map((route) => ({ method: route.method, path: route.path })),
    };
  });
  return {
    safeMode: host.manager.isSafeMode(),
    warnings: [...host.warnings],
    shadowed: host.shadowed.map((entry) => ({ id: entry.id, source: entry.source, shadowedBy: entry.shadowedBy })),
    plugins,
    audit: host.audit.list({}).slice(-50),
  };
}

export function isPluginManagerAction(value: string): value is PluginManagerAction {
  return (PLUGIN_MANAGER_ACTIONS as readonly string[]).includes(value);
}

/**
 * Apply one operator action. `unknown plugin` and `not quarantined` are the
 * kernel's answers, so the response carries its state and message verbatim.
 */
export async function applyPluginManagerAction(
  pluginId: string,
  action: PluginManagerAction,
): Promise<{ ok: boolean; state: string; error?: string; rolledBack?: boolean }> {
  const host = getPluginHost();
  if (host === null) {
    return { ok: false, state: "unknown", error: "plugin host not started" };
  }
  const manager = host.manager;
  if (action === "enable") return manager.enable(pluginId);
  if (action === "disable") return manager.disable(pluginId);
  if (action === "reload") return manager.reload(pluginId);
  return manager.clearQuarantine(pluginId);
}

/** GET /api/plugin-manager */
export function handlePluginManagerReport(res: ServerResponse): void {
  const report = pluginManagerReport();
  if (report === null) {
    sendJson(res, 503, { error: "plugin host not started", code: "plugin_host_unavailable" });
    return;
  }
  sendJson(res, 200, report);
}

/** POST /api/plugin-manager/:id/:action */
export async function handlePluginManagerCommand(
  _req: IncomingMessage,
  res: ServerResponse,
  pluginId: string,
  action: string,
): Promise<void> {
  if (!isPluginManagerAction(action)) {
    sendJson(res, 400, { error: `unknown action "${action}"`, actions: PLUGIN_MANAGER_ACTIONS });
    return;
  }
  const outcome = await applyPluginManagerAction(pluginId, action);
  // 404 only when the kernel does not know the plugin at all; a refused action
  // (quarantined, unresolved, broken) is a 409 carrying the state.
  const unknown = outcome.error?.startsWith("unknown plugin") ?? false;
  sendJson(res, outcome.ok ? 200 : unknown ? 404 : 409, outcome);
}
