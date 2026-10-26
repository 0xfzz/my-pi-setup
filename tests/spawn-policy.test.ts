import test from "node:test";
import assert from "node:assert/strict";

import {
  allowedSpawnPurposes,
  childToolsForPurpose,
  defaultSpawnPurpose,
  laneDeclaration,
  normalizeSpawnMode,
  registryPurpose,
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

test("an unknown or absent mode id is Normal, never a bypass", () => {
  assert.equal(normalizeSpawnMode(undefined), "normal");
  assert.equal(normalizeSpawnMode("off"), "normal");
  assert.equal(normalizeSpawnMode("plan"), "plan");
});
