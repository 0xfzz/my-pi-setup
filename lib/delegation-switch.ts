/**
 * delegation-switch.ts — the session's on/off decision for the canonical
 * delegation surface.
 *
 * Replaces the v1/v2 version switch. There is one namespace now, so there is one
 * switch. The decision is still recorded on the branch (`subagent-switch:v1`,
 * the historic entry type, so existing sessions keep their choice) and every
 * loadout is derived from `baseline − disabled`; nothing outside the delegation
 * table is ever touched.
 *
 * This module is the only reader/writer of that decision. `modes.ts` uses
 * `reconcileLoadout`/`switchStateFromBranch`, and the `/subagents` command uses
 * `applyDelegationToggle` + `saveDelegationDefault`.
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  DELEGATION_TOOLS,
  RETIRED_V1_TOOLS,
  canonicalDelegationName,
} from "./delegation-tools.ts";

/** Branch custom-entry type. Historic name kept so old sessions retain their decision. */
export const DELEGATE_SWITCH_TYPE = "subagent-switch:v1";

const CANONICAL: ReadonlySet<string> = new Set(DELEGATION_TOOLS.map(tool => tool.name));

export interface DelegationSwitchState {
  /** Canonical delegation names the user switched off in this session. */
  disabled: Set<string>;
}

/** Newest decision wins. Retired names are mapped; unknown names are dropped. */
export function switchStateFromBranch(branch: readonly any[] | undefined): DelegationSwitchState {
  for (let index = (branch?.length ?? 0) - 1; index >= 0; index--) {
    const entry = branch![index];
    if (entry?.type !== "custom" || entry.customType !== DELEGATE_SWITCH_TYPE) continue;
    const raw = entry.data?.disabled;
    const disabled = new Set<string>();
    for (const name of Array.isArray(raw) ? raw : []) {
      if (typeof name !== "string") continue;
      const canonical = canonicalDelegationName(name) ?? name;
      if (CANONICAL.has(canonical)) disabled.add(canonical);
    }
    return { disabled };
  }
  return { disabled: new Set() };
}

/**
 * `baseline` filtered by the switch decision.
 *
 * Retired v1 names are dropped here: the namespace migration is complete, and a
 * persisted snapshot must never re-activate a name that no longer exists.
 */
export function reconcileLoadout(baseline: Iterable<string>, disabled: Iterable<string>): string[] {
  const blocked = new Set(disabled);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of baseline) {
    if (RETIRED_V1_TOOLS.has(name)) continue;
    if (seen.has(name) || blocked.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Names that are switched off AND registered — i.e. actually unavailable. */
export function effectiveDisabled(disabled: Iterable<string>, registered: Iterable<string>): string[] {
  const registeredSet = new Set(registered);
  return [...disabled].filter(name => registeredSet.has(name)).sort();
}

export interface DelegationStatus {
  enabled: boolean;
  activeTools: string[];
  registeredTools: string[];
  /** Registered but currently inactive (switched off, or a restricted mode). */
  disabledTools: string[];
  /** Canonical tools this build knows about but this session did not register. */
  missingTools: string[];
}

export function getDelegationStatus(pi: {
  getActiveTools(): string[];
  getAllTools?(): Array<{ name: string }>;
}): DelegationStatus {
  const active = new Set(pi.getActiveTools());
  const registeredNames = pi.getAllTools ? pi.getAllTools().map(tool => tool.name) : [...CANONICAL];
  const registered = new Set(registeredNames);
  const activeTools = [...CANONICAL].filter(name => active.has(name)).sort();
  const registeredTools = [...CANONICAL].filter(name => registered.has(name)).sort();
  const missingTools = [...CANONICAL].filter(name => !registered.has(name)).sort();
  const disabledTools = registeredTools.filter(name => !active.has(name));
  return { enabled: activeTools.length > 0, activeTools, registeredTools, disabledTools, missingTools };
}

export function formatDelegationStatus(status: DelegationStatus): string {
  const headline = status.enabled
    ? `Delegation: ON (${status.activeTools.length}/${status.registeredTools.length} registered tools active)`
    : `Delegation: OFF (0/${status.registeredTools.length} registered tools active)`;
  const lines = [headline];
  if (status.disabledTools.length) lines.push(`Switched off: ${status.disabledTools.join(", ")}`);
  if (status.missingTools.length) lines.push(`Not registered in this session: ${status.missingTools.join(", ")}`);
  lines.push("Namespace: orch_* only. The v1 subagent/caller_ping surface has been removed.");
  return lines.join("\n");
}

export interface DelegationToggleResult {
  changed: boolean;
  message: string;
  /** The new decision, to be persisted on the branch by the caller. */
  disabled: string[];
  status: DelegationStatus;
}

/**
 * Enable or disable the whole canonical surface.
 *
 * Baseline is `active ∪ previouslyDisabled`, never `active` alone: the toggle has
 * to be reversible even when a restricted mode narrowed the live loadout in the
 * meantime. Only names in the canonical table are ever added to the decision.
 */
export function applyDelegationToggle(
  pi: {
    getActiveTools(): string[];
    setActiveTools(tools: string[]): void;
    getAllTools?(): Array<{ name: string }>;
  },
  enabled: boolean,
  previousDisabled: Iterable<string> = [],
): DelegationToggleResult {
  const prev = [...previousDisabled].filter(name => CANONICAL.has(name));
  const disabled = enabled ? [] : [...CANONICAL];
  const disabledSet = new Set(disabled);

  const baseline = [...new Set([...pi.getActiveTools(), ...prev])];
  const nextActive = reconcileLoadout(baseline, disabledSet);
  const current = pi.getActiveTools();
  const unchanged = nextActive.length === current.length
    && nextActive.every((name, index) => name === current[index]);

  if (!unchanged) pi.setActiveTools(nextActive);

  return {
    changed: !unchanged || disabled.join(",") !== [...prev].sort().join(","),
    message: enabled
      ? `Delegation tools turned ON (${CANONICAL.size} tools in the orch_* surface).`
      : `Delegation tools turned OFF for this session (${CANONICAL.size} tools). Unrelated tools are untouched.`,
    disabled: [...disabled].sort(),
    status: getDelegationStatus(pi),
  };
}

export type DelegationAction = "browse" | "gc" | "status" | "help" | "on" | "off" | "save";

export function parseSubagentsCommand(args: string): { action: DelegationAction; raw: string } {
  const trimmed = (args ?? "").trim().toLowerCase();
  if (!trimmed) return { action: "browse", raw: args };
  if (trimmed === "gc" || trimmed.startsWith("gc ")) return { action: "gc", raw: args };
  if (trimmed === "status") return { action: "status", raw: args };
  if (trimmed === "help" || trimmed === "--help" || trimmed === "-h") return { action: "help", raw: args };
  if (trimmed === "on") return { action: "on", raw: args };
  if (trimmed === "off") return { action: "off", raw: args };
  if (trimmed === "save") return { action: "save", raw: args };
  return { action: "browse", raw: args };
}

export function isSwitchCommand(args: string): boolean {
  const action = parseSubagentsCommand(args).action;
  return action === "status" || action === "help" || action === "save" || action === "on" || action === "off";
}

export function getDefaultSettingsPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "settings.json");
}

/**
 * Persist the default for future sessions. The session decision still lives on
 * the branch; this only changes what a fresh session starts with.
 */
export function saveDelegationDefault(
  enabled: boolean,
  customPath?: string,
): { success: boolean; path: string; message: string } {
  const settingsPath = customPath || getDefaultSettingsPath();

  let settings: Record<string, any> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch (error: any) {
      return {
        success: false,
        path: settingsPath,
        message: `Failed to read existing settings at ${settingsPath}: ${error?.message ?? error}`,
      };
    }
  }

  settings.delegation = enabled ? "on" : "off";
  // A v1/v2 preference is meaningless after the removal; leaving it would imply
  // the old switch still exists.
  delete settings.subagentVersion;

  const tmpPath = `${settingsPath}.tmp.${Date.now()}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmpPath, settingsPath);
  } catch (error: any) {
    return {
      success: false,
      path: settingsPath,
      message: `Failed to write settings to ${settingsPath}: ${error?.message ?? error}`,
    };
  }

  return {
    success: true,
    path: settingsPath,
    message: `Persisted delegation default: "${enabled ? "on" : "off"}" in ${settingsPath}. `
      + "This session's decision still lives on the branch.",
  };
}
