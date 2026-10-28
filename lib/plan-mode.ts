/** Branch-local plan mode policy shared by modes, artifact storage, and autocomplete. */
import { isDispatcherTool } from "./tool-policy.ts";
import { PLAN_SAFE_DELEGATION_TOOLS } from "./delegation-tools.ts";

export const PLAN_MODE_TYPE = "input-plan-mode:v1";
/** Request-local briefing, not persisted policy or conversation history. */
export const INPUT_MODE_CONTEXT_TYPE = "input-mode-context:v1";
export interface PlanModeState {
  enabled: boolean;
  previousTools: string[];
}

export function planModeFromBranch(branch: readonly any[] | undefined): PlanModeState | undefined {
  for (let index = (branch?.length ?? 0) - 1; index >= 0; index--) {
    const entry = branch![index];
    if (entry.type !== "custom" || entry.customType !== PLAN_MODE_TYPE || typeof entry.data?.enabled !== "boolean") continue;
    return {
      enabled: entry.data.enabled,
      previousTools: Array.isArray(entry.data.previousTools)
        ? entry.data.previousTools.filter((name: unknown): name is string => typeof name === "string") : [],
    };
  }
}

/** A mode change is not recorded in Pi's tool transcript until the next AI run.
 * Recover an exit snapshot only in that gap; a later checkpoint is authoritative. */
export function pendingPlanExitTools(branch: readonly any[]): string[] | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if ((entry.type === "message" && entry.message?.role === "system")
      || (entry.type === "compaction" && entry.systemMessage)) return;
    if (entry.type === "custom" && entry.customType === PLAN_MODE_TYPE && typeof entry.data?.enabled === "boolean") {
      if (!entry.data.enabled && Array.isArray(entry.data.previousTools)) {
        return entry.data.previousTools.filter((name: unknown): name is string => typeof name === "string");
      }
      return;
    }
  }
}

/** Unresolved reconnections belong to the selected branch's latest mode record.
 * Unlike its exit snapshot, this intent survives later system checkpoints. */
export function pendingPlanDeferredTools(branch: readonly any[]): string[] {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type === "custom" && entry.customType === PLAN_MODE_TYPE && typeof entry.data?.enabled === "boolean") {
      return !entry.data.enabled && Array.isArray(entry.data.pendingTools)
        ? entry.data.pendingTools.filter((name: unknown): name is string => typeof name === "string") : [];
    }
  }
  return [];
}

/**
 * Tools trusted to stay read-only in Plan mode even without annotations.
 *
 * Membership here is an ALLOWLIST, not an assertion of presence. Plenty of these
 * tools are registered conditionally — `tool_search` by the MCP gateway,
 * `orch_running` only while the orchestrator extension is loaded, `google_search` only with the Antigravity
 * provider, and so on — so an absent name usually means "that feature is off",
 * not "someone renamed a tool". See `EXPECTED_PLAN_TOOLS` for the subset whose
 * absence really is a bug.
 */
export const PLAN_TOOLS: ReadonlySet<string> = new Set([
  // Delegation is read-only for the PARENT when it is research/review/spec work;
  // the child's purpose decides its tools, not the parent's mode. Taking this
  // from the capability table means a new plan-safe parent tool cannot be
  // forgotten here.
  ...PLAN_SAFE_DELEGATION_TOOLS,
  // `artifact_edit` is listed for the same reason as `artifact_save`: the sanctioned
  // write in Plan mode is editing workspace artifacts, and a partial edit is
  // strictly narrower than replacing a whole document. Both are artifact-scoped;
  // neither reaches the filesystem. `artifact_search` is read-only but is named
  // here explicitly so the intent survives a future annotation change.
  "artifact_list", "artifact_recall", "artifact_save", "artifact_edit", "artifact_search",
  "ask_user", "todo_plan", "todo_act", "todo_next", "workflow_todo", "session_goal",
  "read", "grep", "find", "ls", "ffgrep", "fffind", "bash",
  // `google_search` carries no readOnlyHint, so its explicit entry is load-bearing.
  // `fetch_content`/`source_check` are deliberately absent: they write page caches
  // and clone repositories, so their non-read-only annotation is honoured.
  "google_search", "web_search", "web_read", "vcc_recall", "orch_history", "orch_running", "tool_search",
  // The MCP resource tools are NOT listed: Pi declares all three with

  // `readOnlyHint: true`, so they pass through the annotation path, and they are
  // only registered when a connected server advertises resources. Listing them
  // made every session without an MCP resource server report false drift.
]);

/**
 * Allowlisted names whose absence indicates real drift rather than a disabled
 * feature: tools Pi always registers for every session.
 *
 * Kept deliberately small. A rename of one of these would silently narrow Plan
 * mode, which looks like a policy decision instead of a bug; a rename of anything
 * conditional is already visible as "that feature stopped working".
 */
export const EXPECTED_PLAN_TOOLS: ReadonlySet<string> = new Set([
  "read", "grep", "find", "ls", "bash",
]);

/** Allowlisted names that the session does not offer AND that should exist.
 *
 * Only `EXPECTED_PLAN_TOOLS` is reported, so conditionally registered tools do
 * not produce a warning in the common case where their feature is simply off.
 * Reported once on session start. */
export function missingPlanTools(available: Iterable<string>): string[] {
  const present = new Set(available);
  return [...EXPECTED_PLAN_TOOLS].filter(name => !present.has(name)).sort();
}
// Opaque script/gateway/delegation tools do not necessarily dispatch through
// ctx.executeTool. A readOnly hint must not open an unguarded alternate route.
// Names Pi always registers are listed here for defence in depth; a name that is
// NOT listed is covered by the dispatcher rule in `isPlanTool` below, so a new
// third-party gateway cannot slip through by declaring itself read-only.
const UNSAFE_TOOLS = new Set(["write", "edit", "powershell", "codemode", "mcp", "mcpScript", "browser", "browser_download", "browser_login", "generate_image"]);
export interface PlanToolInfo {
  name: string;
  exposure?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  /** Pi's own marker for a tool that invokes OTHER tools (gateways, proxies, bridges). */
  reachesTools?: unknown;
}
export function isPlanTool(name: string, tool?: PlanToolInfo): boolean {
  if (UNSAFE_TOOLS.has(name) || tool?.annotations?.destructiveHint === true) return false;
  // Explicit allowlisting wins, so `ask_user` stays usable even though it is a
  // dispatcher (it reaches `orch_ping` when a child cannot ask directly).
  if (PLAN_TOOLS.has(name)) return true;
  // A dispatcher invokes tools whose behaviour is not visible from here, so a
  // read-only claim on the dispatcher says nothing about what it actually runs.
  // Refuse it: `mcp` and `codemode` are named above, but any future gateway is
  // now covered without another edit to this file.
  if (isDispatcherTool(tool)) return false;
  return tool?.annotations?.readOnlyHint === true;
}

/** Always brief the current mode; absence of the old Plan section is too implicit. */
export function inputModeGuidance(mode: { id: string; label: string }): string {
  const current = `Current input mode: ${mode.label} (${mode.id}).`;
  if (mode.id === "plan") return `${current}
Plan mode is ON. Read-only exploration is allowed; writes are limited to artifacts. The workflow in plan_mode applies.`;
  return `${current}
Plan mode is OFF. Earlier Plan-mode restrictions and assistant statements claiming Plan is active are historical, not the current policy.
Use the currently available tools and normal permission rules. Artifact-only write limits no longer apply; implementation is allowed when requested. Do not ask the user to run /plan off again or refuse work just because an earlier turn was in Plan mode.
Normal mode supports regular AI chat, workspace inspection, implementation, and verification.`;
}

export const PLAN_MODE_GUIDANCE = `Plan mode is active: brainstorm and grill ideas, do not implement them.
Purpose: be a critical thinking partner, not an implementation agent. Help the user reach a clear, justified decision rather than rushing into tasks or code.
Read any files needed to understand the task, inspect the workspace, and use read-only search/research tools. There is no workspace path restriction on reads.
Do not write, edit, delete, rename, or otherwise modify files or external resources. The only content-write exception is creating and updating workspace artifacts through artifact_save and artifact_edit (not raw write/edit or an artifacts-named directory). Prefer artifact_edit for a change to part of an existing artifact: artifact_save replaces the entire content, so using it for a one-line fix forces the whole document to be reproduced exactly.
Workflow (adapt to the conversation; do not force a questionnaire or repeat already answered questions):
1. Clarify the goal, constraints, non-goals, and desired outcome. Ask focused questions one at a time when useful; do not invent answers or approvals.
2. Recall existing artifacts and inspect relevant files/references before relying on their content. Separate known facts from assumptions and unresolved questions.
3. Grill the idea: Challenge assumptions, expose risks, failure modes, edge cases, and success criteria. Be constructive, not argumentative.
4. Compare plausible alternatives and explain their trade-offs. Recommend an option only with a stated rationale and uncertainty.
5. Create or refine artifacts with proposals, agreed decisions, open questions, and refined plans. Preserve useful content and distinguish proposals from agreed decisions; suggestions are not approval. New artifact IDs are allowed.
6. Summarize decisions, unresolved blockers, and what would be needed for implementation. Stop before implementation; do not automatically leave Plan mode or launch work.
Use the available read-only tools, artifact_list, artifact_recall, artifact_search, artifact_save, and artifact_edit. ask_user and the todo tools (todo_plan, todo_act, todo_next) are conversation/workflow controls; todos describe research/discussion steps, and a todo title is never permission to implement.
Shell inspection is limited to supported read-only commands (including pipelines and cd path && command). No redirection, expansion, interpreters, installs, builds, tests that write, or arbitrary scripts. Use read/search tools for unsupported inspection commands. Unannotated third-party tools and opaque script/browser/MCP gateways are blocked unless their read-only behavior can be enforced; direct MCP tools explicitly annotated read-only are allowed. The orch_* parent delegation tools are allowed: delegate research or review, and spec work with a handoff. Ad-hoc and implementation delegation are refused until you leave Plan mode. Do not attempt another route around a blocked operation.
If no artifacts exist, create one with artifact_save when useful, or continue in chat. Read a long artifact by line range (artifact_recall offset/limit) and locate text in it with artifact_search instead of pulling the whole document. Only the user can leave this mode with /plan off or /mode normal, or Shift+Tab; do not claim to switch it yourself.
This workflow applies only while the live current-mode briefing says Plan is ON. The request-local current-input-mode reminder reflects the current branch policy and supersedes historical Plan instructions, assistant claims, and compaction summaries. When input_mode says Plan is OFF (also confirmed by the live reminder), follow the current mode instead.`;
