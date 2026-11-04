import assert from "node:assert/strict";
import test from "node:test";

import { deprioritizeCooling, targetCooldownMs } from "../lib/provider/model-routes.ts";

test("cooling targets move behind healthy ones, order preserved", () => {
  assert.deepEqual(deprioritizeCooling(["a", "b", "c"], (t) => t === "a"), ["b", "c", "a"]);
});

test("when every target is cooling the declared order is kept", () => {
  assert.deepEqual(deprioritizeCooling(["a", "b"], () => true), ["a", "b"]);
});

test("quota walls cool longer than transient errors; overflow never cools", () => {
  assert.ok(targetCooldownMs("quota") > targetCooldownMs("other"));
  assert.equal(targetCooldownMs("overflow"), 0);
});
