import test from "node:test";
import assert from "node:assert/strict";
import { isSupervisorTool, SUPERVISOR_TOOLS, v2DelegationInForce, supervisorAllowlistGaps } from "../lib/supervise-mode.ts";
import { V1_TOOLS, V2_TOOLS } from "../lib/delegate-switch.ts";
import { MODES, ModeRegistry } from "../lib/modes.ts";
import modesExtension from "../extensions/modes.ts";

test("isSupervisorTool permits supervisor controls, read-only tools, and orch_* suite", () => {
  // Navigation & Inspection
  for (const name of ["read", "grep", "find", "ls", "ffgrep", "fffind", "vcc_recall", "web_read", "google_search", "tool_search", "subagent_history"]) {
    assert.equal(isSupervisorTool(name), true, `expected ${name} to be allowed`);
  }

  // Artifacts
  for (const name of ["artifact_save", "artifact_recall", "artifact_list"]) {
    assert.equal(isSupervisorTool(name), true, `expected ${name} to be allowed`);
  }

  // Workflow
  for (const name of ["workflow_todo", "ask_user", "subagents_list", "subagent_progress"]) {
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
  assert.deepEqual(supervisorAllowlistGaps(V2_TOOLS), [], "v2 registers only tools supervise allows");
  assert.deepEqual(supervisorAllowlistGaps([...V1_TOOLS, ...V2_TOOLS]), [], "both delegation surfaces are reachable");

  // The detector must be able to FAIL, or the assertions above are vacuous. Drive
  // it against the historical bug: a delegation surface that omits the two tools
  // the orchestrator cannot work without.
  const historical = new Set([...SUPERVISOR_TOOLS]);
  historical.delete("orch_handoff");
  historical.delete("orch_escalate");
  assert.deepEqual(
    supervisorAllowlistGaps(V2_TOOLS, undefined, historical),
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

test("supervise mode withholds v1 delegation while v2 is fully available", () => {
  const all = [...V1_TOOLS, ...V2_TOOLS];
  // v2 present and switched on: v1 must not be a bypass of handoff specs, lane
  // isolation and the escalation ladder.
  assert.equal(v2DelegationInForce(all), true);
  for (const name of V1_TOOLS) {
    assert.equal(
      isSupervisorTool(name, undefined, { v2DelegationAvailable: true }),
      false,
      `${name} must be withheld while v2 is in force`,
    );
  }
  // ...but the v2 surface stays reachable.
  for (const name of V2_TOOLS) {
    assert.equal(isSupervisorTool(name, undefined, { v2DelegationAvailable: true }), true);
  }

  // v2 not installed, or switched off: v1 stays usable rather than leaving the
  // orchestrator with no delegation surface at all.
  const v1Only = [...V1_TOOLS];
  assert.equal(v2DelegationInForce(v1Only), false);
  assert.equal(isSupervisorTool("subagent", undefined, { v2DelegationAvailable: false }), true);

  const v2Disabled = new Set([...V2_TOOLS]);
  assert.equal(v2DelegationInForce(all, v2Disabled), false);
  assert.equal(
    isSupervisorTool("subagent", undefined, { v2DelegationAvailable: false, disabledDelegates: new Set() }),
    true,
  );
});

test("a delegate tool the user switched off stays off even in supervise mode", () => {
  const disabled = new Set(["subagent"]);
  assert.equal(
    isSupervisorTool("subagent", undefined, { disabledDelegates: disabled, v2DelegationAvailable: false }),
    false,
    "the switch decision is not undone by entering a mode",
  );
  assert.equal(
    isSupervisorTool("orch_handoff", undefined, { disabledDelegates: disabled, v2DelegationAvailable: true }),
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

  // Bash gating: read-only command allowed, write command blocked
  const allowedBash = toolCallHook({ toolName: "bash", input: { command: "git status" } }, ctx);
  assert.equal(allowedBash, undefined, "git status must be allowed");

  const blockedBash = toolCallHook({ toolName: "bash", input: { command: "rm -rf foo" } }, ctx);
  assert.ok(blockedBash?.block, "rm -rf must be blocked in supervise mode");

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
    "workflow_todo", "ask_user", "subagents_list", "subagent_history", "tool_search",
    "orch_handoff", "orch_spawn", "orch_resume", "orch_interrupt", "orch_steer",
    "orch_route", "orch_running", "orch_brief", "orch_check", "orch_review", "orch_spec_review", "orch_escalate", "orch_close",
    "subagent", "subagent_resume",
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

  // And v1 must not be the escape hatch. v2 is fully registered here, so v1
  // `subagent` is withheld rather than left as a bypass of handoff/isolation/ladder.
  assert.equal(activeTools.has("subagent"), false, "v1 subagent must be withheld while v2 is in force");
  assert.equal(activeTools.has("subagent_resume"), false, "v1 subagent_resume must be withheld too");

  // The same answers from the per-call gate, so a stale active set cannot reopen it.
  const toolCallHook = events.get("tool_call")!;
  assert.equal(toolCallHook({ toolName: "orch_handoff", input: {} }, ctx), undefined);
  assert.equal(toolCallHook({ toolName: "orch_escalate", input: {} }, ctx), undefined);
  const v1 = toolCallHook({ toolName: "subagent", input: {} }, ctx);
  assert.ok(v1?.block, "calling v1 subagent in supervise mode must be blocked");

  // Direct implementation is still blocked — the mode's whole point.
  assert.ok(toolCallHook({ toolName: "edit", input: { path: "a.txt" } }, ctx)?.block);
});
