import test from "node:test";
import assert from "node:assert/strict";

import {
  CHILD_DELEGATION_TOOLS,
  DELEGATION_TOOLS,
  DEFERRED_DELEGATION_TOOLS,
  MAX_DELEGATION_DEPTH,
  PARENT_DELEGATION_TOOLS,
  PLAN_SAFE_DELEGATION_TOOLS,
  RETIRED_V1_TOOLS,
  canonicalDelegationName,
  describeRetiredTools,
  childControlToolNames,
  delegationTool,
  isDelegationTool,
  isRetiredDelegationTool,
  mayUseDelegationTool,
  parentDelegationToolNames,
  planSafeDelegationToolNames,
  stripRetiredTools,
} from "../lib/delegation-tools.ts";

test("the canonical surface is one agent_ namespace with unique names", () => {
  const names = DELEGATION_TOOLS.map(tool => tool.name);
  assert.equal(new Set(names).size, names.length, "no duplicate tool names");
  for (const name of names) assert.match(name, /^agent_/, `${name} uses the canonical prefix`);
});

test("every tool has exactly one role and every role set is disjoint", () => {
  for (const tool of DELEGATION_TOOLS) {
    assert.ok(tool.role === "parent" || tool.role === "child", `${tool.name} has a valid role`);
  }
  for (const name of PARENT_DELEGATION_TOOLS) assert.equal(CHILD_DELEGATION_TOOLS.has(name), false, `${name} is not both roles`);
  for (const name of CHILD_DELEGATION_TOOLS) assert.equal(PARENT_DELEGATION_TOOLS.has(name), false, `${name} is not both roles`);
  assert.equal(PARENT_DELEGATION_TOOLS.size + CHILD_DELEGATION_TOOLS.size, DELEGATION_TOOLS.length);
});

test("child tools are never plan-safe", () => {
  for (const name of CHILD_DELEGATION_TOOLS) {
    assert.equal(PLAN_SAFE_DELEGATION_TOOLS.has(name), false, `${name} must not be active in Plan mode`);
  }
  for (const name of PLAN_SAFE_DELEGATION_TOOLS) {
    assert.equal(PARENT_DELEGATION_TOOLS.has(name), true, `${name} is a parent tool`);
  }
});

test("only agent_route is deferred", () => {
  assert.deepEqual([...DEFERRED_DELEGATION_TOOLS], ["agent_route"]);
  assert.equal(delegationTool("agent_route")?.exposure, "deferred");
});

test("retired names are disjoint from the canonical surface", () => {
  for (const name of RETIRED_V1_TOOLS) {
    assert.equal(isDelegationTool(name), false, `${name} is not canonical`);
    assert.equal(isRetiredDelegationTool(name), true);
  }
  for (const tool of DELEGATION_TOOLS) {
    assert.equal(RETIRED_V1_TOOLS.has(tool.name), false, `${tool.name} is not retired`);
  }
});

test("every retired name with a successor translates to a canonical tool", () => {
  for (const name of RETIRED_V1_TOOLS) {
    const target = canonicalDelegationName(name);
    // `spec_review_submit`'s successor was removed with the delegation
    // pipeline; the others still have a live canonical name.
    if (!target) continue;
    assert.equal(isDelegationTool(target), true, `${target} exists`);
  }
  assert.equal(RETIRED_V1_TOOLS.size, 11);
});

test("canonicalDelegationName is idempotent for canonical names and undefined for strangers", () => {
  for (const tool of DELEGATION_TOOLS) {
    assert.equal(canonicalDelegationName(tool.name), tool.name);
    assert.equal(canonicalDelegationName(canonicalDelegationName(tool.name)!), tool.name);
  }
  assert.equal(canonicalDelegationName("bash"), undefined);
  assert.equal(canonicalDelegationName("agent_wat"), undefined);
});

test("the authorization predicate refuses role mismatches and every retired name", () => {
  assert.equal(mayUseDelegationTool("agent_spawn", "parent"), true);
  assert.equal(mayUseDelegationTool("agent_spawn", "child"), false);
  assert.equal(mayUseDelegationTool("agent_done", "child"), true);
  assert.equal(mayUseDelegationTool("agent_done", "parent"), false);
  assert.equal(mayUseDelegationTool("agent_running", "parent"), true);

  for (const name of RETIRED_V1_TOOLS) {
    assert.equal(mayUseDelegationTool(name, "parent"), false, `${name} is never authorizable as parent`);
    assert.equal(mayUseDelegationTool(name, "child"), false, `${name} is never authorizable as child`);
  }
  assert.equal(mayUseDelegationTool("bash", "parent"), false, "non-delegation tools are not this predicate's business");
});

test("spawning is depth-limited; resuming and listing are not", () => {
  assert.equal(MAX_DELEGATION_DEPTH, 1);
  assert.equal(mayUseDelegationTool("agent_spawn", "parent", 0), true, "a top-level session may spawn");
  assert.equal(mayUseDelegationTool("agent_spawn", "parent", 1), false, "a child may not spawn");
  assert.equal(mayUseDelegationTool("agent_spawn", "parent", 0, 2), true, "an explicit wider limit is honoured");
  assert.equal(mayUseDelegationTool("agent_resume", "parent", 9), true, "only spawn is depth-limited");
  assert.equal(mayUseDelegationTool("agent_running", "parent", 9), true);
});

test("stripRetiredTools drops legacy loadout entries instead of translating them", () => {
  assert.deepEqual(
    stripRetiredTools(["read", "subagent", "agent_spawn", "caller_ping", "read", "agent_done"]),
    ["read", "agent_spawn", "agent_done"],
  );
  assert.deepEqual(stripRetiredTools([]), []);
});

test("the derived name lists match the table", () => {
  assert.deepEqual(parentDelegationToolNames(), [...PARENT_DELEGATION_TOOLS].sort());
  assert.deepEqual(planSafeDelegationToolNames(), [...PLAN_SAFE_DELEGATION_TOOLS].sort());
  assert.deepEqual(childControlToolNames(), [
    "agent_done",
    "agent_parent_digest",
    "agent_parent_recall",
    "agent_ping",
    "agent_progress",
  ]);
  assert.equal(childControlToolNames().includes("agent_spawn"), false, "a child control list never contains a spawn tool");
});

test("the retired list names each live successor, so 'unavailable' is not read as 'gone'", () => {
  const described = describeRetiredTools();
  // The bug: a reviewer whose submit call failed on malformed JSON read
  // "spec_review_submit is unavailable" and concluded its tool was removed.
  assert.match(described, /subagent \(use agent_spawn\)/);
  assert.match(described, /spec_review_submit/, "the retired name is still named");
  for (const name of RETIRED_V1_TOOLS) {
    assert.ok(described.includes(name), `${name} is still named`);
  }
});
