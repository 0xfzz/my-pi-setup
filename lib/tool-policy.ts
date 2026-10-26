/**
 * Registry-derived tool classification shared by the workflow guardrail and the
 * mode policies.
 *
 * The rule this file encodes: never decide what a tool IS from a name baked into
 * source. Tools are registered conditionally and by third parties — `subagent_*`
 * only inside Herdr, `tool_search` only when the MCP gateway is loaded, every MCP
 * tool only when its server answers — so a hardcoded list drifts into blocking
 * capabilities that exist purely because the list went stale. The one place a
 * name is unavoidable is Pi's own builtins, which are stable and are treated as
 * such below.
 */

import { delegationTool } from "./delegation-tools.ts";

/** Minimal shape the policy needs; satisfied by Pi's registered tool objects. */
export interface PolicyTool {
  name: string;
  exposure?: string;
  reachesTools?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/**
 * Any MCP-provided tool.
 *
 * Covers all three shipping shapes: a bare server proxy (`mcp__github`), a
 * namespaced tool (`mcp__github__create_issue`), and the singular gateway
 * (`mcp`). These are user-configured capabilities: the user deliberately
 * connected the server, so blocking them is never the harness's call.
 */
export function isMcpTool(name: string): boolean {
  return name === "mcp" || name.startsWith("mcp__") || name.startsWith("mcp_");
}

/**
 * A tool that dispatches to OTHER tools rather than acting on its own.
 *
 * `reachesTools` is Pi's own signal for this and is exactly what the shipping
 * dispatchers declare: the `mcp` gateway (reaches every MCP tool), each namespace
 * proxy (`mcp__<server>`), the codemode bridge, and even `ask_user` (reaches
 * `orch_ping` when a child cannot ask directly). It may be a function returning
 * target names, or a literal like "all"; both mean the same thing here — invoking
 * this tool invokes something else, so the caller cannot judge the real effect
 * from this tool's own name or annotations.
 *
 * The name says "dispatcher", not "gateway", because the single-target case is
 * real: a dispatcher is not necessarily opaque, and treating every dispatcher as
 * an opaque gateway was wrong.
 */
export function isDispatcherTool(tool: PolicyTool | undefined): boolean {
  if (!tool) return false;
  const reaches = tool.reachesTools;
  if (typeof reaches === "function") return true;
  return typeof reaches === "string" || Array.isArray(reaches);
}

/**
 * Tools that LOOK administrative but are not, because each one either performs real
 * work or owns a dedicated guard later in the tool_call hook.
 *
 *  - `subagent` spawns work, so it must pass the workflow assessment.
 *  - `subagent_resume` restarts real work in a child.
 *  - `orch_done` reports completion, and the todo guard must see it to refuse a
 *    report while todos are unresolved. Exempting it would make that guard unreachable,
 *    because an exempt tool returns before the guard runs.
 *
 * The same rule follows the canonical names through `delegation-tools.ts`: renaming
 * `subagent_history` to `orch_history` must not silently turn a coordination tool
 * into gated work, and `orch_spawn`/`orch_resume`/`orch_done` must stay gated
 * exactly like their predecessors.
 */
const NOT_ADMIN: ReadonlySet<string> = new Set(["subagent", "subagent_resume", "subagent_done"]);

/** Delegation verbs that perform real work, or own a guard further down the hook. */
const WORK_DELEGATION_VERBS: ReadonlySet<string> = new Set(["spawn", "resume", "done"]);

function isWorkDelegation(name: string): boolean {
  const tool = delegationTool(name);
  return tool ? WORK_DELEGATION_VERBS.has(tool.verb) : false;
}

/**
 * A tool that is callable but is NOT itself work: it clarifies, discovers, monitors,
 * or steers.
 *
 * Matched by SHAPE rather than a fixed list, so a delegation extension adding a new
 * lifecycle tool is classified without a code change. The work verbs are named
 * explicitly, and covered by tests, because getting this wrong either blocks real
 * work or silently disables a guard.
 */
export function isAdminTool(name: string): boolean {
  if (NOT_ADMIN.has(name) || isWorkDelegation(name)) return false;
  if (/^subagents?_/.test(name)) return true;
  if (delegationTool(name)) return true; // orch_* coordination and reporting verbs
  return /^(caller_ping|ask_user|tool_search|mcpScript)$/.test(name);
}

/**
 * Should this tool bypass the "assess before working" gate?
 *
 * Yes for anything that cannot make progress on its own — clarification, discovery,
 * lifecycle control, a gateway, or a user-configured MCP tool. No for real work,
 * which is the whole point of asking the model to assess first.
 */
export function isGateExempt(tool: PolicyTool | undefined): boolean {
  if (!tool) return false;
  return isAdminTool(tool.name) || isMcpTool(tool.name) || isDispatcherTool(tool);
}

/**
 * Read-only verdict for Plan mode, honouring explicit deny signals.
 *
 * `destructiveHint` outranks `readOnlyHint` because a tool that claims both is
 * either misconfigured or lying, and the safe reading of an ambiguous write is a
 * write. Unannotated and opaque tools are refused: this is the same reason the
 * plan policy blocks gateways, since their behaviour cannot be enforced.
 */
export function isReadOnlyTool(tool: PolicyTool | undefined): boolean {
  if (!tool) return false;
  if (tool.annotations?.destructiveHint === true) return false;
  return tool.annotations?.readOnlyHint === true;
}

/** Resolve `name` against a registry list, for callers holding only the name. */
export function findTool(tools: readonly PolicyTool[], name: string): PolicyTool | undefined {
  return tools.find(tool => tool.name === name);
}
