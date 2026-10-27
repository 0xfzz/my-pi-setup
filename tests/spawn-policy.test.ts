import test from "node:test";
import assert from "node:assert/strict";

import {
  allowedSpawnPurposes,
  capacityProblem,
  childToolsForPurpose,
  currentSpawnDepth,
  defaultSpawnPurpose,
  depthProblem,
  laneDeclaration,
  maxChildren,
  maxSpawnDepth,
  normalizeSpawnMode,
  registryPurpose,
  requiresReviewedSpec,
  spawnRefusal,
} from "../lib/spawn-policy.ts";

test("Normal admits every spawn shape, including an ad-hoc child", () => {
  assert.deepEqual([...allowedSpawnPurposes("normal")].sort(), ["adhoc", "implementation", "research", "review", "spec"]);
  assert.equal(defaultSpawnPurpose("normal"), "adhoc");
  for (const purpose of allowedSpawnPurposes("normal")) {
    assert.equal(spawnRefusal("normal", purpose), undefined, `${purpose} is admitted`);
  }
});

test("Plan admits research, review and spec work; refuses implementation and ad-hoc", () => {
  assert.deepEqual([...allowedSpawnPurposes("plan")].sort(), ["research", "review", "spec"]);
  assert.equal(defaultSpawnPurpose("plan"), "research");
  assert.equal(
    spawnRefusal("plan", "implementation"),
    "Plan mode: implementation delegation requires leaving Plan mode (/plan off) or an explicit execution approval.",
  );
  assert.match(spawnRefusal("plan", "adhoc") ?? "", /Plan mode: ad-hoc delegation has no handoff lane/);
  assert.equal(spawnRefusal("plan", "research"), undefined);
  assert.equal(spawnRefusal("plan", "review"), undefined);
  assert.equal(spawnRefusal("plan", "spec"), undefined);
});

test("an explicit execution approval lifts the Plan implementation refusal only", () => {
  assert.deepEqual([...allowedSpawnPurposes("plan", true)].sort(), ["adhoc", "implementation", "research", "review", "spec"]);
  assert.equal(spawnRefusal("plan", "implementation", true), undefined);
  assert.equal(spawnRefusal("plan", "adhoc", true), undefined);
});

test("Supervise and Orchestrator admit a handoff spec only", () => {
  for (const mode of ["supervise", "orchestrator"]) {
    assert.deepEqual(allowedSpawnPurposes(mode), ["spec"], mode);
    assert.match(spawnRefusal(mode, "adhoc") ?? "", /requires a handoff spec/);
    assert.equal(spawnRefusal(mode, "spec"), undefined);
    // `implementation` is the same spawn shape as `spec` once a handoff exists:
    // registryPurpose stores both as "implementation". Refusing the explicit
    // spelling only taught the parent to omit a correct argument, which is how
    // the review loop started.
    assert.deepEqual(allowedSpawnPurposes(mode, false, true), ["spec", "implementation"], mode);
    assert.equal(spawnRefusal(mode, "implementation", false, true), undefined, mode);
    assert.match(spawnRefusal(mode, "implementation") ?? "", /needs a handoff lane/, mode);
    assert.match(spawnRefusal(mode, "adhoc", false, true) ?? "", /requires a handoff spec/, mode);
  }
});

test("a research child cannot be given a write tool", () => {
  const tools = (childToolsForPurpose("research") ?? "").split(",");
  for (const forbidden of ["write", "edit", "multi_edit", "apply_patch", "browser", "mcp"]) {
    assert.equal(tools.includes(forbidden), false, `${forbidden} must not be handed to a research child`);
  }
  for (const required of ["read", "grep", "ffgrep", "bash", "web_read", "artifact_recall"]) {
    assert.ok(tools.includes(required), `${required} must be available for research`);
  }
  // spec/adhoc/implementation keep the canonical worker allowlist.
  for (const purpose of ["spec", "adhoc", "implementation"] as const) {
    assert.equal(childToolsForPurpose(purpose), undefined, purpose);
  }
});

test("registry purpose and lane declaration are explicit, not inferred from emptiness", () => {
  assert.equal(registryPurpose("spec"), "implementation");
  assert.equal(registryPurpose("adhoc"), "adhoc");
  assert.equal(registryPurpose("research"), "research");
  assert.equal(registryPurpose("review"), "review");

  assert.equal(laneDeclaration("adhoc", []), "not-declared");
  assert.equal(laneDeclaration("research", []), "not-declared");
  assert.equal(laneDeclaration("adhoc", ["src/a.ts"]), "declared");
  assert.equal(laneDeclaration("spec", []), "declared");
});

test("Orchestrator and Supervise require a reviewed spec for implementation", () => {
  assert.equal(requiresReviewedSpec("orchestrator"), true);
  assert.equal(requiresReviewedSpec("supervise"), true);
  assert.equal(requiresReviewedSpec("normal"), false);
  assert.equal(requiresReviewedSpec("plan"), false);
  assert.equal(requiresReviewedSpec(undefined), false);
});

test("depth and breadth are hard stops with an explicit reason", () => {
  assert.equal(depthProblem(0, 1), undefined, "a top-level session may spawn");
  assert.match(depthProblem(1, 1) ?? "", /Delegation depth limit reached/);

  assert.equal(capacityProblem(7, 8), undefined);
  assert.match(capacityProblem(8, 8) ?? "", /Child limit reached \(8\/8\)/);

  assert.equal(currentSpawnDepth({}), 0);
  assert.equal(currentSpawnDepth({ PI_SUBAGENT_DEPTH: "2" }), 2);
  assert.equal(currentSpawnDepth({ PI_SUBAGENT_DEPTH: "nope" }), 0);
  assert.equal(maxSpawnDepth({}), 1);
  assert.equal(maxSpawnDepth({ PI_SUBAGENT_MAX_DEPTH: "2" }), 2);
  assert.equal(maxChildren({}), 8);
  assert.equal(maxChildren({ PI_SUBAGENT_MAX_CHILDREN: "2" }), 2);
  assert.equal(maxChildren({ PI_SUBAGENT_MAX_CHILDREN: "0" }), 8, "a nonsense cap falls back, never to 0");
});
