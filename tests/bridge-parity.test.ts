import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { MESSAGE_NAMES } from "../web/core/protocol/catalog.ts";
import { PARITY_BASELINE, parityMarkdown } from "../web/core/protocol/parity.ts";

test("every parity row names a catalog message, an adapter and a test", () => {
  const adapters = new Set<string>();
  for (const row of PARITY_BASELINE) {
    assert.ok(row.messages.length > 0, `${row.area} has no message`);
    for (const name of row.messages) assert.ok(MESSAGE_NAMES.includes(name as never), `${row.area}: ${name}`);
    assert.match(row.adapter, /\.(ts|tsx)/, `${row.area} has no adapter`);
    assert.match(row.test, /\.test\.ts/, `${row.area} has no test`);
    adapters.add(row.adapter);
  }
  assert.ok(adapters.size > 1, "parity must cover more than one adapter");
});

test("the generated parity doc matches the baseline table", () => {
  assert.equal(readFileSync("docs/bridge-protocol-parity.md", "utf8"), parityMarkdown());
});

test("every baseline file still exists", () => {
  for (const row of PARITY_BASELINE) {
    for (const file of [row.adapter.split(" + ")[0], row.test]) {
      assert.ok(existsSync(file), `${row.area}: missing ${file}`);
    }
  }
});
