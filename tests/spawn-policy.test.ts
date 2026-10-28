import test from "node:test";
import assert from "node:assert/strict";

import { allowedSpawnPurposes, spawnRefusal } from "../lib/spawn-policy.ts";

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
