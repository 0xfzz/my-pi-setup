import test from "node:test";
import assert from "node:assert/strict";
import { assertBundleWithinBudget, INITIAL_BUNDLE_BUDGETS } from "../web/bundle-budget.mjs";

test("an initial bundle inside its budget is accepted", () => {
  assert.doesNotThrow(() => assertBundleWithinBudget("runtime.js", 400_000));
});

test("an oversized initial bundle names the overrun", () => {
  assert.throws(
    () => assertBundleWithinBudget("ui.js", 900_000),
    /ui\.js is 900000 bytes, over its \d+-byte budget/,
  );
});

test("a bundle with no declared budget is rejected", () => {
  assert.throws(() => assertBundleWithinBudget("mystery.js", 1), /no bundle budget/);
});

test("initial bundles all have explicit ceilings", () => {
  assert.deepEqual(Object.keys(INITIAL_BUNDLE_BUDGETS).sort(), ["app.js", "runtime.js", "ui.js"]);
});
