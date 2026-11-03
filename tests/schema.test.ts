import test from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { stringEnum } from "../lib/schema.ts";

test("stringEnum serialises as a flat enum and still validates", () => {
  const schema = stringEnum(["a", "b"], { description: "pick" });
  assert.deepEqual(JSON.parse(JSON.stringify(schema)), { type: "string", enum: ["a", "b"], description: "pick" });
  assert.equal(Value.Check(schema, "a"), true);
  assert.equal(Value.Check(schema, "c"), false);
});
