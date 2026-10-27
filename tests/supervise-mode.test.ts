import test from "node:test";
import assert from "node:assert/strict";
import { isSupervisorTool, superviseShellCommand, SUPERVISOR_TOOLS, supervisorAllowlistGaps } from "../lib/supervise-mode.ts";
import { PARENT_DELEGATION_TOOLS } from "../lib/delegation-tools.ts";
import { MODES, ModeRegistry } from "../lib/modes.ts";
import modesExtension from "../extensions/modes.ts";

test("the supervisor shell is read-only: inspection yes, writes and waits no", () => {
  for (const allowed of [
    "git status",
    "git -C /tmp/repo diff --stat",
    "rg TODO src",
    "cat package.json",
    "find src -name '*.ts'",
  ]) {
    assert.ok(superviseShellCommand(allowed), `${allowed} is read-only inspection`);
  }

  // The mode claims the orchestrator does not implement; these are the commands
  // that made that claim false. `sleep` is included because polling is the other
  // half of the same failure: the parent has triggers, not a timer.
  for (const refused of [
    "echo x > f",
    "tee f",
    "sed -i s/a/b/ f",
    "python3 - <<'PY'\nprint(1)\nPY",
    "node -e 'console.log(1)'",
    "rm -rf build",
    "sleep 120",
    "bash -c 'echo hi'",
    "echo $(whoami)",
  ]) {
    assert.equal(superviseShellCommand(refused), undefined, `${refused} must be refused`);
  }

  assert.equal(superviseShellCommand("   "), undefined);
  assert.equal(superviseShellCommand(undefined), undefined);
  assert.equal(superviseShellCommand("echo\u0000"), undefined);
});

test("isSupervisorTool permits supervisor controls, read-only tools, and orch_* suite", () => {
  // Navigation & Inspection
  for (const name of ["read", "grep", "find", "ls", "ffgrep", "fffind", "vcc_recall", "web_read", "google_search", "tool_search", "orch_history"]) {
    assert.equal(isSupervisorTool(name), true, `expected ${name} to be allowed`);
  }

  // Artifacts
  for (const name of ["artifact_save", "artifact_recall", "artifact_list"]) {
    assert.equal(isSupervisorTool(name), true, `expected ${name} to be allowed`);
  }

  // Workflow
  for (const name of ["workflow_todo", "ask_user", "orch_running", "orch_progress"]) {
    assert.equal(isSupervisorTool(name), true, `expected ${name} to be allowed`);
  }

  // sv2 tools — including the two the orchestrator cannot work without.
  // `orch_handoff` authors the spec; `orch_spawn` requires a handoffId, so without it
  // the spawn tool has an unreachable mandatory precondition. `orch_escalate` is the
  // ladder's middle rung. A production session lost all three and worked around v2
  // with the v1 `subagent` tool, so they are asserted by name, not just in bulk.
  for (const name of ["orch_handoff", "orch_escalate", "orch_spawn", "orch_resume", "orch_interrupt", "orch_steer", "orch_route", "orch_running", "orch_review"]) {
    assert.equal(isSupervisorTool(name), true, `expected ${name} to be allowed`);
  }
});

test("isSupervisorTool denies direct file modifications, browser tools, and opaque gateways", () => {
  for (const name of ["edit", "write", "browser", "browser_download", "browser_login", "browser_evidence", "browser_visibility", "mcp", "codemode", "generate_image"]) {
    assert.equal(isSupervisorTool(name), false, `expected ${name} to be blocked`);
  }
  // Browser namespace or MCP namespace proxies
  assert.equal(isSupervisorTool("browser_navigate"), false);
  assert.equal(isSupervisorTool("mcp__local_mcp"), false);
});

test("every delegation tool the v2 package registers is reachable in supervise mode", () => {
  // This is the invariant that actually broke. All three suites passed while the
  // live allowlist was missing `orch_handoff` and `orch_escalate`, because nothing
  // compared "tools v2 registers" against "tools supervise allows". A rename in
  // either package reopens the hole silently, so it is asserted as a set relation.
  const parentTools = [...PARENT_DELEGATION_TOOLS];
  assert.deepEqual(supervisorAllowlistGaps(parentTools), [], "every parent delegation tool is reachable");

  // The detector must be able to FAIL, or the assertions above are vacuous. Drive
  // it against the historical bug: a delegation surface that omits the two tools
  // the orchestrator cannot work without.
  const historical = new Set([...SUPERVISOR_TOOLS]);
  historical.delete("orch_handoff");
  historical.delete("orch_escalate");
  assert.deepEqual(
    supervisorAllowlistGaps([...PARENT_DELEGATION_TOOLS], undefined, historical),
    ["orch_escalate", "orch_handoff"],
    "the exact production regression must be reported",
  );

  // A newly registered delegation tool that the allowlist has not been taught
  // about is reported too, so adding a tool cannot silently re-narrow the mode.
  assert.deepEqual(
    supervisorAllowlistGaps(["orch_brand_new"], ["orch_brand_new"], SUPERVISOR_TOOLS),
    ["orch_brand_new"],
  );

  assert.equal(SUPERVISOR_TOOLS.has("orch_handoff"), true);
  assert.equal(SUPERVISOR_TOOLS.has("orch_escalate"), true);
});

test("the canonical delegation surface is the only delegation surface", () => {
  for (const name of PARENT_DELEGATION_TOOLS) {
    assert.equal(isSupervisorTool(name), true, `${name} must be reachable`);
  }
  // A retired v1 name is not in the table, so it can never be the escape hatch.
  assert.equal(isSupervisorTool("subagent"), false);
  assert.equal(isSupervisorTool("subagent_resume"), false);
});

test("a delegate tool the user switched off stays off even in supervise mode", () => {
  const disabled = new Set(["orch_spawn"]);
  assert.equal(
    isSupervisorTool("orch_spawn", undefined, { disabledDelegates: disabled }),
    false,
    "the switch decision is not undone by entering a mode",
  );
  assert.equal(
    isSupervisorTool("orch_handoff", undefined, { disabledDelegates: disabled }),
    true,
  );
});

test("supervise mode is registered in MODES, not in default Shift+Tab cycle, but selectable", () => {
  const supervise = MODES.find(m => m.id === "supervise");
  assert.ok(supervise, "supervise mode must exist in MODES");
  assert.equal(supervise.cycleable, false, "supervise mode must not cycle in default user Shift+Tab");

  const registry = new ModeRegistry();
  assert.equal(registry.select("supervise"), true, "must be selectable via select('supervise')");
  assert.equal(registry.current.id, "supervise");

  // Cycling from supervise skips to the next cycleable mode: orchestrator
  // (added to the Shift+Tab cycle) rather than wrapping straight to normal.
  registry.cycle();
  assert.equal(registry.current.id, "orchestrator");
  registry.cycle();
  assert.equal(registry.current.id, "normal");
});

test("supervise mode command and tool execution policy in modesExtension", async () => {
  const events = new Map<string, Function>();
  const commands = new Map<string, any>();
  const activeTools = new Set(["read", "edit", "write", "bash", "artifact_save", "orch_spawn"]);
  const branch: any[] = [];

  const fakePi: any = {
    getAllTools: () => [
      { name: "read" },
      { name: "edit" },
      { name: "write" },
      { name: "bash" },
      { name: "artifact_save" },
      { name: "orch_spawn" },
    ],
    getActiveTools: () => [...activeTools],
    setActiveTools: (tools: string[]) => {
      activeTools.clear();
      for (const t of tools) activeTools.add(t);
    },
    on: (event: string, handler: Function) => events.set(event, handler),
    registerCommand: (name: string, def: any) => commands.set(name, def),
    appendEntry: (customType: string, data: any) => {
      branch.push({ type: "custom", customType, data });
    },
  };

  modesExtension(fakePi);

  assert.ok(commands.has("supervise"), "/supervise command must be registered");
  assert.ok(commands.has("mode"), "/mode command must be registered");

  const ctx: any = {
    mode: "tui",
    sessionManager: { getBranch: () => branch },
    isIdle: () => true,
    ui: { notify: () => {} },
  };

  // Switch to supervise via /supervise on
  await commands.get("supervise").handler("on", ctx);
  assert.ok(!activeTools.has("edit"), "edit must be removed from active tools");
  assert.ok(!activeTools.has("write"), "write must be removed from active tools");
  assert.ok(activeTools.has("read"), "read must remain active");
  assert.ok(activeTools.has("orch_spawn"), "orch_spawn must remain active");

  // Gating in tool_call
  const toolCallHook = events.get("tool_call")!;
  const blockedEdit = toolCallHook({ toolName: "edit", input: { path: "a.txt" } }, ctx);
  assert.ok(blockedEdit?.block, "edit must be blocked in supervise mode");

  const allowedRead = toolCallHook({ toolName: "read", input: { path: "a.txt" } }, ctx);
  assert.equal(allowedRead, undefined, "read must not be blocked");

  // Read-only review shell: inspection is allowed, writes and waits are not. The
  // boundary is the closed grammar, not the prompt: the orchestrator declares it
  // does not implement, and a general shell made that declaration false.
  const allowedBash = toolCallHook({ toolName: "bash", input: { command: "git status" } }, ctx);
  assert.equal(allowedBash, undefined, "git status must be allowed");

  const reviewScript = toolCallHook({ toolName: "bash", input: { command: "python3 -c 'print(1)'" } }, ctx);
  assert.ok(reviewScript?.block, "an arbitrary review script must be blocked in supervise mode");

  const writeBash = toolCallHook({ toolName: "bash", input: { command: "echo x > f" } }, ctx);
  assert.ok(writeBash?.block, "a write through bash must be blocked in supervise mode");

  const sleepBash = toolCallHook({ toolName: "bash", input: { command: "sleep 120" } }, ctx);
  assert.ok(sleepBash?.block, "polling with sleep must be blocked in supervise mode");

  const emptyBash = toolCallHook({ toolName: "bash", input: { command: "   " } }, ctx);
  assert.ok(emptyBash?.block, "an empty bash command is refused");

  const native = events.get("user_bash")!({ command: "node -e 'console.log(1)'" }, ctx);
  assert.ok(native?.result, "native shell refuses a non-read-only script in supervise mode");
  assert.equal(native?.operations, undefined, "a refused native shell runs no operations");

  const nativeAllowed = events.get("user_bash")!({ command: "git status" }, ctx);
  assert.ok(nativeAllowed?.operations, "native shell still runs read-only inspection");

  // Switch off via /supervise off
  await commands.get("supervise").handler("off", ctx);
  assert.ok(activeTools.has("edit"), "edit must be restored");
  assert.ok(activeTools.has("write"), "write must be restored");
});

test("the debug-session loadout survives the gate: orch_handoff and orch_escalate are kept", async () => {
  // Replay the exact loadout recorded in the failing session's `previousTools`
  // (session 01a16ca1-e77e-75ca-8788-3b4c333ab975, branch entry 4), with the two
  // tools added since (`orch_brief`, `orch_check`) and `orch_close` — the historical
  // entry predates them, and a loadout missing a v2 tool makes v2 look absent, which
  // would silently re-enable the v1 escape hatch this test forbids.
  const debugLoadout = [
    "read", "grep", "find", "ls", "bash", "artifact_save", "artifact_recall", "artifact_list",
    "workflow_todo", "ask_user", "orch_running", "orch_history", "tool_search",
    "orch_handoff", "orch_spawn", "orch_resume", "orch_interrupt", "orch_steer",
    "orch_route", "orch_running", "orch_brief", "orch_check", "orch_review", "orch_spec_review", "orch_escalate", "orch_close",
  ];
  const events = new Map<string, Function>();
  const commands = new Map<string, any>();
  const activeTools = new Set(debugLoadout);
  const branch: any[] = [];

  const registered = debugLoadout.map(name => ({
    name,
    ...(name.startsWith("browser_") ? { annotations: { readOnlyHint: true } } : {}),
  }));

  const fakePi: any = {
    getAllTools: () => registered,
    getActiveTools: () => [...activeTools],
    setActiveTools: (tools: string[]) => {
      activeTools.clear();
      for (const t of tools) activeTools.add(t);
    },
    on: (event: string, handler: Function) => events.set(event, handler),
    registerCommand: (name: string, def: any) => commands.set(name, def),
    appendEntry: (customType: string, data: any) => {
      branch.push({ type: "custom", customType, data });
    },
  };

  modesExtension(fakePi);
  const ctx: any = {
    mode: "tui",
    sessionManager: { getBranch: () => branch },
    isIdle: () => true,
    ui: { notify: () => {} },
  };

  await commands.get("supervise").handler("on", ctx);

  // The authoring and escalation tools must survive: without them the spawn tool's
  // mandatory `handoffId` precondition is unreachable.
  assert.ok(activeTools.has("orch_handoff"), "orch_handoff must survive the gate");
  assert.ok(activeTools.has("orch_escalate"), "orch_escalate must survive the gate");
  assert.ok(activeTools.has("orch_spawn"), "orch_spawn must survive the gate");
  assert.ok(activeTools.has("read"), "read must survive the gate");

  // A retired v1 name is not part of the surface at all, so it cannot be the
  // escape hatch the debug session used.
  assert.equal(activeTools.has("subagent"), false, "the v1 subagent name is gone");
  assert.equal(activeTools.has("subagent_resume"), false, "the v1 resume name is gone");

  // The same answers from the per-call gate, so a stale active set cannot reopen it.
  const toolCallHook = events.get("tool_call")!;
  assert.equal(toolCallHook({ toolName: "orch_handoff", input: {} }, ctx), undefined);
  assert.equal(toolCallHook({ toolName: "orch_escalate", input: {} }, ctx), undefined);
  const v1 = toolCallHook({ toolName: "subagent", input: {} }, ctx);
  assert.ok(v1?.block, "a removed v1 name is blocked in supervise mode");

  // Direct implementation is still blocked — the mode's whole point.
  assert.ok(toolCallHook({ toolName: "edit", input: { path: "a.txt" } }, ctx)?.block);
});
