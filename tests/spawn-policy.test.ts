import test from "node:test";
import assert from "node:assert/strict";

import { allowedSpawnPurposes, childToolsForPurpose, spawnRefusal } from "../lib/spawn-policy.ts";

test("ad-hoc and research are admitted in Normal and Plan", () => {
  for (const mode of ["normal", "plan"]) {
    assert.deepEqual(allowedSpawnPurposes(mode), ["adhoc", "research"]);
    assert.equal(spawnRefusal(mode, "adhoc"), undefined);
    assert.equal(spawnRefusal(mode, "research"), undefined);
  }
});

test("the mode cannot change what a child is allowed to exist for", () => {
  // The invariant the docs and the guidance kept contradicting: a mode narrows
  // the PARENT's tools, never the child's purpose. Compared across every mode
  // spelling, including one this build does not know, so a future mode cannot
  // silently reintroduce a mode-dependent spawn table.
  const baseline = allowedSpawnPurposes("normal");
  for (const mode of ["plan", "supervise", "orchestrator", undefined, ""]) {
    assert.deepEqual(allowedSpawnPurposes(mode), baseline, `mode ${String(mode)} changed the admitted purposes`);
    assert.equal(spawnRefusal(mode, "adhoc"), undefined);
    assert.equal(spawnRefusal(mode, "research"), undefined);
    for (const removed of ["spec", "implementation", "review"] as const) {
      assert.match(spawnRefusal(mode, removed)!, /ad-hoc only/, `mode ${String(mode)} admitted ${removed}`);
    }
  }
});

test("the removed pipeline purposes are refused with a clear reason", () => {
  for (const purpose of ["spec", "implementation", "review"] as const) {
    assert.match(spawnRefusal("normal", purpose)!, /ad-hoc only/);
  }
});

test("childToolsForPurpose provides a read-only surface for research/planner without write tools or bash", () => {
  const tools = (childToolsForPurpose("research") ?? "").split(",");
  for (const tool of ["read", "grep", "find", "ls", "ffgrep", "fffind", "shell_read", "artifact_save", "artifact_edit", "artifact_recall"]) {
    assert.ok(tools.includes(tool), `research tools should include ${tool}`);
  }
  for (const tool of ["bash", "write", "edit", "browser", "agent_spawn"]) {
    assert.ok(!tools.includes(tool), `research tools must not include ${tool}`);
  }

  // Worker (adhoc) gets undefined which resolves to full worker capability
  assert.equal(childToolsForPurpose("adhoc"), undefined);
});
