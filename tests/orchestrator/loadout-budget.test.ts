import test from "node:test";
import assert from "node:assert/strict";

import orchestratorExtension from "../../extensions/orchestrator.ts";
import {
  CORE_REVIEW_TOOLS,
  declaredSuperviseTools,
  DEFERRED_ORCH_TOOLS,
  deferredOrchTools,
  isDeferredOrchTool,
  isSupervisorTool,
  SUPERVISOR_DENIED_TOOLS,
  SUPERVISOR_TOOLS,
} from "../../lib/supervise-mode.ts";

/**
 * The loadout is a token contract, and a reachability contract.
 *
 * A JSON tool definition runs ~150-200 tokens, so the review loop does not
 * declare every allowed tool. The rule that makes that safe is narrow, and this
 * file exists because getting it wrong is silent:
 *
 *   pi's `tool_search` indexes a tool that is undeclared *because of its
 *   exposure* (`deferred`, `codemode`). A `direct`-exposure tool that
 *   `setActiveTools` dropped is not findable — ever. Session `01a16c5b` shows the
 *   result: thirteen `tool_search` calls for a spawn tool the mode had just
 *   removed, thirteen "No matching tools found" replies.
 *
 * So permission and declaration may differ by exactly one thing: the tools this
 * package registers with `exposure: "deferred"`.
 */

/** Tools pi itself provides; they are not registered by this extension. */
const HOST_TOOLS = new Set(["read", "grep", "bash", "ask_user", "tool_search", "artifact_save"]);

function registeredTools(): { name: string; exposure?: string }[] {
  const tools: { name: string; exposure?: string }[] = [];
  const fakePi: any = {
    registerTool(tool: any) {
      tools.push({ name: tool.name, exposure: tool.exposure });
    },
    registerCommand() {},
    on() {},
    getAllTools() {
      return tools.map((tool) => ({ ...tool }));
    },
  };
  orchestratorExtension(fakePi);
  return tools;
}

test("the core review loadout is small and contains the whole loop", () => {
  const MAX_CORE = 18;
  assert.ok(CORE_REVIEW_TOOLS.size <= MAX_CORE, `core loadout has ${CORE_REVIEW_TOOLS.size} tools (max ${MAX_CORE})`);
  for (const name of ["orch_handoff", "orch_spawn", "orch_brief", "orch_check", "orch_review", "tool_search"]) {
    assert.ok(CORE_REVIEW_TOOLS.has(name), `${name} is the loop and must never be deferred`);
  }
});

test("every core tool is either registered here or provided by the host", () => {
  const registered = new Set(registeredTools().map((tool) => tool.name));
  for (const name of CORE_REVIEW_TOOLS) {
    assert.ok(registered.has(name) || HOST_TOOLS.has(name), `${name} is in the core but nothing registers it`);
  }
  for (const name of ["orch_brief", "orch_check"]) {
    assert.ok(registered.has(name), `${name} must be registered by the orchestrator extension`);
  }
});

test("deferred and core are disjoint, and every deferred name is allowed", () => {
  const deferred = deferredOrchTools();
  for (const name of deferred) {
    assert.equal(CORE_REVIEW_TOOLS.has(name), false, `${name} cannot be both always-declared and deferred`);
    assert.ok(SUPERVISOR_TOOLS.has(name), `${name} is deferred but not allowed — it would be unreachable either way`);
  }
});

/**
 * The reachability proof, and the one that would have caught the regression.
 *
 * A deferred tool is only reachable if the extension actually registered it that
 * way. Registering it `direct` and then filtering it out of the declaration list
 * makes it invisible — `tool_search` will not return it.
 */
test("a deferred name is genuinely registered as deferred, so tool_search can return it", () => {
  const registered = new Map(registeredTools().map((tool) => [tool.name, tool]));
  for (const name of DEFERRED_ORCH_TOOLS) {
    const tool = registered.get(name);
    assert.ok(tool, `${name} is deferred but not registered by this extension`);
    assert.equal(tool!.exposure, "deferred", `${name} must be registered with exposure "deferred" or it is unreachable`);
  }
  // The reverse: nothing is registered deferred unless the loadout knows it may be.
  for (const tool of registered.values()) {
    if (tool.exposure !== "deferred") continue;
    assert.ok(isDeferredOrchTool(tool.name), `${tool.name} is deferred but not listed — it would be declared only by accident`);
    assert.ok(SUPERVISOR_TOOLS.has(tool.name), `${tool.name} is deferred but not allowed`);
  }
});

test("the declaration rule withholds nothing but deferred tools", () => {
  const registered = registeredTools();
  const universe = [
    ...registered,
    ...[...HOST_TOOLS].map((name) => ({ name, exposure: "direct" })),
    // A host tool someone else deferred: reachable through tool_search, so it may
    // stay undeclared. This is the only legitimate non-own deferral.
    { name: "artifact_recall", exposure: "deferred" },
  ];
  const declared = new Set(declaredSuperviseTools(universe, { v2DelegationAvailable: true }));
  for (const tool of universe) {
    if (!isSupervisorTool(tool.name, tool, { v2DelegationAvailable: true })) continue;
    if (tool.exposure === "deferred" || tool.exposure === "hidden") {
      assert.equal(declared.has(tool.name), false, `${tool.name} is deferred and must not be declared`);
      continue;
    }
    // THE invariant: an allowed, visible, direct-exposure tool is declared. If
    // this fails, the mode just made it permanently unfindable.
    assert.ok(declared.has(tool.name), `${tool.name} is allowed and not deferrable, so it must be declared`);
  }
});

test("a permitted tool outside the core is allowed but still not hidden from search", () => {
  // `web_read` is permitted and not in the core: it must be declared, because it
  // is a host tool with direct exposure and cannot be discovered after removal.
  assert.equal(isSupervisorTool("web_read"), true);
  assert.equal(CORE_REVIEW_TOOLS.has("web_read"), false);
  assert.ok(declaredSuperviseTools([{ name: "web_read", exposure: "direct" }]).includes("web_read"));
  for (const name of SUPERVISOR_DENIED_TOOLS) {
    assert.equal(isSupervisorTool(name), false, `${name} must stay denied`);
    assert.equal(CORE_REVIEW_TOOLS.has(name), false, `${name} must never be declared`);
  }
});

test("the review loop cannot be served by a write tool", () => {
  for (const name of ["write", "edit", "multi_edit", "apply_patch"]) {
    assert.equal(CORE_REVIEW_TOOLS.has(name), false, `${name} must not be in the core`);
    assert.equal(isSupervisorTool(name), false, `${name} must not be allowed`);
  }
});
