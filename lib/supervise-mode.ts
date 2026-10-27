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
 * producer of a `handoffId` — was filtered out of its toolset. `supervisorAllowlistGaps`
 * exists so a registered-but-unreachable delegation tool can never be silent
 * again. The v1 bypass that incident used (`subagent`) has since been removed;
 * the delegation surface is `orch_*` only.
 *
 * Reading is deliberately generous. A reviewer that cannot run `git diff` can only
 * trust the child's self-report, which defeats the point of having a reviewer.
 */
import { PLAN_TOOLS, type PlanToolInfo } from "./plan-mode.ts";
import { readOnlyShellCommand } from "./plan-shell.ts";
import { isDispatcherTool } from "./tool-policy.ts";
import { parentDelegationToolNames } from "./delegation-tools.ts";

export const SUPERVISOR_MODE_ID = "supervise";
export const SUPERVISOR_MODE_TYPE = "input-supervise-mode:v1";

/**
 * There is one capability: review-only.
 *
 * A `full` variant was implemented and removed. It widened the allowlist to
 * write/edit/browser while the review gate compensated with verified evidence,
 * computed lanes and spec freeze — but a widened allowlist does not buy review
 * quality, it buys implementation quality the parent should have delegated. The
 * measured trade-off (see artifact `orchestrator-review-vs-full-evidence`: 8.55
 * vs 5.75, and 5 of 7 scenarios) put independence, cost and blast radius ahead of
 * the parent's own editing, and independence is only free when the reviewer
 * cannot produce the artifact it judges.
 *
 * Old branch entries that carry `capability: "full"` are accepted and ignored:
 * a session written before this change must not resurrect the branch, and tool
 * availability is now decided by the allowlist alone.
 *
 * The control-plane path guard (`lib/orchestrator/control-plane.ts`) still
 * applies: forging the registry, a transcript, or an exit sidecar was never a
 * capability question.
 */

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
 *
 * This is the PERMISSION set. It is wider than the declared loadout only by
 * `DEFERRED_ORCH_TOOLS` — the tools this package registers with
 * `exposure: "deferred"`. Permission is enforced at call time by the `tool_call`
 * guard either way, and `tool_search` can genuinely return a deferred tool,
 * which it cannot do for a `direct` one the mode stopped declaring.
 */
export const SUPERVISOR_TOOLS: ReadonlySet<string> = new Set([
  // ── Authoring, delegation, review (v2) ──────────────────────────────────
  "orch_handoff",
  "orch_escalate",
  "orch_spawn",
  "orch_resume",
  "orch_interrupt",
  "orch_steer",
  "orch_close",
  "orch_route",
  "orch_running",
  "orch_brief",
  "orch_check",
  "orch_review",
  // Independent specification review — the gate that runs before a worker exists.
  "orch_spec_review",
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
  "session_goal", // Conversation metadata, not a source-code mutation.
  "ask_user",
  "orch_history",
  "orch_progress",
  "orch_parent_recall",
  "orch_parent_digest",
  "orch_ping",
]);

/** Alias kept for callers that used the older name. */
export const SUPERVISOR_ALLOWED_TOOLS = SUPERVISOR_TOOLS;

/**
 * The Orchestrator/Supervise parent gets the same read-only shell grammar as Plan.
 *
 * The header of this module says the orchestrator does not implement, and
 * `extensions/orchestrator.ts` says it "has no edit/write tool". Both were false
 * while bash accepted any command: session `01a17cb6` wrote
 * `docs/refactor/phase-1-contract.md` with a bash heredoc and then reviewed its
 * own document. A mode that claims not to implement cannot hand itself a
 * general shell.
 *
 * `readOnlyShellCommand` is a closed command grammar (no redirection, heredoc,
 * expansion, executable pipelines or unknown commands), not a sandbox. It is the
 * same boundary Plan mode already relies on, and it is the boundary the review
 * loop actually needs: `orch_check` runs the verification command itself, and
 * `git`/`rg`/`cat`/`find` cover inspection.
 */
export function superviseShellCommand(command: unknown): string | undefined {
  return readOnlyShellCommand(command);
}

/**
 * The hot path: the tools the review loop calls, which are never deferred.
 *
 * This is NOT the declared set. Declaration is "everything allowed, except the
 * tools registered with `deferred` exposure" — see `restrictSuperviseTools` in
 * `extensions/modes.ts`. An earlier revision made this list the declared set and
 * that was wrong, for a reason the transcripts prove:
 *
 *   pi's `tool_search` only indexes tools that are undeclared *because of their
 *   exposure* (`deferred`, `codemode`). A `direct`-exposure tool that
 *   `setActiveTools` removed is invisible to it — permanently. In session
 *   `01a16c5b` the orchestrator asked `tool_search` for a spawn tool thirteen
 *   times and got "No matching tools found" thirteen times, because the mode had
 *   just un-declared it. "Search for it" is not a fallback for a tool you took
 *   away; it is only a fallback for a tool that was never declared on purpose.
 *
 * So the only tools this package may withhold are the ones it registers itself
 * with `exposure: "deferred"` (`DEFERRED_ORCH_TOOLS`), because those are the only
 * ones `tool_search` can genuinely return. Everything else the mode permits stays
 * declared, and the token win comes from the cost of the *review* (packet, check,
 * compact verdict), not from hiding instruments the loop may need.
 */
export const CORE_REVIEW_TOOLS: ReadonlySet<string> = new Set([
  // The loop: author → spawn → observe → verify → judge.
  "orch_handoff",
  "orch_spawn",
  "orch_resume",
  "orch_running",
  "orch_brief",
  "orch_check",
  "orch_review",
  // Independent specification review: the gate that runs before a worker exists.
  "orch_spec_review",
  // Move a child: queue a note, interrupt, end it.
  "orch_steer",
  "orch_interrupt",
  "orch_close",
  "orch_escalate",
  // Inspect what the packet flagged.
  "read",
  "grep",
  "bash",
  // Persist the verdict, ask the user the one question that decides it.
  "artifact_save",
  "ask_user",
  // The escape hatch for deferred tools.
  "tool_search",
]);

/**
 * Tools this package registers with `exposure: "deferred"`.
 *
 * Declared nowhere, discoverable by `tool_search`, and still permission-checked
 * at call time. Only names this package owns may appear here: a host tool
 * (`read`, `artifact_recall`, `find`, …) is registered by another extension with
 * `direct` exposure, and there is no supported way to defer it from here — so
 * deferring one would make it permanently unreachable, which is exactly the bug
 * this list exists to prevent.
 */
export const DEFERRED_ORCH_TOOLS: ReadonlySet<string> = new Set(["orch_route"]);

/** Whether a name is one this package defers (and therefore may withhold). */
export function isDeferredOrchTool(name: string): boolean {
  return DEFERRED_ORCH_TOOLS.has(name);
}

/**
 * Allowed but not declared, and genuinely reachable through `tool_search`.
 *
 * Deliberately smaller than "allowed minus core": that larger set was the bug.
 */
export function deferredOrchTools(): string[] {
  return [...DEFERRED_ORCH_TOOLS].filter((name) => !CORE_REVIEW_TOOLS.has(name)).sort();
}

/**
 * Denied even though some look "read-ish": they reach other tools whose behaviour
 * is not visible here, or they write to the world outside the repository.
 */
/**
 * Opaque gateways: tools whose real arguments are executed by another layer.
 * The `tool_call` guard cannot inspect the inner call, and the control-plane path
 * guard is equally blind, so a dispatcher would be an unguarded path to the
 * review's own instruments.
 */
const DISPATCHER_NAMES: ReadonlySet<string> = new Set(["codemode", "mcp", "mcpScript", "mcp_call", "mcp_call_tool"]);

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
}

export function isSupervisorTool(
  name: string,
  tool?: PlanToolInfo,
  options?: SupervisorToolOptions,
): boolean {
  if (options?.disabledDelegates?.has(name)) return false;
  if (SUPERVISOR_DENIED_TOOLS.has(name) || tool?.annotations?.destructiveHint === true) return false;
  // A dispatcher executes tools this policy never sees, so neither the
  // allowlist nor the control-plane path guard can inspect what it runs.
  if (DISPATCHER_NAMES.has(name)) return false;
  // Opaque gateways dispatch to tools this policy never sees.
  if (name.startsWith("browser_") || name.startsWith("mcp__")) return false;
  if (SUPERVISOR_TOOLS.has(name)) return true;
  if (isDispatcherTool(tool)) return false;
  // Trust an explicit read-only claim for tools this package does not know about
  // (an MCP server's read tool, for example). The mode hook still gates bash.
  return tool?.annotations?.readOnlyHint === true;
}

/**
 * The names to declare in supervise mode.
 *
 * Everything the mode permits, minus tools registered with `deferred` (or
 * `hidden`) exposure. Exported so the declaration rule can be tested directly,
 * rather than inferred from a session's active set.
 *
 * The rule this protects: withholding a `direct`-exposure tool is irreversible.
 * `tool_search` indexes undeclared tools *by exposure*, so a `direct` tool that
 * `setActiveTools` dropped is unreachable for the rest of the session. Only a
 * `deferred` tool is both undeclared and findable — which is why only the tools
 * this package registers that way may be withheld.
 */
export function declaredSuperviseTools(
  tools: ReadonlyArray<{ name: string; exposure?: string } & PlanToolInfo>,
  options?: SupervisorToolOptions,
): string[] {
  return tools
    .filter((tool) => tool.exposure !== "hidden" && tool.exposure !== "deferred" && isSupervisorTool(tool.name, tool, options))
    .map((tool) => tool.name);
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
  delegationTools: readonly string[] = parentDelegationToolNames(),
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
  "orch_running",
  "orch_brief",
  "orch_check",
  "orch_review",
  "orch_spec_review",
  "orch_escalate",
]);

/**
 * The orchestrator briefing.
 *
 * is a token the model pays for each turn. It says only what the machinery cannot
 * enforce — role, loop, and the rules whose violation the gate would refuse
 * anyway. Everything else is the gate's job (verified evidence, computed lane,
 * frozen criteria, control-plane paths).
 *
 * A test keeps it under a line/character budget, so this cannot quietly grow back
 * into the essay it replaced.
 */
export const SUPERVISOR_MODE_GUIDANCE = `You are the orchestrator as product manager: author the spec, delegate, then judge results. You do not implement.

- Spec: one devil's advocate, once. orch_spec_review (single) -> resolve findings (fix/accept/contest) -> re-author with designRef.
- Execute: orch_handoff per unit (goal, testable criteria, lane it owns; no whole-repo lane, no shared scope) -> orch_spawn in parallel lanes. The spec is frozen; never re-review it.
- QA: per completed worker spawn one QA child (purpose "review", qaFor "<scope>"). Defect ping -> todo_plan ticket (resource file:<file>), claim it, spawn a fix, resume the QA; pass -> todo_act done with evidence, fail -> todo_act failed (twice -> ask_user).

Waiting: after any spawn, review start, answer or ticket step, END YOUR TURN; you are re-triggered by completion, a child question, or a watchdog notice. Never sleep or poll.

- orch_brief is the packet; orch_check runs the declared command and returns evidenceRefs you can cite. "not run" means no evidence - say so.
- Prose is not evidence; a missing citation is refused. Lane drift is a violation: verdict "revise", never "approved", recorded with orch_review.
- bash/python/node are read-only. Delegate changes.
- Unsure: orch_escalate, then ask_user; a cancelled dialog is not consent.
- Approve only on evidence you gathered. /mode normal to implement.`;
