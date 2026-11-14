// Typed client for the plugin manager endpoints. Pure shaping + fetch, no React,
// so the page stays a view over the kernel's answers.

import {
  PLUGIN_MANAGER_API,
  PLUGIN_MANAGER_ACTIONS,
  type PluginManagerAction,
  type PluginManagerOutcome,
  type PluginManagerReport,
  type PluginManagerRow,
} from "../../../core/shared/plugin-manager.ts";

export type { PluginManagerAction, PluginManagerOutcome, PluginManagerReport, PluginManagerRow };

export type ManagerResult<T> = { ok: true; data: T } | { ok: false; message: string };

export const MANAGER_ACTIONS = PLUGIN_MANAGER_ACTIONS;

/** Read the whole kernel state in one request. */
export async function fetchPluginManagerReport(): Promise<ManagerResult<PluginManagerReport>> {
  let response: Response;
  try {
    response = await fetch(PLUGIN_MANAGER_API, { headers: { Accept: "application/json" } });
  } catch {
    return { ok: false, message: "the web server did not answer" };
  }
  const body = (await response.json().catch(() => ({}))) as Partial<PluginManagerReport> & { error?: unknown };
  if (!response.ok) {
    return { ok: false, message: typeof body.error === "string" ? body.error : `request failed (HTTP ${response.status})` };
  }
  if (!Array.isArray(body.plugins)) return { ok: false, message: "the manager report was not understood" };
  return { ok: true, data: body as PluginManagerReport };
}

/** Apply one operator action; the kernel's verdict comes back verbatim. */
export async function applyManagerAction(
  pluginId: string,
  action: PluginManagerAction,
): Promise<ManagerResult<PluginManagerOutcome>> {
  let response: Response;
  try {
    response = await fetch(`${PLUGIN_MANAGER_API}/${encodeURIComponent(pluginId)}/${action}`, { method: "POST" });
  } catch {
    return { ok: false, message: "the web server did not answer" };
  }
  const body = (await response.json().catch(() => ({}))) as PluginManagerOutcome;
  if (!response.ok) {
    return { ok: false, message: body.error ?? `action ${action} failed (HTTP ${response.status})` };
  }
  return { ok: true, data: body };
}

/** Which actions make sense for a plugin in this state — a pure decision. */
export function availableActions(state: string): PluginManagerAction[] {
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

/** Where a plugin came from, in the order the page lists the groups. */
const SOURCE_ORDER = ["repo", "project", "user", "package"];

/** Group the report by source so the page reads as first-party/installed first. */
export function groupBySource(rows: readonly PluginManagerRow[]): Array<{ source: string; rows: PluginManagerRow[] }> {
  const groups = new Map<string, PluginManagerRow[]>();
  for (const row of rows) {
    const list = groups.get(row.source) ?? [];
    list.push(row);
    groups.set(row.source, list);
  }
  return [...groups.entries()]
    .sort((a, b) => SOURCE_ORDER.indexOf(a[0]) - SOURCE_ORDER.indexOf(b[0]))
    .map(([source, groupRows]) => ({
      source,
      rows: [...groupRows].sort((a, b) => a.id.localeCompare(b.id)),
    }));
}
