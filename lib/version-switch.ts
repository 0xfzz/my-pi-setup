import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  ALL_DELEGATE_TOOLS,
  V1_TOOLS,
  V2_TOOLS,
  effectiveDisabled,
  nextDisabledSet,
  reconcileLoadout,
  switchStateFromBranch,
  type VersionToggleAction,
} from "./delegate-switch.ts";

export { V1_TOOLS, V2_TOOLS, ALL_DELEGATE_TOOLS, switchStateFromBranch };
export type { VersionToggleAction };

export interface SubagentVersionStatus {
  v1Active: boolean;
  v2Active: boolean;
  activeV1Tools: string[];
  activeV2Tools: string[];
  registeredV1Tools: string[];
  registeredV2Tools: string[];
  /** Switched off and registered, so genuinely unavailable to the model. */
  disabledTools: string[];
}

export function getSubagentVersionStatus(pi: {
  getActiveTools(): string[];
  getAllTools?(): Array<{ name: string }>;
}): SubagentVersionStatus {
  const active = new Set(pi.getActiveTools());
  const allTools = pi.getAllTools ? pi.getAllTools().map((t) => t.name) : [];
  const registered = new Set(allTools);
  const probe = allTools.length > 0 ? (name: string) => registered.has(name) : () => true;

  return {
    v1Active: V1_TOOLS.some((t) => active.has(t)),
    v2Active: V2_TOOLS.some((t) => active.has(t)),
    activeV1Tools: V1_TOOLS.filter((t) => active.has(t)),
    activeV2Tools: V2_TOOLS.filter((t) => active.has(t)),
    registeredV1Tools: V1_TOOLS.filter(probe),
    registeredV2Tools: V2_TOOLS.filter(probe),
    disabledTools: ALL_DELEGATE_TOOLS.filter((t) => probe(t) && !active.has(t)),
  };
}

export function formatVersionStatus(status: SubagentVersionStatus): string {
  const v1Label = status.v1Active
    ? `v1: ON (${status.activeV1Tools.join(", ")})`
    : `v1: OFF${status.registeredV1Tools.length ? ` (registered: ${status.registeredV1Tools.length})` : ""}`;

  const v2Label = status.v2Active
    ? `v2: ON (${status.activeV2Tools.join(", ")})`
    : `v2: OFF${status.registeredV2Tools.length ? ` (registered: ${status.registeredV2Tools.length})` : ""}`;

  const summary = status.v1Active && status.v2Active
    ? "Both v1 and v2 are active (coexistence mode)."
    : status.v2Active
    ? "v2 is active (handoff specs, scoped isolation, escalation ladder)."
    : status.v1Active
    ? "v1 is active (standard subagents)."
    : "All subagent tools are currently OFF.";

  const off = status.disabledTools.length
    ? `\nSwitched off: ${status.disabledTools.join(", ")}`
    : "";

  return `${v1Label}\n${v2Label}\n${summary}${off}`;
}

export interface ToggleResult {
  changed: boolean;
  message: string;
  status: SubagentVersionStatus;
  /** The new decision, to be persisted on the branch by the caller. */
  disabled: string[];
}

/**
 * Apply a switch decision without destroying the session loadout.
 *
 * The baseline is `active ∪ previouslyDisabled`, never `active` alone. That is
 * what makes the switch idempotent and reversible:
 *
 *   - a name can only ever be removed by being in the disabled set, so `bash`,
 *     MCP tools, and other extensions' tools cannot be collateral damage; and
 *   - re-enabling restores the exact names that were switched off, even if the
 *     live loadout was narrowed in the meantime by a restricted mode.
 *
 * The caller persists `result.disabled` on the branch; this function does not
 * touch the branch itself so it stays unit-testable and free of session state.
 */
export function applyVersionToggle(
  pi: {
    getActiveTools(): string[];
    setActiveTools(tools: string[]): void;
    getAllTools?(): Array<{ name: string }>;
  },
  action: VersionToggleAction,
  previousDisabled: Iterable<string> = [],
): ToggleResult {
  const registeredTools = pi.getAllTools ? pi.getAllTools().map((t) => t.name) : [...ALL_DELEGATE_TOOLS];
  const prev = [...previousDisabled];

  const { disabled, message, unavailable } = nextDisabledSet(prev, action, registeredTools);
  const disabledList = [...disabled].sort();

  // Baseline = what is live now, plus anything the switch itself had removed.
  const baseline = [...new Set([...pi.getActiveTools(), ...prev])];
  const nextActive = reconcileLoadout(baseline, disabled);
  const unchanged = nextActive.length === pi.getActiveTools().length
    && nextActive.every((name, index) => name === pi.getActiveTools()[index]);

  if (!unchanged) pi.setActiveTools(nextActive);

  const status = getSubagentVersionStatus(pi);
  const honest = unavailable.length
    ? `${message}\nNot registered in this session: ${unavailable.join(", ")}.`
    : message;

  return { changed: !unchanged || disabledList.join(",") !== prev.sort().join(","), message: honest, status, disabled: disabledList };
}

/** Report the switch decision without mutating any tool state. */
export function describeSwitch(
  pi: { getActiveTools(): string[]; getAllTools?(): Array<{ name: string }> },
  disabled: Iterable<string>,
): { status: SubagentVersionStatus; effective: string[] } {
  const registeredTools = pi.getAllTools ? pi.getAllTools().map((t) => t.name) : [...ALL_DELEGATE_TOOLS];
  return {
    status: getSubagentVersionStatus(pi),
    effective: effectiveDisabled(disabled, registeredTools),
  };
}

export function parseSubagentsCommand(args: string): {
  action: "browse" | "gc" | "status" | "help" | VersionToggleAction | "save";
  raw: string;
} {
  const trimmed = args.trim().toLowerCase();
  if (!trimmed) return { action: "browse", raw: args };
  if (trimmed === "gc" || trimmed.startsWith("gc ")) return { action: "gc", raw: args };
  if (trimmed === "status") return { action: "status", raw: args };
  if (trimmed === "help" || trimmed === "--help" || trimmed === "-h") return { action: "help", raw: args };

  if (trimmed === "off" || trimmed === "v1 off") return { action: "v1-off", raw: args };
  if (trimmed === "on" || trimmed === "v1 on") return { action: "v1-on", raw: args };
  if (trimmed === "v2 off") return { action: "v2-off", raw: args };
  if (trimmed === "v2 on") return { action: "v2-on", raw: args };
  if (trimmed === "v2 only") return { action: "v2-only", raw: args };
  if (trimmed === "v1 only") return { action: "v1-only", raw: args };
  if (trimmed === "all on" || trimmed === "reset") return { action: "all-on", raw: args };
  if (trimmed === "save") return { action: "save", raw: args };

  return { action: "browse", raw: args };
}

export function isVersionSwitchCommand(args: string): boolean {
  const action = parseSubagentsCommand(args).action;
  return action === "status"
    || action === "help"
    || action === "save"
    || action === "v1-off"
    || action === "v1-on"
    || action === "v2-off"
    || action === "v2-on"
    || action === "v1-only"
    || action === "v2-only"
    || action === "all-on";
}

export function isToggleAction(action: string): action is VersionToggleAction {
  return action === "v1-off" || action === "v1-on" || action === "v2-off"
    || action === "v2-on" || action === "v1-only" || action === "v2-only"
    || action === "all-on";
}

export function getDefaultSettingsPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "settings.json");
}

export function saveSubagentVersion(
  target: "v1" | "v2" | "both" | "off",
  customPath?: string,
): { success: boolean; path: string; message: string } {
  const settingsPath = customPath || getDefaultSettingsPath();

  let settings: Record<string, any> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch (err: any) {
      return {
        success: false,
        path: settingsPath,
        message: `Failed to read existing settings at ${settingsPath}: ${err.message}`,
      };
    }
  }

  settings.subagentVersion = target;

  const tmpPath = `${settingsPath}.tmp.${Date.now()}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmpPath, settingsPath);
  } catch (err: any) {
    return {
      success: false,
      path: settingsPath,
      message: `Failed to write settings to ${settingsPath}: ${err.message}`,
    };
  }

  // The switch is a session decision; settings only choose the default. State the
  // asymmetry instead of implying /reload handles both directions.
  const note = target === "v1"
    ? "v1 set as default. Enabling v1 takes effect on /reload; disabling v2 needs a restart."
    : target === "v2"
    ? "v2 set as default. Enabling v2 takes effect on /reload; disabling v1 needs a restart."
    : target === "off"
    ? "Both set to OFF as default. Disabling needs a restart — /reload cannot unload an extension."
    : "Both v1 and v2 enabled (coexistence mode). /reload or restart Pi.";

  return {
    success: true,
    path: settingsPath,
    message: `Persisted subagentVersion: "${target}" in ${settingsPath}.\n${note}`,
  };
}
