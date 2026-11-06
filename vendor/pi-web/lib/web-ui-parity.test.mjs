import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The vendored browser/server bundle cannot statically value-import the outer
// workflow contracts (Turbopack resolves only inside the vendored tree), so the
// runtime copies in this directory are pinned to the canonical outer modules.
// Any outer edit must be re-applied here or this test fails the suite.
const here = dirname(fileURLToPath(import.meta.url));
const outer = join(here, "../../../lib/web-plugins");
const rewrites = {
  "view.ts": [],
  "actions.ts": [],
  "ui-contracts.ts": [],
  "ui-event-models.ts": [['"./ui-contracts.ts"', '"./web-ui-contracts.ts"'], ['"./view.ts"', '"./web-ui-views.ts"']],
  "ui-state-store.ts": [['"./ui-event-models.ts"', '"./web-ui-event-models.ts"'], ['"./ui-contracts.ts"', '"./web-ui-contracts.ts"'], ['"./view.ts"', '"./web-ui-views.ts"']],
  "descriptor.ts": [['"./actions.ts"', '"./web-ui-actions.ts"'], ['"./ui-contracts.ts"', '"./web-ui-contracts.ts"']],
};
const copies = {
  "view.ts": "web-ui-views.ts",
  "actions.ts": "web-ui-actions.ts",
  "ui-contracts.ts": "web-ui-contracts.ts",
  "ui-event-models.ts": "web-ui-event-models.ts",
  "ui-state-store.ts": "web-ui-state-store.ts",
  "descriptor.ts": "web-ui-descriptor.ts",
};

for (const [outerName, rules] of Object.entries(rewrites)) {
  test(`web-ui copy of ${outerName} stays identical to the outer contract`, () => {
    let expected = readFileSync(join(outer, outerName), "utf8");
    for (const [from, to] of rules) expected = expected.replaceAll(from, to);
    const actual = readFileSync(join(here, copies[outerName]), "utf8");
    assert.equal(actual, expected);
  });
}
