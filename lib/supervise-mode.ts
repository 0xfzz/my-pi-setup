/**
 * Supervise mode policy — what the orchestrator parent is allowed to do.
 *
 * The orchestrator has exactly two jobs:
 *
 *   1. Author handoff specs (`orch_handoff`) — state the goal, the acceptance
 *      criteria the review will demand evidence for, and the lane (the files this
 *      work unit owns).
 *   2. Review the result (`orch_review`) — gather evidence itself and record a
 *      verdict.
 *
 * It does not implement. That is not a stylistic preference: an orchestrator that
 * edits files while workers hold lanes produces diffs nobody owns, and the review
 * gate stops being independent of the work it reviews. The restriction is
 * structural (the tools are absent) as well as stated, because "please don't" in
 * a prompt is not a boundary.
 *
 * THIS FILE IS THE ONLY AUTHORITY. `extensions/modes.ts` installs the
 * `before_agent_start` section and the `tool_call` guard from here. There used to
 * be a second copy under `pi-subagent-v2/lib/` that listed `orch_handoff` and
 * `orch_escalate`; nothing imported it, so the live gate below was the one that
 * ran, and it was missing exactly those two tools. The orchestrator was handed
 * `orch_spawn` (whose `handoffId` is mandatory) while `orch_handoff` — the only
 * producer of a `handoffId` — was filtered out of its toolset. It then routed
 * around v2 entirely through the v1 `subagent` tool. `supervisorAllowlistGaps`
 * exists so a registered-but-unreachable delegation tool can never be silent
 * again.
 *
 * Reading is deliberately generous. A reviewer that cannot run `git diff` can only
 * trust the child's self-report, which defeats the point of having a reviewer.
 */
import { PLAN_TOOLS, type PlanToolInfo } from "./plan-mode.ts";
import { isDispatcherTool } from "./tool-policy.ts";
import { V1_TOOLS, V2_TOOLS } from "./delegate-switch.ts";

export const SUPERVISOR_MODE_ID = "supervise";
export const SUPERVISOR_MODE_TYPE = "input-supervise-mode:v1";

export interface SuperviseModeState {
  enabled: boolean;
  previousTools: string[];
  /**
   * Which user-facing entry created this policy: `supervise` or `orchestrator`.
   * Both are the same restrictions, but the tab bar has to redraw the one the
   * user actually selected after a reload or tree navigation. Absent on entries
   * written before the two were separated; those restore as `supervise`.
   */
  modeId?: string;
}

export function superviseModeFromBranch(branch: readonly any[] | undefined): SuperviseModeState | undefined {
  for (let index = (branch?.length ?? 0) - 1; index >= 0; index--) {
    const entry = branch![index];
    if (entry.type !== "custom" || entry.customType !== SUPERVISOR_MODE_TYPE || typeof entry.data?.enabled !== "boolean") continue;
    return {
      enabled: entry.data.enabled,
      previousTools: Array.isArray(entry.data.previousTools)
        ? entry.data.previousTools.filter((name: unknown): name is string => typeof name === "string")
        : [],
      modeId: entry.data.modeId === "orchestrator" || entry.data.modeId === "supervise" ? entry.data.modeId : undefined,
    };
  }
}

/**
 * Tools the orchestrator may call.
 *
 * `orch_handoff` is listed first because authoring the spec is the primary act;
 * spawning is downstream of it. `orch_escalate` is the ladder's middle rung: a
 * child that is unsure pings, and the orchestrator either answers from context it
 * actually has or hands the decision to the user. Without it the ladder is broken
 * at exactly the rung the orchestrator occupies.
 *
 * Inherits `PLAN_TOOLS`, which supplies the read-only inspection surface
 * (`read`, `grep`, `bash`, …) the review depends on. `bash` is narrowed per
 * invocation by the mode's `tool_call` hook via `readOnlyShellCommand`.
 */
export const SUPERVISOR_TOOLS: ReadonlySet<string> = new Set([
  // ── Authoring, delegation, review (v2) ──────────────────────────────────
  "orch_handoff",
  "orch_escalate",
  "orch_spawn",
  "orch_resume",
  "orch_interrupt",
  "orch_steer",
  "orch_route",
  "orch_running",
  "orch_review",
  // ── Delegation (v1) ────────────────────────────────────────────────────
  // Coexistence is supported, so v1 stays reachable while it is switched on.
  // `isSupervisorTool` additionally honours the session's delegate switch, so
  // `/subagents v2-only` removes these here too instead of leaving a v1 bypass
  // of handoff specs, lane isolation, and the escalation ladder.
  ...V1_TOOLS,
  // ── Review instruments and coordination ────────────────────────────────
  "read",
  "grep",
  "find",
  "ls",
  "ffgrep",
  "fffind",
  "vcc_recall",
  "web_read",
  "google_search",
  "tool_search",
  "bash",
  "artifact_save",
  "artifact_recall",
  "artifact_edit",
  "artifact_search",
  "artifact_list",
  "todo_plan",
  "todo_act",
  "todo_next",
  "workflow_todo",
  "ask_user",
  "subagent_history",
  "subagent_progress",
  "parent_recall",
  "parent_digest",
  "caller_ping",
]);

/** Alias kept for callers that used the older name. */
export const SUPERVISOR_ALLOWED_TOOLS = SUPERVISOR_TOOLS;

/**
 * Denied even though some look "read-ish": they reach other tools whose behaviour
 * is not visible here, or they write to the world outside the repository.
 */
export const SUPERVISOR_DENIED_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "powershell",
  "codemode",
  "mcp",
  "mcpScript",
  "browser",
  "browser_download",
  "browser_login",
  "browser_evidence",
  "browser_visibility",
  "generate_image",
]);

export interface SupervisorToolOptions {
  /**
   * Delegate tools this session switched off via `/subagents`. Supervise mode
   * must not resurrect them: the switch is a user decision, and a mode change is
   * not consent to undo it.
   */
  disabledDelegates?: ReadonlySet<string>;
  /**
   * Whether the full v2 delegation surface is available for this session.
   *
   * When it is, v1 delegation is withheld in supervise mode. Otherwise v1 is a
   * permanent bypass of everything this mode is for: a v1 child gets a bare
   * `task` string (no handoff spec, no lane), sits in a shared artifact catalog
   * (no scope isolation), and has no escalation ladder back to the orchestrator.
   * That is not hypothetical — the debug session that motivated this rule
   * side-stepped the broken v2 surface by calling v1 `subagent`, and the spec
   * ended up in the global catalog precisely as concept isolation forbids.
   *
   * Withholding is conditional so v1 remains usable when v2 is not installed, or
   * when the user deliberately selects it (`/subagents v1-only`, `v2-off`).
   */
  v2DelegationAvailable?: boolean;
}

/** Delegation tool sets, so the mode can reason about which version it is gating. */
export const V1_DELEGATE_TOOLS: ReadonlySet<string> = new Set(V1_TOOLS);
export const V2_DELEGATE_TOOLS: ReadonlySet<string> = new Set(V2_TOOLS);

/**
 * Whether v2 delegation is fully usable: every v2 tool is registered and none has
 * been switched off.
 *
 * Derived from registration plus the switch decision rather than from the active
 * set, because the active set is itself being rewritten by this mode.
 */
export function v2DelegationInForce(
  registered: Iterable<string>,
  disabled?: ReadonlySet<string>,
): boolean {
  const present = new Set(registered);
  return V2_TOOLS.every((name) => present.has(name) && !disabled?.has(name));
}

export function isSupervisorTool(
  name: string,
  tool?: PlanToolInfo,
  options?: SupervisorToolOptions,
): boolean {
  if (SUPERVISOR_DENIED_TOOLS.has(name) || tool?.annotations?.destructiveHint === true) return false;
  // Opaque gateways dispatch to tools this policy never sees.
  if (name.startsWith("browser_") || name.startsWith("mcp__")) return false;
  if (options?.disabledDelegates?.has(name)) return false;
  // v1 delegation is withheld while v2 is fully available; see the option's doc.
  if (V1_DELEGATE_TOOLS.has(name)) return options?.v2DelegationAvailable !== true;
  if (SUPERVISOR_TOOLS.has(name)) return true;
  if (isDispatcherTool(tool)) return false;
  // Trust an explicit read-only claim for tools this package does not know about
  // (an MCP server's read tool, for example). The mode hook still gates bash.
  return tool?.annotations?.readOnlyHint === true;
}

/**
 * Delegation tools that are registered for this session but unreachable in
 * supervise mode.
 *
 * This is the invariant that broke: `orch_handoff` and `orch_escalate` were
 * registered (Pi listed them in the pre-mode loadout) while the allowlist above
 * omitted them, so the orchestrator silently lost its authoring and escalation
 * tools and worked around v2 with the v1 `subagent` tool. A rename in either
 * package reopens the same hole, and an empty result here is the only thing that
 * proves it is closed.
 *
 * Only names actually registered are checked, so a package that is not loaded
 * does not report false drift.
 *
 * `delegationTools` and `allowed` are injectable so the detector itself can be
 * tested. Without that seam the test would only assert "no gaps today" and would
 * pass even if the comparison were a no-op.
 */
export function supervisorAllowlistGaps(
  registered: Iterable<string>,
  delegationTools: readonly string[] = [...V2_TOOLS, ...V1_TOOLS],
  allowed: ReadonlySet<string> = SUPERVISOR_TOOLS,
): string[] {
  const present = new Set(registered);
  const gaps: string[] = [];
  for (const name of delegationTools) {
    if (!present.has(name)) continue;
    if (!allowed.has(name)) gaps.push(name);
  }
  return gaps.sort();
}

/** Delegation tools that are always registered when the package is present. */
export const EXPECTED_SUPERVISOR_TOOLS: ReadonlySet<string> = new Set([
  "orch_handoff",
  "orch_spawn",
  "orch_review",
  "orch_escalate",
]);

export const SUPERVISOR_MODE_GUIDANCE = `Supervise mode is active: you are the orchestrator parent. You do not implement.

Two jobs, in order:

1. AUTHOR A HANDOFF SPEC (orch_handoff) for each work unit. A spec states:
   - the goal, in one line
   - acceptance criteria, each of which the review will require evidence for
   - the lane: exactly which files this work unit owns
   - out-of-lane files it must not touch
   - interfaces it must honour, so parallel work units still fit together
   An empty or vague lane means the child owns the whole repository, and then
   neither steering nor review can be precise. Reject your own draft.

2. REVIEW THE RESULT (orch_review). For each criterion, gather evidence yourself
   with read/bash (git diff, git status) — the child's claim is not evidence.
   Check the diff stayed inside the lane. An outside-lane change is a violation
   regardless of quality. Then record a verdict. An approval with a failing
   criterion is refused, so do not try to record one.

Delegation:
- orch_spawn requires a handoffId. A child receives exactly one inlined spec: no
  sibling scope name, no sibling path, no directory it could enumerate.
- orch_route resolves a correction to its owning work unit deterministically. If
  nothing matches, or two things match, it escalates instead of guessing.
- Two children cannot share a scope. Two writers in one lane produce a diff
  nobody owns.

Escalation ladder (child → orchestrator → user):
- A child that is unsure pings; its session pauses and the ping arrives here.
- Answer with orch_escalate when you genuinely know the answer from context you
  have. If you do not, escalate to the user with your reason.
- You may not answer a question you already escalated.
- A cancelled or blank dialog is NOT consent. Resume the child with cancel so it
  reports the blocker, rather than inventing a decision for it.

Direct file edits (edit, write), browser tools, and opaque gateways are disabled.
Shell commands are restricted to read-only inspection. /mode normal to exit.`;
