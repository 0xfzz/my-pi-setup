/**
 * Availability policy: the agent must be able to call every tool that is actually
 * registered — including MCP tools and third-party dispatchers — while each input
 * mode keeps its own restrictions.
 *
 * These tests exist because the previous implementation answered "may this tool
 * run?" from a hardcoded name list. That list could not include MCP tools (they
 * appear only while a server answers, and their names are not knowable in source),
 * so deliberately configured capabilities were blocked and the block looked like a
 * policy decision. The tests pin the two halves apart:
 *
 *   - `gateExempt`     — availability before assessment (normal mode)
 *   - `isPlanTool`     — mode-sensitive restriction (plan mode)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isAdminTool, isDispatcherTool, isGateExempt, isMcpTool, isReadOnlyTool, findTool } from "../lib/tool-policy.ts";
import { isPlanTool, PLAN_MODE_TYPE } from "../lib/plan-mode.ts";
import todo from "../extensions/todo.ts";
import modes from "../extensions/modes.ts";

// ---------------------------------------------------------------- pure policy

test("every MCP tool shape is recognised, and nothing else is", () => {
  for (const name of ["mcp", "mcp__local_mcp", "mcp__github__create_issue", "mcp__docs__search", "mcp_script"]) {
    assert.equal(isMcpTool(name), true, name);
  }
  // Near-misses must not be swept in: a tool that merely starts with "mc" is not MCP.
  for (const name of ["read", "bash", "mcproxy", "mcpX", "subagent", "codemode"]) {
    assert.equal(isMcpTool(name), false, name);
  }
});

test("dispatchers are identified by Pi's own reachesTools marker, not by name", () => {
  assert.equal(isDispatcherTool({ name: "mcp", reachesTools: "all" }), true, "literal marker");
  assert.equal(isDispatcherTool({ name: "mcp__local_mcp", reachesTools: () => ["mcp__local_mcp"] }), true, "function marker");
  assert.equal(isDispatcherTool({ name: "ask_user", reachesTools: () => ["caller_ping"] }), true);
  assert.equal(isDispatcherTool({ name: "brand_new_gateway", reachesTools: () => [] }), true, "a gateway we have never heard of");
  assert.equal(isDispatcherTool({ name: "read" }), false);
  assert.equal(isDispatcherTool(undefined), false, "an unregistered tool cannot be classified");
});

test("admin tools are matched by shape so a new lifecycle tool needs no code change", () => {
  for (const name of ["subagent_interrupt", "subagent_progress", "caller_ping", "ask_user", "tool_search", "subagent_abort", "subagent_steer"]) {
    assert.equal(isAdminTool(name), true, name);
  }
  // These DO work, or own a dedicated guard, and must therefore still reach the
  // tool_call logic below the gate. Getting this list wrong is not cosmetic:
  // `subagent_done` is guarded later in the hook, so exempting it made that guard
  // unreachable dead code (caught by tests/todo.test.ts).
  for (const name of ["subagent", "subagent_resume", "subagent_done", "bash", "edit", "workflow_todo"]) {
    assert.equal(isAdminTool(name), false, name);
  }
});

test("canonical orch_* classification matches the v1 verbs it replaced", () => {
  // Coordination, inspection and reporting verbs are gate-exempt.
  for (const name of [
    "orch_handoff", "orch_spec_review", "orch_interrupt", "orch_close", "orch_steer",
    "orch_route", "orch_running", "orch_brief", "orch_check", "orch_review",
    "orch_escalate", "orch_history", "orch_progress", "orch_ping",
    "orch_parent_recall", "orch_parent_digest", "orch_spec_review_submit",
  ]) {
    assert.equal(isAdminTool(name), true, name);
  }
  // Spawning, resuming and completion reporting perform work (or own a later guard).
  for (const name of ["orch_spawn", "orch_resume", "orch_done"]) {
    assert.equal(isAdminTool(name), false, name);
    assert.equal(isGateExempt({ name }), false, `${name} stays assessed/guarded`);
  }
  assert.equal(isGateExempt({ name: "orch_history" }), true, "history is a read instrument");
  assert.equal(isGateExempt({ name: "orch_progress" }), true, "progress is not work");
});

test("gate exemption covers configured capabilities but never turns unknown names into permissions", () => {
  const mcpTool = { name: "mcp__github__create_issue" };
  const gateway = { name: "some_gateway", reachesTools: () => ["a", "b"] };
  assert.equal(isGateExempt(mcpTool), true, "user-connected MCP tool");
  assert.equal(isGateExempt(gateway), true, "dispatcher");
  assert.equal(isGateExempt({ name: "ask_user" }), true);
  assert.equal(isGateExempt({ name: "subagent_interrupt" }), true);
  // Exempting these would disable a guard that runs later in the tool_call hook.
  assert.equal(isGateExempt({ name: "subagent_done" }), false, "completion reporting stays guarded");
  // Real work still has to be assessed — this is the point of the gate.
  for (const name of ["bash", "read", "edit", "write", "subagent"]) {
    assert.equal(isGateExempt({ name }), false, name);
  }
  // Nothing registered and nothing matched: do not invent permission.
  assert.equal(isGateExempt({ name: "mystery_tool" }), false);
  assert.equal(isGateExempt(undefined), false);
});

test("a destructive hint outranks a read-only claim", () => {
  assert.equal(isReadOnlyTool({ name: "x", annotations: { readOnlyHint: true } }), true);
  assert.equal(isReadOnlyTool({ name: "x", annotations: { readOnlyHint: true, destructiveHint: true } }), false,
    "a tool claiming both is read as a write");
  assert.equal(isReadOnlyTool({ name: "x", annotations: {} }), false, "unannotated is not read-only");
  assert.equal(isReadOnlyTool(undefined), false);
  assert.equal(findTool([{ name: "a" }, { name: "b" }], "b")?.name, "b");
  assert.equal(findTool([{ name: "a" }], "z"), undefined);
});

// ------------------------------------------------- mode-sensitive restriction

test("Plan mode trusts a read-only MCP tool but refuses a dispatcher claiming read-only", () => {
  const readOnlyMcp = { name: "mcp__local_mcp__browser_snapshot", annotations: { readOnlyHint: true } };
  assert.equal(isPlanTool(readOnlyMcp.name, readOnlyMcp), true, "a genuine read-only MCP tool stays usable");

  const writingMcp = { name: "mcp__local_mcp__browser_click", annotations: { readOnlyHint: false } };
  assert.equal(isPlanTool(writingMcp.name, writingMcp), false);

  // The loophole this closes: an unknown gateway that declares itself read-only
  // would otherwise pass the annotation path and open an unenforceable route.
  const sneakyGateway = { name: "future_gateway", annotations: { readOnlyHint: true }, reachesTools: () => ["anything"] };
  assert.equal(isPlanTool(sneakyGateway.name, sneakyGateway), false, "dispatchers cannot buy Plan access with a hint");

  // An explicit allowlist entry still wins, which is why `ask_user` (a dispatcher)
  // remains available for clarifying questions in Plan mode.
  const askUser = { name: "ask_user", annotations: {}, reachesTools: () => ["caller_ping"] };
  assert.equal(isPlanTool(askUser.name, askUser), true, "allowlisted dispatcher stays usable");
});

// --------------------------------------------- availability before assessment

function todoFixture(branch: any[] = []) {
  const hooks: Record<string, Function[]> = {};
  const tools: Record<string, any> = {};
  const notices: string[] = [];
  const ctx: any = {
    hasUI: true,
    signal: new AbortController().signal,
    sessionManager: { getBranch: () => branch },
    ui: { setWidget() {}, notify: (text: string) => notices.push(text) },
  };
  // A registry shaped like a real session: core tools, a connected MCP server, and
  // a dispatcher that declares itself through reachesTools.
  const registry = [
    { name: "read" }, { name: "bash" }, { name: "edit" }, { name: "write" },
    { name: "workflow_todo" }, { name: "artifact_save" }, { name: "subagent" },
    { name: "ask_user", reachesTools: () => ["caller_ping"] },
    { name: "mcp", reachesTools: "all" },
    { name: "mcp__github__create_issue" }, { name: "mcp__github__list_repos" },
  ];
  const pi: any = {
    on: (event: string, handler: Function) => { hooks[event] = hooks[event] || []; hooks[event].push(handler); },
    appendEntry: (customType: string, data: any) => branch.push({ type: "custom", customType, data: structuredClone(data) }),
    registerTool: (tool: any) => { tools[tool.name] = tool; },
    registerCommand: () => {},
    getActiveTools: () => registry.map(tool => tool.name),
    setActiveTools: () => {},
    getAllTools: () => registry,
  };
  todo(pi);
  const emit = async (event: string, data: any = {}) => {
    let lastResult;
    for (const handler of hooks[event] || []) lastResult = await handler(data, ctx);
    return lastResult;
  };
  emit("session_start", {});
  return {
    emit, notices, branch,
    toolCall: (toolName: string, input: any = {}) => emit("tool_call", { toolName, input }),
    toolResult: (toolName: string) => emit("tool_result", { toolName, isError: false, content: [] }),
    end: (override: any = {}) => emit("turn_end", { entries: [], outcome: "completed", continue: false,
      context: { canContinue: true }, message: { role: "assistant", stopReason: "stop", content: "ok" }, ...override }),
    call: (args: any) => tools.workflow_todo.execute("id", args, ctx.signal, undefined, ctx),
  };
}

test("no assessment gate: real work and MCP capabilities all run immediately", async () => {
  const s = todoFixture();
  // The whole point of v2: nothing needs to be "assessed" before it can run.
  for (const name of ["bash", "read", "edit", "write", "subagent", "mcp__github__create_issue", "mcp__github__list_repos", "mcp", "ask_user"]) {
    assert.equal(await s.toolCall(name), undefined, `${name} must run without a todo round-trip`);
  }
});

test("todo calls are never counted as or against progress", async () => {
  // v1 ran an `adminRounds`/`loopSteers` work accountant that flagged todo-only
  // rounds and steered the model. v2 has no accountant, so this can only stay quiet.
  const s = todoFixture();
  await s.call({ action: "plan", steps: ["Query MCP", "Report"] });
  for (let round = 1; round <= 4; round++) {
    await s.toolCall("workflow_todo", { action: "continue" });
    await s.toolResult("workflow_todo");
    await s.end();
  }
  assert.equal(s.notices.some(text => text.includes("Todo-only")), false,
    "todo-only steering does not exist any more");
});

// --------------------------------------- late MCP registration, per mode

function modeFixture(branch: any[] = [], extraTools: any[] = []) {
  const hooks: Record<string, Function[]> = {};
  const commands: Record<string, any> = {};
  const notices: string[] = [];
  let active = ["read", "bash", "edit", "write", "workflow_todo", "artifact_save"];
  let idle = true;
  const late: any[] = [];
  const pi: any = {
    on: (name: string, fn: Function) => { hooks[name] = hooks[name] || []; hooks[name].push(fn); },
    registerCommand: (name: string, command: any) => { commands[name] = command; },
    registerTool: (tool: any) => { late.push(tool); },
    appendEntry: (customType: string, data: any) => branch.push({ type: "custom", customType, data }),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
    // Late tools appear here, exactly as a lazily connected MCP server would.
    getAllTools: () => [...active, ...extraTools, ...late].map(tool => ({
      name: tool.name, exposure: tool.exposure, annotations: tool.annotations, reachesTools: tool.reachesTools,
    })),
    // `emit` is required: sidebar-channel publishes through it, and a stub without
    // it throws asynchronously rather than in-line, which the test runner reports
    // as activity after the test ended instead of a clean failure.
    events: { on: () => {}, emit: () => {} },
  };
  const ctx: any = {
    mode: "tui", hasUI: true, isIdle: () => idle,
    sessionManager: { getBranch: () => branch },
    ui: { notify: (text: string) => notices.push(text), setWidget() {}, setEditorComponent() {}, addAutocompleteProvider() {} },
  };
  modes(pi);
  const emit = async (name: string, event: any = {}) => {
    const results = [];
    for (const hook of hooks[name] || []) results.push(await hook(event, ctx));
    return results.filter(Boolean);
  };
  emit("session_start", {});
  return { emit, notices, active: () => [...active], registerLate: (tool: any) => late.push(tool) };
}

const planEntry = () => ({ type: "custom", customType: PLAN_MODE_TYPE, data: { enabled: true, previousTools: ["read", "bash", "edit", "write"] } });
const READ_ONLY_MCP = { name: "mcp__late__browser_snapshot", exposure: "deferred", annotations: { readOnlyHint: true } };
const WRITING_MCP = { name: "mcp__late__browser_click", exposure: "deferred", annotations: { readOnlyHint: false } };

test("Plan mode re-applies its restriction when MCP tools register late", async () => {
  const f = modeFixture([planEntry()]);
  assert.equal(f.active().includes("edit"), false, "Plan mode started by dropping the write tool");

  // A lazily connected server now advertises one read-only and one writing tool.
  f.registerLate(READ_ONLY_MCP);
  f.registerLate(WRITING_MCP);

  await f.emit("mcp_servers_change", { type: "mcp_servers_change", servers: [] });

  assert.equal(f.active().includes(READ_ONLY_MCP.name), true,
    "the newly available read-only MCP tool becomes usable");
  assert.equal(f.active().includes(WRITING_MCP.name), false,
    "a writing MCP tool must not become active just because it appeared after the mode was set");
});

test("Normal mode completes its saved loadout on late registration without force-activating deferred tools", async () => {
  const restoredEntry = { type: "custom", customType: PLAN_MODE_TYPE, data: {
    enabled: false, previousTools: [READ_ONLY_MCP.name], pendingTools: [READ_ONLY_MCP.name] } };
  const f = modeFixture([restoredEntry], [READ_ONLY_MCP, WRITING_MCP]);

  await f.emit("mcp_servers_change", { type: "mcp_servers_change", servers: [] });

  assert.equal(f.active().includes(READ_ONLY_MCP.name), true,
    "a tool the session had explicitly saved is reconnected when it reappears");
  assert.equal(f.active().includes(WRITING_MCP.name), false,
    "Normal mode must not turn every visible tool active; deferred exposure is the adapter's choice");
});
