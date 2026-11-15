// The operator plugin-manager wire contract.
//
// One definition of the report the kernel publishes and the page renders. It
// used to be declared twice — once on the server, once hand-copied in the
// plugin's client — so a field added on one side left the other's type lying.

import type { PluginStatus } from "../plugin-contracts/kernel/manager.ts";

/** The operator endpoints (`web/core/server/plugin-admin.ts`). */
export const PLUGIN_MANAGER_API = "/api/plugin-manager";

export const PLUGIN_MANAGER_ACTIONS = ["enable", "disable", "reload", "clear-quarantine", "clear-safe-mode"] as const;
export type PluginManagerAction = (typeof PLUGIN_MANAGER_ACTIONS)[number];

/**
 * A kernel-level action has no plugin id; the route still needs one path
 * segment, so the operator sends this reserved id and the handler ignores it.
 */
export const KERNEL_MANAGER_ID = "kernel";

/**
 * Capability actions carry the capability string in the request body. They are
 * separate from the lifecycle actions so a caller cannot confuse "enable the
 * plugin" with "confirm one of its requests".
 */
export const PLUGIN_CAPABILITY_ACTIONS = ["grant", "revoke"] as const;
export type PluginCapabilityAction = (typeof PLUGIN_CAPABILITY_ACTIONS)[number];

export type PluginManagerCommand = PluginManagerAction | PluginCapabilityAction;

export interface CapabilityActionBody {
  capability: string;
}

export interface PluginManagerRoute {
  method: string;
  path: string;
}

/** One row: the kernel's status plus what the plugin contributes. */
export interface PluginManagerRow extends PluginStatus {
  title: string;
  description?: string;
  /** `/api/p/<id>/…` routes the plugin mounted. */
  routes: PluginManagerRoute[];
}

export interface PluginManagerAuditEntry {
  seq: number;
  at: number;
  kind: string;
  pluginId: string;
  detail: string;
}

export interface PluginManagerReport {
  safeMode: boolean;
  warnings: string[];
  shadowed: Array<{ id: string; source: string; shadowedBy: string }>;
  plugins: PluginManagerRow[];
  audit: PluginManagerAuditEntry[];
}

/** The kernel's verdict on one operator action, verbatim. */
export interface PluginManagerOutcome {
  ok: boolean;
  state: string;
  error?: string;
  rolledBack?: boolean;
}
