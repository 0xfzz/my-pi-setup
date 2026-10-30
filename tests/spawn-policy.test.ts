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
