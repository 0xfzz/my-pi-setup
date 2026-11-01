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

/** Minimal shape the policy needs; satisfied by Pi's registered tool objects. */
export interface PolicyTool {
  name: string;
  exposure?: string;
  reachesTools?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/**
 * A tool that dispatches to OTHER tools rather than acting on its own.
 *
 * `reachesTools` is Pi's own signal for this and is exactly what the shipping
 * dispatchers declare: the `mcp` gateway (reaches every MCP tool), each namespace
 * proxy (`mcp__<server>`), the codemode bridge, and even `ask_user` (reaches
 * `agent_ping` when a child cannot ask directly). It may be a function returning
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
 * Delegation verbs that perform real work, or own a dedicated guard later in the
 * tool_call hook.
 *
 * `agent_spawn` and `agent_resume` make progress, so they must pass the workflow
 * assessment. `agent_done` reports completion, and the todo guard must see it to
 * refuse a report while todos are unresolved. Exempting it would make that guard
 * unreachable, because an exempt tool returns before the guard runs.
 */
