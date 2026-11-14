// Typed client for the plugin manager endpoints. Pure shaping + fetch, no React,
// so the page stays a view over the kernel's answers.

import { getJson, postJson, type ApiFailure, type ApiResult } from "../../../core/client/plugin-system/api-client.ts";
import {
  PLUGIN_MANAGER_API,
  PLUGIN_MANAGER_ACTIONS,
  type PluginCapabilityAction,
  type PluginManagerAction,
  type PluginManagerCommand,
  type PluginManagerOutcome,
  type PluginManagerReport,
  type PluginManagerRow,
} from "../../../core/shared/plugin-manager.ts";

export type {
  PluginCapabilityAction,
  PluginManagerAction,
  PluginManagerCommand,
  PluginManagerOutcome,
  PluginManagerReport,
  PluginManagerRow,
};

export type ManagerResult<T> = ApiResult<T>;
export type ManagerFailure = ApiFailure;

export const MANAGER_ACTIONS = PLUGIN_MANAGER_ACTIONS;

/** Read the whole kernel state in one request. */
export async function fetchPluginManagerReport(): Promise<ManagerResult<PluginManagerReport>> {
  const outcome = await getJson<PluginManagerReport>(PLUGIN_MANAGER_API);
  if (!outcome.ok) return outcome;
  if (!Array.isArray(outcome.data.plugins)) {
    return { ok: false, code: "unreadable", message: "the manager report was not understood", status: 200 };
  }
  return outcome;
}

/** Apply one operator action; the kernel's verdict comes back verbatim. */
export async function applyManagerAction(
  pluginId: string,
  action: PluginManagerCommand,
  capability?: string,
): Promise<ManagerResult<PluginManagerOutcome>> {
  const url = `${PLUGIN_MANAGER_API}/${encodeURIComponent(pluginId)}/${action}`;
  return postJson<PluginManagerOutcome>(url, capability === undefined ? undefined : { capability });
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
