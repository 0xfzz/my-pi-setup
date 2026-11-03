// A provider cache matches the longest unchanged prefix, so a byte that changes
// early re-bills everything after it. Everything an extension writes into the
// prompt above the messages must therefore be a pure function of state: same
// state, same bytes. A counter, a timestamp or a "N tools" line would look
// harmless and silently cost the whole prompt on every request.

import test from "node:test";
import assert from "node:assert/strict";
import dynamicPrompt from "../extensions/dynamic-prompt.ts";
import modes from "../extensions/modes.ts";
import todo from "../extensions/todo.ts";
import { PLAN_TOOL } from "../lib/todo-tools.ts";

const ACTIVE = ["read", "bash", "workflow_todo", "artifact_save"];

function fixture() {
  const hooks = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const branch: any[] = [];
  let active = [...ACTIVE];
  const pi: any = {
    on(name: string, fn: Function) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    registerFlag() {},
    registerEditorComponent() {},
    appendEntry(customType: string, data: any) { branch.push({ type: "custom", customType, data }); },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) { active = [...names]; },
    getAllTools: () => [...new Set([...active, ...tools.keys()])].map((name) => ({ name })),
  };
  const ctx: any = {
    mode: "tui",
    hasUI: false,
    isIdle: () => true,
    model: { provider: "anthropic", id: "claude-haiku-5-5", contextWindow: 200_000 },
    sessionManager: { getBranch: () => branch },
    ui: { notify() {}, setWidget() {}, setEditorComponent() {}, addAutocompleteProvider() {} },
  };
  for (const factory of [dynamicPrompt, modes, todo]) factory(pi);
  const emit = async (name: string, event: any) => {
    for (const hook of hooks.get(name) ?? []) await hook(event, ctx);
    return event;
  };
  return { emit };
}

const options = (): any => ({
  selectedTools: [...ACTIVE],
  sections: {} as Record<string, string>,
  toolGuidelines: {} as Record<string, string[]>,
});

test("the prompt prefix is byte-identical across two requests with unchanged state", async () => {
  const f = fixture();
  const first = await f.emit("before_agent_start", { systemPromptOptions: options() });
  const second = await f.emit("before_agent_start", { systemPromptOptions: options() });

  const rendered = JSON.stringify(first.systemPromptOptions);
  assert.equal(JSON.stringify(second.systemPromptOptions), rendered, "a byte here re-bills the whole prompt");
  assert.equal(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(rendered), false, "no timestamp belongs in the prefix");
  assert.match(first.systemPromptOptions.sections.input_mode, /Current input mode/);
  assert.ok(first.systemPromptOptions.toolGuidelines[PLAN_TOOL]?.length, "the guideline is really rendered");
});

test("the tool list order does not leak registration order into the prefix", async () => {
  const f = fixture();
  const forward = await f.emit("before_agent_start", { systemPromptOptions: options() });
  const reversed = fixture();
  const other = await reversed.emit("before_agent_start", {
    systemPromptOptions: { ...options(), selectedTools: [...ACTIVE].reverse() },
  });

  assert.equal(
    JSON.stringify(other.systemPromptOptions.sections),
    JSON.stringify(forward.systemPromptOptions.sections),
    "section text must not depend on the order Pi happens to list tools in",
  );
});
