import test from "node:test";
import assert from "node:assert/strict";

import {
  EXTENSION_POINTS,
  POINT_KINDS,
  catalogMarkdown,
  isProtectedPoint,
  lookupPoint,
  stablePoints,
} from "../web/core/plugin-contracts/kernel/catalog.ts";
import {
  OVERRIDABLE_COMPONENTS,
  WEB_UI_ANCHORS,
  WEB_UI_COMPONENTS,
} from "../web/core/plugin-contracts/ui-contracts.ts";

test("every catalogued id is unique and uses a known kind", () => {
  const ids = EXTENSION_POINTS.map((point) => point.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate id in catalog");
  for (const point of EXTENSION_POINTS) {
    assert.ok((POINT_KINDS as readonly string[]).includes(point.kind), `${point.id} kind ${point.kind}`);
    assert.ok(Number.isInteger(point.version) && point.version >= 1, `${point.id} version`);
  }
});

test("the catalog lists only kinds the kernel validates against", () => {
  // UI placement is a separate vocabulary with its own source; routes,
  // commands, keybindings, themes, jobs, bridges and taps have no registry to
  // validate them, so they are not catalogued at all.
  assert.deepEqual([...POINT_KINDS].sort(), ["bail", "event", "protected", "service", "waterfall"]);
});

test("every hook point names a kind the hook bus dispatches", () => {
  const hookKinds = ["event", "waterfall", "bail"];
  for (const point of EXTENSION_POINTS) {
    if (point.kind === "service" || point.kind === "protected") continue;
    assert.ok(hookKinds.includes(point.kind), `${point.id} is a ${point.kind}, which hooks do not dispatch`);
  }
});

test("unknown points are rejected with the id named", () => {
  const result = lookupPoint("chat.message.bubble");
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /unknown extension point "chat\.message\.bubble"/);
});

test("a point that nothing invokes is not catalogued", () => {
  // These were declared with no consumer in the host; a catalogued point that
  // is never called is a promise the kernel breaks.
  for (const gone of ["session.title.generate", "service:notifier", "service:title-generator", "job.schedule", "route.page"]) {
    assert.equal(lookupPoint(gone).ok, false, gone);
  }
});

test("version pins: the current version resolves, other versions do not", () => {
  assert.equal(lookupPoint("session.created@1").ok, true);
  const v2 = lookupPoint("session.created@2");
  assert.equal(v2.ok, false);
  assert.match(v2.ok ? "" : v2.error, /is version 1; "@2" is not served/);
});

test("protected points cannot be replaced: auth, transport, plugin manager, gate, confirmations", () => {
  for (const id of ["core.auth.session", "core.transport", "core.plugin-manager", "core.capability-gate", "core.confirm.destructive"]) {
    assert.equal(isProtectedPoint(id), true, id);
  }
  assert.equal(isProtectedPoint("session.created"), false);
  assert.equal(isProtectedPoint("not.a.point"), false);
});

test("the stable set includes the contracts plugins are told to depend on", () => {
  const stable = stablePoints().map((point) => point.id);
  for (const id of ["prompt.before-send", "session.before-delete"]) assert.ok(stable.includes(id), id);
});

test("generated markdown documents both vocabularies from their own source", () => {
  const doc = catalogMarkdown();
  for (const point of EXTENSION_POINTS) assert.ok(doc.includes(`\`${point.id}@${point.version}\``), point.id);
  for (const anchor of WEB_UI_ANCHORS) assert.ok(doc.includes(`\`${anchor}\` | anchor`), anchor);
  for (const component of Object.keys(WEB_UI_COMPONENTS)) assert.ok(doc.includes(`\`${component}\` | component`), component);
  for (const component of OVERRIDABLE_COMPONENTS) {
    assert.match(doc, new RegExp(`\`${component.replace(/\./g, "\\.")}\` \\| component \\| .*overridable`), component);
  }
});
