import test from "node:test";
import assert from "node:assert/strict";
import { diverge, fingerprint } from "../lib/payload-fingerprint.ts";

const body = (input: unknown[], extra: object = {}) => ({ model: "m", instructions: "sys", input, ...extra });

test("an appended request shares the whole previous item list", () => {
  const a = fingerprint(body(["u", "a"]))!;
  const b = fingerprint(body(["u", "a", "r"]))!;
  assert.deepEqual(diverge(a, b), { changedFields: [], sharedItems: 2, previousItems: 2, currentItems: 3 });
});

test("a changed item is reported as the first divergence", () => {
  const d = diverge(fingerprint(body(["u", "tail1"]))!, fingerprint(body(["u", "a", "tail2"]))!);
  assert.equal(d.firstChangedItem, 1);
  assert.equal(d.sharedItems, 1);
});

test("a changed top-level field is named", () => {
  const d = diverge(fingerprint(body(["u"], { tools: [1] }))!, fingerprint(body(["u"], { tools: [1, 2] }))!);
  assert.deepEqual(d.changedFields, ["tools"]);
});

test("a payload without an item list has no fingerprint", () => {
  assert.equal(fingerprint({ model: "m" }), undefined);
  assert.equal(fingerprint("x"), undefined);
});
