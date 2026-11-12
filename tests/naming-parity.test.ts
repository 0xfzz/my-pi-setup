import test from "node:test";
import assert from "node:assert/strict";

import * as node from "../lib/naming.ts";
import * as web from "../web/core/dashboard/src/naming.mjs";

/**
 * The Node/TS authority and the browser authority are two copies of the same
 * pure module. Pi's extension loader cannot import the web `.mjs` reliably, so
 * `lib/naming.ts` exists; this test is what keeps the copies honest.
 */
const LABELS = [
  "Auth retry",
  "Bima",
  "repo-skeleton",
  "  spaced   label  ",
  "",
  "session-abc",
  "12345",
  "Bima · Skeleton Builder",
  "Repo Skeleton Manager",
];

const IDS = ["c1", "child-2", "net-retry", "api-go", "billing", "scope:review-auth", "x".repeat(60)];

const NODES: node.NamingNode[] = [
  { id: "c1", scope: "net-retry", kind: "child" },
  { id: "c2", scope: "auth-review", kind: "review", givenName: "Bima" },
  { id: "c3", scope: "api-go", kind: "handoff" },
  { id: "c4", project: "Repo Skeleton", kind: "session" },
  { id: "c5", scope: "billing", kind: "escalation" },
  { id: "c6", title: "Retry Design", kind: "spec-review" },
  { id: "c7", name: "Bima", scope: "repo-skeleton", kind: "child" },
];

test("label helpers match the browser authority", () => {
  for (const value of LABELS) {
    assert.equal(node.meaningfulSessionTitle(value), web.meaningfulSessionTitle(value), `title ${value}`);
    assert.equal(node.isHumanName(value), web.isHumanName(value), `human ${value}`);
    assert.equal(node.humanizeSlug(value), web.humanizeSlug(value), `slug ${value}`);
    assert.equal(node.titleCase(value), web.titleCase(value), `case ${value}`);
    assert.equal(node.givenNamePart(value), web.givenNamePart(value), `given ${value}`);
  }
});

test("session and manager titles match", () => {
  for (const value of LABELS) {
    const input = { sessionName: value, project: "Repo Skeleton" };
    assert.equal(node.sessionTitle(input), web.sessionTitle(input), `session ${value}`);
    assert.equal(node.managerName(input), web.managerName(input), `manager ${value}`);
  }
});

test("deterministic given names match, including collision probing", () => {
  for (const id of IDS) {
    assert.equal(node.givenNameFor(id), web.givenNameFor(id), id);
  }
  const used = new Set(["Bima", "Wahyu", "Yanto"]);
  for (const id of IDS) {
    assert.equal(node.givenNameFor(id, used), web.givenNameFor(id, used), `used ${id}`);
  }
  const entities = IDS.map((id, index) => ({ id, name: index === 0 ? "Bima" : undefined }));
  assert.deepEqual([...node.assignGivenNames(entities)], [...web.assignGivenNames(entities)]);
});

test("display labels match for every node kind and width", () => {
  for (const value of NODES) {
    assert.equal(node.displayName(value), web.displayName(value), JSON.stringify(value));
    assert.equal(node.displayName(value, { max: 20 }), web.displayName(value, { max: 20 }));
  }
  assert.equal(node.handoffDisplayName({ scope: "repo-skeleton" }), web.handoffDisplayName({ scope: "repo-skeleton" }));
});

test("the vendored dictionary is byte-identical", () => {
  assert.equal(node.namesDigest(), web.namesDigest());
  assert.equal(node.__naming.NAME_COUNT, web.__naming.NAME_COUNT);
  assert.equal(node.__naming.NAME_DIGEST, web.__naming.NAME_DIGEST);
});
