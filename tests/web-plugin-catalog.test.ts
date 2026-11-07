import test from "node:test";
import assert from "node:assert/strict";

import {
  EXTENSION_POINTS,
  POINT_KINDS,
  catalogMarkdown,
  isProtectedPoint,
  lookupPoint,
  stablePoints,
} from "../lib/web-plugins/kernel/catalog.ts";

test("every catalogued id is unique and uses a known kind", () => {
  const ids = EXTENSION_POINTS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate id in catalog");
  for (const p of EXTENSION_POINTS) {
    assert.ok((POINT_KINDS as readonly string[]).includes(p.kind), `${p.id} kind ${p.kind}`);
    assert.ok(Number.isInteger(p.version) && p.version >= 1, `${p.id} version`);
  }
});

test("family placeholders match one concrete segment, and only that", () => {
  assert.equal(lookupPoint("chat.tool.bash").ok, true);
  assert.equal(lookupPoint("chat.tool.result.read").ok, true);
  assert.equal(lookupPoint("file.viewer.image/png").ok, true, "a MIME type is one placeholder value");
  assert.equal(lookupPoint("file.viewer.image").ok, true);
  assert.equal(lookupPoint("chat.tool.a.b").ok, false, "a name is one segment");
});

test("unknown points are rejected with the id named", () => {
  const result = lookupPoint("chat.message.bubble");
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /unknown extension point "chat\.message\.bubble"/);
});

test("version pins: the current version resolves, other versions do not", () => {
  assert.equal(lookupPoint("chat.working@1").ok, true);
  const v2 = lookupPoint("chat.working@2");
  assert.equal(v2.ok, false);
  assert.match(v2.ok ? "" : v2.error, /is version 1; "@2" is not served/);
});

test("protected points cannot be replaced: auth, transport, plugin manager, gate, confirmations", () => {
  for (const id of ["core.auth.session", "core.transport", "core.plugin-manager", "core.capability-gate", "core.confirm.destructive"]) {
    assert.equal(isProtectedPoint(id), true, id);
  }
  assert.equal(isProtectedPoint("chat.working"), false);
  assert.equal(isProtectedPoint("not.a.point"), false);
});

test("legacy component keys map onto the catalog so existing descriptors keep resolving", () => {
  const legacy = EXTENSION_POINTS.filter((p) => p.legacyComponent).map((p) => p.legacyComponent);
  assert.deepEqual(
    [...legacy].sort(),
    ["ui.chat-before.v1", "ui.extension-status.v1", "ui.floating-layer.v1", "ui.plugin-view.v1", "ui.session-sidebar-row.v1", "ui.working-indicator.v1"].sort(),
  );
});

test("the stable set includes the contracts plugins are told to depend on", () => {
  const stable = stablePoints().map((p) => p.id);
  for (const id of ["prompt.before-send", "session.before-delete"]) assert.ok(stable.includes(id), id);
});

test("generated markdown lists every catalogued point with its version", () => {
  const doc = catalogMarkdown();
  for (const p of EXTENSION_POINTS) assert.ok(doc.includes(`\`${p.id}@${p.version}\``), p.id);
});
