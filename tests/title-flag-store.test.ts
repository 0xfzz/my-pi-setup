import test from "node:test";
import assert from "node:assert/strict";

import { parseAutoTitleFlag } from "../lib/title/flag-store.ts";

test("a stored choice is read only when it is a boolean", () => {
  assert.equal(parseAutoTitleFlag('{"v":1,"enabled":false}'), false);
  assert.equal(parseAutoTitleFlag('{"enabled":true}'), true);
  assert.equal(parseAutoTitleFlag('{"enabled":"no"}'), undefined);
  assert.equal(parseAutoTitleFlag("not json"), undefined);
  assert.equal(parseAutoTitleFlag("{}"), undefined);
});
