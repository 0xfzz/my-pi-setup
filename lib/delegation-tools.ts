/**
 * delegation-tools.ts — the single authority for the delegation tool surface.
 *
 * Before this module, the same capabilities were described in five places:
 * the old v1/v2 switch lists, `SUPERVISOR_TOOLS` (supervise-mode),
 * `NOT_ADMIN`/`isAdminTool` (tool-policy), `UNSAFE_TOOLS` (plan-mode), and
 * `SUBAGENT_CONTROL_TOOLS` (the launcher). A tool added to one list and forgotten
 * in another became a permission bypass or a silent capability gap.
 *
 * This file is DATA plus predicates. It registers nothing, imports nothing from
 * the extension layer, and has no side effects. C1 of the migration adds it
 * inert; later steps derive their lists from it and delete the duplicates.
 *
 * Rules encoded here:
 *
 *   - `orch_*` is the only canonical namespace.
 *   - A child session never holds a parent-role tool, at any depth.
 *   - A retired name (the old v1 surface) is never authorizable. The mapping is
 *     for reading persisted state, not for permitting a call.
 */

export type DelegationRole = "parent" | "child";

/** What a spawn is for. Drives the child's tool policy and mode admission. */
export type SpawnPurpose = "spec" | "adhoc" | "research" | "review" | "implementation";

export type DelegationVerb =
  | "handoff"
  | "spec-review"
  | "spawn"
  | "resume"
  | "interrupt"
  | "close"
  | "steer"
  | "route"
  | "list"
  | "brief"
  | "check"
  | "review"
  | "escalate"
  | "history"
  | "progress"
  | "done"
  | "ping"
  | "parent-recall"
  | "parent-digest"
  | "spec-review-submit";

export interface DelegationTool {
  /** Canonical name. Always `orch_`-prefixed. */
  readonly name: string;
  /** Which session may hold it. A child never holds a `parent` tool. */
  readonly role: DelegationRole;
  /** Whether Plan mode may keep it active (parent read-only surface). */
  readonly planSafe: boolean;
  /** Declared through `tool_search` instead of directly, when set. */
  readonly exposure?: "deferred";
  readonly verb: DelegationVerb;
}

/** Default nesting limit: a top-level session (depth 0) may spawn; its child may not. */
export const MAX_DELEGATION_DEPTH = 1;

const TOOLS: readonly DelegationTool[] = [
  // ── Parent: authoring, delegation, review ────────────────────────────────
  { name: "orch_handoff", role: "parent", planSafe: true, verb: "handoff" },
  { name: "orch_spec_review", role: "parent", planSafe: true, verb: "spec-review" },
  { name: "orch_spawn", role: "parent", planSafe: true, verb: "spawn" },
  { name: "orch_resume", role: "parent", planSafe: true, verb: "resume" },
  { name: "orch_interrupt", role: "parent", planSafe: true, verb: "interrupt" },
  { name: "orch_close", role: "parent", planSafe: true, verb: "close" },
  { name: "orch_steer", role: "parent", planSafe: true, verb: "steer" },
  { name: "orch_route", role: "parent", planSafe: true, verb: "route", exposure: "deferred" },
  { name: "orch_running", role: "parent", planSafe: true, verb: "list" },
  { name: "orch_brief", role: "parent", planSafe: true, verb: "brief" },
  { name: "orch_check", role: "parent", planSafe: true, verb: "check" },
  { name: "orch_review", role: "parent", planSafe: true, verb: "review" },
  { name: "orch_escalate", role: "parent", planSafe: true, verb: "escalate" },
  { name: "orch_history", role: "parent", planSafe: true, verb: "history" },

  // ── Child: report, ask, pull, submit ─────────────────────────────────────
  { name: "orch_progress", role: "child", planSafe: false, verb: "progress" },
  { name: "orch_done", role: "child", planSafe: false, verb: "done" },
  { name: "orch_ping", role: "child", planSafe: false, verb: "ping" },
  { name: "orch_parent_recall", role: "child", planSafe: false, verb: "parent-recall" },
  { name: "orch_parent_digest", role: "child", planSafe: false, verb: "parent-digest" },
  { name: "orch_spec_review_submit", role: "child", planSafe: false, verb: "spec-review-submit" },
];

export const DELEGATION_TOOLS: readonly DelegationTool[] = Object.freeze(
  TOOLS.map(tool => Object.freeze({ ...tool })),
);

const BY_NAME = new Map<string, DelegationTool>(DELEGATION_TOOLS.map(tool => [tool.name, tool] as const));

/**
 * The v1 surface, removed at C7/C8. Nothing is registered under these names.
 *
 * The guard refuses each of them at call time even when a foreign extension still
 * registers one, and `stripRetiredTools` removes them from a restored loadout so a
 * branch written before the migration cannot resurrect them.
 */
const RETIRED: readonly string[] = [
  "subagent",
  "subagent_resume",
  "subagent_interrupt",
  "subagents_list",
  "subagent_history",
  "subagent_progress",
  "subagent_done",
  "caller_ping",
  "parent_recall",
  "parent_digest",
  "spec_review_submit",
];

export const RETIRED_V1_TOOLS: ReadonlySet<string> = new Set(RETIRED);

/**
 * Retired name → canonical name.
 *
 * Read-only translation for persisted state (a switch decision, an old mode
 * snapshot). It is NOT an authorization path: `mayUseDelegationTool` refuses a
 * retired name outright.
 */
const RETIRED_TARGETS = new Map<string, string>([
  ["subagent", "orch_spawn"],
  ["subagent_resume", "orch_resume"],
  ["subagent_interrupt", "orch_interrupt"],
  ["subagents_list", "orch_running"],
  ["subagent_history", "orch_history"],
  ["subagent_progress", "orch_progress"],
  ["subagent_done", "orch_done"],
  ["caller_ping", "orch_ping"],
  ["parent_recall", "orch_parent_recall"],
  ["parent_digest", "orch_parent_digest"],
  ["spec_review_submit", "orch_spec_review_submit"],
]);

/**
 * Human-facing list of retired names, each paired with its live successor.
 *
 * A bare "spec_review_submit is unavailable" reads exactly like "the reviewer's
 * submit tool is gone": a reviewer whose submit call failed for an unrelated reason
 * (malformed JSON) concluded that and filed its report as an artifact instead. The
 * successor is what makes the sentence true and useful.
 */
export function describeRetiredTools(): string {
  return RETIRED.map((name) => {
    const target = RETIRED_TARGETS.get(name);
    return target ? `${name} (use ${target})` : name;
  }).join(", ");
}

function namesWhere(predicate: (tool: DelegationTool) => boolean): ReadonlySet<string> {
  return new Set(DELEGATION_TOOLS.filter(predicate).map(tool => tool.name));
}

export const PARENT_DELEGATION_TOOLS: ReadonlySet<string> = namesWhere(tool => tool.role === "parent");
export const CHILD_DELEGATION_TOOLS: ReadonlySet<string> = namesWhere(tool => tool.role === "child");
export const PLAN_SAFE_DELEGATION_TOOLS: ReadonlySet<string> = namesWhere(tool => tool.planSafe);
export const DEFERRED_DELEGATION_TOOLS: ReadonlySet<string> = namesWhere(tool => tool.exposure === "deferred");

/** Canonical delegation name, or undefined for a non-delegation name. */
export function delegationTool(name: string): DelegationTool | undefined {
  return BY_NAME.get(name);
}

/** True only for a canonical name. A retired name is not a tool any more. */
export function isDelegationTool(name: string): boolean {
  return BY_NAME.has(name);
}

export function isRetiredDelegationTool(name: string): boolean {
  return RETIRED_V1_TOOLS.has(name);
}

/**
 * Resolve a name in the canonical namespace.
 *
 * - canonical → itself
 * - retired → its canonical replacement (persisted-state reads only)
 * - unknown → undefined
 */
export function canonicalDelegationName(name: string): string | undefined {
  if (BY_NAME.has(name)) return name;
  return RETIRED_TARGETS.get(name);
}

/**
 * The one authorization predicate.
 *
 * Deliberately refuses a retired name: translating it here would keep the old
 * surface alive under a new label.
 */
export function mayUseDelegationTool(
  name: string,
  role: DelegationRole,
  depth = 0,
  maxDepth = MAX_DELEGATION_DEPTH,
): boolean {
  if (RETIRED_V1_TOOLS.has(name)) return false;
  const tool = BY_NAME.get(name);
  if (!tool) return false;
  if (tool.role !== role) return false;
  // Only spawning is depth-limited; listing or resuming at the limit is harmless.
  if (tool.verb === "spawn" && depth >= maxDepth) return false;
  return true;
}

/** Deduplicated canonical child-control names, sorted — the launcher allowlist input. */
export function childControlToolNames(): string[] {
  return [...CHILD_DELEGATION_TOOLS].sort();
}

/** Deduplicated canonical parent names, sorted. */
export function parentDelegationToolNames(): string[] {
  return [...PARENT_DELEGATION_TOOLS].sort();
}

/** Names Plan mode may keep active. */
export function planSafeDelegationToolNames(): string[] {
  return [...PLAN_SAFE_DELEGATION_TOOLS].sort();
}

/**
 * Remove retired names from a restored loadout or a persisted switch decision.
 *
 * Dropping (not translating) is the safe direction: activating a canonical tool a
 * session never had would widen its permissions.
 */
export function stripRetiredTools(names: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (RETIRED_V1_TOOLS.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
