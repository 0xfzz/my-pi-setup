/**
 * delegate-switch.ts — the single source of truth for "which delegation tools are
 * switched off in this session".
 *
 * Why this exists: the previous switch removed delegate names from whatever
 * `pi.getActiveTools()` happened to contain. That snapshot is NOT the session
 * baseline — it is the *current* loadout, which a restricted mode (Plan /
 * Supervise) has already narrowed. So:
 *
 *   - toggling inside a restricted mode wrote the restricted set back as the new
 *     normal loadout, permanently losing unrelated tools (including the
 *     smart-timeout `bash` override); and
 *   - leaving the restricted mode restored `previousTools`, which resurrected the
 *     delegate tools the user had just switched off.
 *
 * Both directions come from the same mistake: treating a mutable loadout as the
 * authoritative record. The fix is to record the *decision* (a set of disabled
 * delegate names) in the branch and derive every loadout from
 * `baseline − disabled`. Nothing outside the delegate lists is ever touched, so
 * `bash`, MCP tools, and other extensions cannot be collateral damage.
 */

/** v1 delegation surface (pi-herdr-subagents). */
export const V1_TOOLS = [
  "subagent",
  "subagent_resume",
  "subagent_interrupt",
  "subagents_list",
] as const;

/** v2 delegation surface (pi-subagent-v2). */
export const V2_TOOLS = [
  "orch_spawn",
  "orch_handoff",
  "orch_resume",
  "orch_interrupt",
  "orch_steer",
  "orch_route",
  "orch_running",
  "orch_review",
  "orch_escalate",
] as const;

export const ALL_DELEGATE_TOOLS = [...V1_TOOLS, ...V2_TOOLS] as const;

/** Branch custom-entry type holding the session's switch decision. */
export const DELEGATE_SWITCH_TYPE = "subagent-switch:v1";

export type VersionToggleAction =
  | "v1-on"
  | "v1-off"
  | "v2-on"
  | "v2-off"
  | "v1-only"
  | "v2-only"
  | "all-on";

export interface DelegateSwitchState {
  /** Delegate tool names the user switched off in this session. */
  disabled: Set<string>;
}

const V1 = new Set<string>(V1_TOOLS);
const V2 = new Set<string>(V2_TOOLS);
const ALL = new Set<string>(ALL_DELEGATE_TOOLS);

export function isDelegateTool(name: string): boolean {
  return ALL.has(name);
}

/** Read the newest switch decision from a session branch. Later entries win. */
export function switchStateFromBranch(branch: readonly any[] | undefined): DelegateSwitchState {
  for (let index = (branch?.length ?? 0) - 1; index >= 0; index--) {
    const entry = branch![index];
    if (entry?.type !== "custom" || entry.customType !== DELEGATE_SWITCH_TYPE) continue;
    const raw = entry.data?.disabled;
    return {
      disabled: new Set<string>(
        Array.isArray(raw)
          ? raw.filter((name: unknown): name is string => typeof name === "string" && ALL.has(name))
          : [],
      ),
    };
  }
  return { disabled: new Set() };
}

/**
 * Derive the next decision from the previous decision — never from the live
 * loadout. `registered` decides what "on" can actually mean, so an absent tool is
 * reported honestly instead of being claimed as enabled.
 */
export function nextDisabledSet(
  prev: Iterable<string>,
  action: VersionToggleAction,
  registered: Iterable<string> = ALL_DELEGATE_TOOLS,
): { disabled: Set<string>; message: string; unavailable: string[] } {
  const disabled = new Set<string>();
  for (const name of prev) if (ALL.has(name)) disabled.add(name);

  const registeredSet = new Set<string>(registered);
  const unavailableFor = (names: readonly string[]) => names.filter((name) => !registeredSet.has(name));

  const enable = (names: readonly string[]) => {
    for (const name of names) disabled.delete(name);
  };
  const disable = (names: readonly string[]) => {
    for (const name of names) disabled.add(name);
  };

  let message = "";
  let unavailable: string[] = [];

  switch (action) {
    case "v1-off":
      disable(V1_TOOLS);
      message = "v1 subagents turned OFF for this session.";
      break;
    case "v2-off":
      disable(V2_TOOLS);
      message = "v2 subagents turned OFF for this session.";
      break;
    case "v1-on":
      enable(V1_TOOLS);
      unavailable = unavailableFor(V1_TOOLS);
      message = unavailable.length
        ? `v1 turned ON, but these tools are not registered here: ${unavailable.join(", ")}.`
        : `v1 subagents turned ON (${V1_TOOLS.join(", ")}).`;
      break;
    case "v2-on":
      enable(V2_TOOLS);
      unavailable = unavailableFor(V2_TOOLS);
      message = unavailable.length
        ? `v2 turned ON, but these tools are not registered here: ${unavailable.join(", ")}.`
        : `v2 subagents turned ON (${V2_TOOLS.join(", ")}).`;
      break;
    case "v1-only":
      disable(V2_TOOLS);
      enable(V1_TOOLS);
      unavailable = unavailableFor(V1_TOOLS);
      message = "Switched to v1 only (v2 tools disabled).";
      break;
    case "v2-only":
      disable(V1_TOOLS);
      enable(V2_TOOLS);
      unavailable = unavailableFor(V2_TOOLS);
      message = "Switched to v2 only (v1 tools disabled).";
      break;
    case "all-on":
      disabled.clear();
      message = "All subagent tools turned ON for this session.";
      break;
  }

  return { disabled, message, unavailable };
}

/**
 * `baseline` filtered by the switch decision.
 *
 * Only names in `disabled` are removed. Everything else — `bash`, MCP tools,
 * deferred tools, other extensions' tools — passes through untouched, which is
 * the property the previous implementation violated.
 */
export function reconcileLoadout(baseline: Iterable<string>, disabled: Iterable<string>): string[] {
  const blocked = new Set(disabled);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of baseline) {
    if (seen.has(name) || blocked.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Names that are switched off AND registered — i.e. actually unavailable. */
export function effectiveDisabled(disabled: Iterable<string>, registered: Iterable<string>): string[] {
  const registeredSet = new Set(registered);
  return [...disabled].filter((name) => registeredSet.has(name)).sort();
}
