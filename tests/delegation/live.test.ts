import test from "node:test";
import assert from "node:assert/strict";

import { hasLiveDelegation, setDelegationProbe } from "../../lib/delegation/live.ts";

test("no probe means no live delegation, so an unrelated wait is never refused", () => {
  setDelegationProbe(undefined);
  assert.equal(hasLiveDelegation(), false);
  assert.equal(hasLiveDelegation("session-a"), false);
});

test("the installed probe decides, and is asked with the owner id", () => {
  const asked: (string | undefined)[] = [];
  setDelegationProbe((owner) => {
    asked.push(owner);
    return owner === "session-a";
  });
  assert.equal(hasLiveDelegation("session-a"), true);
  assert.equal(hasLiveDelegation("session-b"), false);
  assert.deepEqual(asked, ["session-a", "session-b"]);
  setDelegationProbe(undefined);
});

test("a probe that throws is not evidence of a wait", () => {
  setDelegationProbe(() => {
    throw new Error("registry disposed");
  });
  assert.equal(hasLiveDelegation("session-a"), false, "a broken probe must not block a command");
  setDelegationProbe(undefined);
});

test("clearing the probe after shutdown disarms the guard for the next session", () => {
  setDelegationProbe(() => true);
  assert.equal(hasLiveDelegation(), true);
  setDelegationProbe(undefined);
  assert.equal(hasLiveDelegation(), false);
});
