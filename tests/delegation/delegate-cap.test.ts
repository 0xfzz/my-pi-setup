import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MAX_DELEGATES,
  MAX_DELEGATES_LIMIT,
  delegateCapRefusal,
  parseMaxDelegates,
  resolveMaxDelegates,
} from "../../lib/delegation/delegate-cap.ts";

test("the default cap is 5 and invalid settings fall back to it", () => {
  for (const settings of [undefined, {}, { maxDelegates: "nope" }, { maxDelegates: 0 }, { maxDelegates: 1.5 }]) {
    assert.equal(resolveMaxDelegates(settings as any), DEFAULT_MAX_DELEGATES);
  }
});

test("a configured cap is honoured and clamped to the sanity ceiling", () => {
  assert.equal(resolveMaxDelegates({ maxDelegates: 3 }), 3);
  assert.equal(resolveMaxDelegates({ maxDelegates: "7" }), 7);
  assert.equal(resolveMaxDelegates({ maxDelegates: 999 }), MAX_DELEGATES_LIMIT);
});

test("parse accepts 1..20 and rejects everything else", () => {
  assert.deepEqual(parseMaxDelegates("1"), { ok: true, value: 1 });
  assert.deepEqual(parseMaxDelegates("20"), { ok: true, value: 20 });
  for (const bad of ["0", "21", "-1", "abc", "1.5", ""]) {
    assert.equal(parseMaxDelegates(bad).ok, false, bad);
  }
});

test("the refusal fires at the cap, not below it", () => {
  assert.equal(delegateCapRefusal(["a", "b", "c", "d"], 5), undefined);
  const at = delegateCapRefusal(["a", "b", "c", "d", "e"], 5);
  assert.ok(at);
  assert.match(at, /5 agent\(s\) are already running/);
  assert.match(at, /\/agent max <n>/);
});
