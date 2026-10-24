/**
 * Tool names for the workflow intent graph.
 *
 * Lives in `lib/` rather than in the extension so that policy modules and other
 * extensions classify todo calls without importing an extension module (which
 * would couple their load order to todo.ts).
 */

export const PLAN_TOOL = "todo_plan";
export const ACT_TOOL = "todo_act";
export const NEXT_TOOL = "todo_next";
/** v1 surface, still registered as a translating shim for one version. */
export const LEGACY_TOOL = "workflow_todo";

export const TODO_TOOL_NAMES: readonly string[] = [PLAN_TOOL, ACT_TOOL, NEXT_TOOL, LEGACY_TOOL];

export const isTodoTool = (name: string): boolean => TODO_TOOL_NAMES.includes(name);

/** True when the call can change the graph; `todo_next` only reads it. */
export const isTodoWriteTool = (name: string): boolean =>
  name === PLAN_TOOL || name === ACT_TOOL || name === LEGACY_TOOL;
