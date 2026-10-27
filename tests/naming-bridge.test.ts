import test from "node:test";
import assert from "node:assert/strict";

import * as authority from "../web/dashboard/src/naming.mjs";
import {
  meaningfulSessionTitle,
  sessionTitle,
  givenNameFor,
  isHumanName,
  unwrapNaming,
} from "../lib/naming.ts";

/**
 * Pi's extension loader can hand a CJS module an `.mjs` namespace wrapped as
 * `{ default: namespace }`. Named imports then evaluate to undefined and the
 * dashboard crashes on reload. These tests pin the unwrap, not the loader.
 */
test("the naming bridge unwraps both interop shapes", () => {
  assert.equal(unwrapNaming(authority), authority, "a plain namespace is used as-is");
  assert.equal(unwrapNaming({ default: authority }), authority, "a default-wrapped namespace is unwrapped");
});

test("named naming exports survive the bridge", () => {
  assert.equal(meaningfulSessionTitle("Auth retry"), "Auth retry");
  assert.equal(sessionTitle({ project: "workflow", goalTitle: "Auth retry" }), "Auth retry");
  assert.equal(isHumanName("Bima"), true);
  assert.match(givenNameFor("scope:net-retry"), /\S/);
});
