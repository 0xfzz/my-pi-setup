// Typed client for the plugin manager endpoints. Pure shaping + fetch, no React,
// so the page stays a view over the kernel's answers.

import { PLUGIN_MANAGER_API } from "../contract.ts";

export interface PluginManagerRow {
  id: string;
  title: string;
  description?: string;
  source: string;
  version: string;
  state: string;
  waiting?: string;
  lastError?: string;
  grants: string[];
  pending: string[];
  quarantine?: { version: string; reason: string; at: number };
  routes: Array<{ method: string; path: string }>;
}

export interface PluginManagerReport {
  safeMode: boolean;
  warnings: string[];
  shadowed: Array<{ id: string; source: string; shadowedBy: string }>;
  plugins: PluginManagerRow[];
  audit: Array<{ seq: number; at: number; kind: string; pluginId: string; detail: string }>;
}

export type ManagerResult<T> = { ok: true; data: T } | { ok: false; message: string };

export const MANAGER_ACTIONS = ["enable", "disable", "reload", "clear-quarantine"] as const;
export type ManagerAction = (typeof MANAGER_ACTIONS)[number];

/** Read the whole kernel state in one request. */
export async function fetchPluginManagerReport(): Promise<ManagerResult<PluginManagerReport>> {
  let response: Response;
  try {
    response = await fetch(PLUGIN_MANAGER_API, { headers: { Accept: "application/json" } });
  } catch {
    return { ok: false, message: "the web server did not answer" };
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    return { ok: false, message: typeof body.error === "string" ? body.error : `request failed (HTTP ${response.status})` };
  }
  if (!Array.isArray(body.plugins)) return { ok: false, message: "the manager report was not understood" };
  return { ok: true, data: body as unknown as PluginManagerReport };
}

export interface ManagerActionOutcome {
  ok: boolean;
  state: string;
  error?: string;
  rolledBack?: boolean;
}

/** Apply one operator action; the kernel's verdict comes back verbatim. */
export async function applyManagerAction(
  pluginId: string,
  action: ManagerAction,
): Promise<ManagerResult<ManagerActionOutcome>> {
  let response: Response;
  try {
    response = await fetch(`${PLUGIN_MANAGER_API}/${encodeURIComponent(pluginId)}/${action}`, { method: "POST" });
  } catch {
    return { ok: false, message: "the web server did not answer" };
  }
  const body = (await response.json().catch(() => ({}))) as ManagerActionOutcome & { error?: string };
  if (!response.ok) {
    return { ok: false, message: body.error ?? `action ${action} failed (HTTP ${response.status})` };
  }
  return { ok: true, data: body };
}

/** Which actions make sense for a plugin in this state — a pure decision. */
export function availableActions(state: string): ManagerAction[] {
  switch (state) {
    case "active":
      return ["disable", "reload"];
    case "disabled":
      return ["enable"];
    case "quarantined":
      return ["clear-quarantine", "disable"];
    case "failed":
    case "disposed":
      return ["enable"];
    case "unresolved":
    case "rejected":
    case "ignored":
      return [];
    default:
      return ["enable"];
  }
}

/** Group the report by source so the page reads as installed/third-party first. */
export function groupBySource(rows: readonly PluginManagerRow[]): Array<{ source: string; rows: PluginManagerRow[] }> {
  const order = ["repo", "project", "user", "package"];
  const groups = new Map<string, PluginManagerRow[]>();
  for (const row of rows) {
    const list = groups.get(row.source) ?? [];
    list.push(row);
    groups.set(row.source, list);
  }
  return [...groups.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([source, groupRows]) => ({
      source,
      rows: [...groupRows].sort((a, b) => a.id.localeCompare(b.id)),
    }));
}
