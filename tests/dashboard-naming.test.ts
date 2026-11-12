import test from "node:test";
import assert from "node:assert/strict";

import {
  JAVANESE_GIVEN_NAMES,
  NAMES_SOURCE,
  __naming,
  assignGivenNames,
  displayName,
  givenNameFor,
  handoffDisplayName,
  humanizeSlug,
  isHumanName,
  managerName,
  roleFor,
  titleCase,
} from "../web/core/dashboard/src/naming.mjs";

/* ------------------------------------------------------------- dictionary */

test("vendored name list is complete, unique, ASCII, sorted and immutable", () => {
  assert.equal(JAVANESE_GIVEN_NAMES.length, 278);
  assert.equal(NAMES_SOURCE.count, 278);
  assert.equal(NAMES_SOURCE.license, "CC BY-SA 4.0");
  assert.match(NAMES_SOURCE.url, /wiktionary\.org\/wiki\/Category:/);
  assert.equal(__naming.NAME_COUNT, 278);

  const unique = new Set(JAVANESE_GIVEN_NAMES);
  assert.equal(unique.size, 278, "every name is unique");
  for (const name of JAVANESE_GIVEN_NAMES) {
    assert.ok(name.length > 0, "no empty names");
    assert.match(name, /^[A-Za-z]+$/, `ASCII-only name: ${name}`);
  }
  const sorted = [...JAVANESE_GIVEN_NAMES].sort((a, b) => a.localeCompare(b, "en"));
  assert.deepEqual([...JAVANESE_GIVEN_NAMES], sorted, "the list stays sorted for diffability");

  assert.ok(Object.isFrozen(JAVANESE_GIVEN_NAMES), "the dictionary is frozen");
  assert.ok(Object.isFrozen(NAMES_SOURCE), "the source record is frozen");
  assert.throws(() => {
    // @ts-expect-error — frozen at runtime on purpose
    JAVANESE_GIVEN_NAMES.push("Intruder");
  }, TypeError);

  // An accidental edit to the list changes this digest, so review sees it.
  assert.equal(__naming.NAME_DIGEST, "d87bcbf1");
});

/* ------------------------------------------------------------- assignment */

test("the same id always resolves to the same name", () => {
  const first = givenNameFor("child:c1");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    assert.equal(givenNameFor("child:c1"), first);
  }
  assert.ok(JAVANESE_GIVEN_NAMES.includes(first));
});

test("assignment is independent of delivery order and collision-free", () => {
  const entities = Array.from({ length: 40 }, (_, index) => ({ id: `child:c${index}`, name: `worker-${index}` }));
  const forward = assignGivenNames(entities);
  const reversed = assignGivenNames([...entities].reverse());
  const shuffled = assignGivenNames([...entities].sort(() => 0.5 - Math.random()));
  assert.deepEqual([...forward.entries()].sort(), [...reversed.entries()].sort());
  assert.deepEqual([...forward.entries()].sort(), [...shuffled.entries()].sort());

  const names = [...forward.values()];
  assert.equal(new Set(names).size, names.length, "no two live workers share a given name");
  for (const name of names) assert.ok(JAVANESE_GIVEN_NAMES.includes(name));
});

test("collisions probe past a claimed name instead of duplicating it", () => {
  // Find two ids that hash into the same dictionary slot, then check that the
  // second one is probed forward rather than reusing the ticked-over name.
  const bySlot = new Map<number, string[]>();
  for (let index = 0; index < 5000; index += 1) {
    const id = `child:probe-${index}`;
    const slot = __naming.NAME_COUNT === 0 ? 0 : (function hash(value: string) {
      let hashValue = 0x811c9dc5;
      for (let i = 0; i < value.length; i += 1) {
        hashValue ^= value.charCodeAt(i);
        hashValue = Math.imul(hashValue, 0x01000193);
      }
      return hashValue >>> 0;
    })(id) % 278;
    const list = bySlot.get(slot) ?? [];
    list.push(id);
    bySlot.set(slot, list);
    if (list.length === 2) break;
  }
  const pair = [...bySlot.values()].find((list) => list.length === 2);
  assert.ok(pair, "fixture ids share a hash slot");
  const used = new Set<string>();
  const first = givenNameFor(pair![0], used);
  const second = givenNameFor(pair![1], used);
  assert.notEqual(first, second, "the probe skips an already claimed name");
});

test("explicit human names win, slugs do not", () => {
  const assigned = assignGivenNames([
    { id: "child:a", name: "Bima" },
    { id: "child:b", name: "api-worker" },
    { id: "child:c", name: "Wayan Kusuma" },
    { id: "child:d", name: "" },
  ]);
  assert.equal(assigned.get("child:a"), "Bima", "an author-chosen name is kept");
  assert.equal(assigned.get("child:c"), "Wayan Kusuma");
  assert.ok(JAVANESE_GIVEN_NAMES.includes(assigned.get("child:b")!), "a slug is replaced by a dictionary name");
  assert.ok(JAVANESE_GIVEN_NAMES.includes(assigned.get("child:d")!));
  assert.notEqual(assigned.get("child:a"), assigned.get("child:b"));
});

test("past 278 concurrent children the fallback stays unique and ordered", () => {
  const entities = Array.from({ length: 300 }, (_, index) => ({ id: `child:overflow-${String(index).padStart(3, "0")}` }));
  const assigned = assignGivenNames(entities);
  const names = [...assigned.values()];
  assert.equal(new Set(names).size, 300, "no duplicate label even when the dictionary is exhausted");
  const overflow = names.filter((name) => / \d+$/.test(name));
  assert.equal(overflow.length, 300 - 278);
  for (const name of overflow) assert.match(name, /^[A-Za-z]+ \d+$/);
});

/* ----------------------------------------------------------- composition */

test("worker labels read as a person plus a role", () => {
  assert.equal(
    displayName({ id: "child:c1", scope: "repo-skeleton", purpose: "implementation" }, { givenName: "Bima" }),
    "Bima · Skeleton Builder",
  );
  assert.equal(
    displayName({ id: "child:c2", scope: "web-core", purpose: "implementation" }, { givenName: "Joko" }),
    "Joko · Web Core Builder",
  );
  assert.equal(
    displayName({ id: "child:c3", scope: "api-go", purpose: "implementation" }, { givenName: "Sutrisno" }),
    "Sutrisno · API Go Builder",
  );
  assert.equal(displayName({ id: "child:c4", scope: "api", purpose: "review" }), `${givenNameFor("child:c4")} · API Reviewer`);
  assert.equal(
    displayName({ id: "child:c5", scope: "hardening" }, { max: 44 }),
    `${givenNameFor("child:c5")} · Hardening Verifier`,
  );
  assert.equal(
    displayName({ id: "child:c6", scope: "search-spike" }, { max: 44 }),
    `${givenNameFor("child:c6")} · Search Spike Researcher`,
  );
});

test("role nouns come from purpose before scope", () => {
  assert.equal(roleFor({ purpose: "review", scope: "web-core" }), "Reviewer");
  assert.equal(roleFor({ purpose: "implementation", scope: "review" }), "Builder");
  assert.equal(roleFor({ scope: "hardening" }), "Verifier");
  assert.equal(roleFor({ scope: "research-spike" }), "Researcher");
  assert.equal(roleFor({ scope: "auth-impl" }), "Implementer");
  assert.equal(roleFor({}), "Builder");
});

test("graph labels are capped but the role stays readable", () => {
  const long = displayName({
    id: "child:long",
    scope: "extremely-long-scope-name-for-a-work-unit-that-goes-on",
    purpose: "implementation",
  });
  assert.ok(long.length <= 32, `label capped: ${long}`);
  assert.ok(long.includes("·"));
});

test("non-worker kinds are documents, verdicts and gates — not people", () => {
  assert.equal(handoffDisplayName({ scope: "repo-skeleton" }), "Spec · Repo Skeleton");
  assert.equal(handoffDisplayName({ scope: "" }), "Spec · Handoff");
  assert.equal(displayName({ kind: "review", scope: "api" }, { givenName: "Rangga" }), "Rangga · Review");
  assert.equal(displayName({ kind: "review", scope: "api" }), "API Review");
  assert.equal(displayName({ kind: "spec-review", title: "Auth" }), "Spec Review · Auth");
  assert.equal(displayName({ kind: "escalation", scope: "api-go" }), "Escalation · API Go");
});

test("humanizeSlug keeps acronyms and drops nothing", () => {
  assert.equal(humanizeSlug("api-go"), "API Go");
  assert.equal(humanizeSlug("ui"), "UI");
  assert.equal(humanizeSlug("cli-tooling"), "CLI Tooling");
  assert.equal(humanizeSlug("repo-skeleton"), "Repo Skeleton");
  assert.equal(humanizeSlug("web_core.v2"), "Web Core V2");
  assert.equal(titleCase("pi-workflow-extensions"), "Pi Workflow Extensions");
});

/* --------------------------------------------------------------- manager */

test("the parent session reads as {Project} Manager, never as a worker", () => {
  assert.equal(managerName({ project: "pi-workflow-extensions" }), "Pi Workflow Extensions Manager");
  assert.equal(
    managerName({ project: "pi-workflow-extensions", sessionName: "aa2e0e1c-1c2b-4d3e-8f90-0123456789ab" }),
    "Pi Workflow Extensions Manager",
  );
  for (const bad of ["", "unknown", "tmp", "home", "aa2e0e1c-1c2b-4d3e-8f90-0123456789ab", "0123456789abcdef", "12345"]) {
    assert.equal(managerName({ project: bad, sessionName: bad }), "Workflow Manager", `rejects ${JSON.stringify(bad)}`);
  }
  const long = managerName({ project: "an-extremely-long-project-name-that-would-overflow-the-header" });
  assert.ok(long.length <= 40);
  assert.ok(long.endsWith(" Manager"));
  assert.ok(!JAVANESE_GIVEN_NAMES.includes(long.split(" ")[0]), "the manager is not a dictionary name");
});

test("isHumanName distinguishes names from slugs, ids and markup", () => {
  assert.equal(isHumanName("Bima"), true);
  assert.equal(isHumanName("API worker"), true);
  assert.equal(isHumanName("Wayan Kusuma"), true);
  assert.equal(isHumanName("api-worker"), false);
  assert.equal(isHumanName("web_core"), false);
  assert.equal(isHumanName("aa2e0e1c-1c2b-4d3e-8f90-0123456789ab"), false);
  assert.equal(isHumanName("c1"), false);
  assert.equal(isHumanName("child:c1"), false);
  assert.equal(isHumanName("unknown"), false);
  assert.equal(isHumanName(""), false);
  assert.equal(isHumanName('</text><script>alert("xss")</script>'), false);
});

test("display names never leak a uuid or a bare slug for a person", () => {
  const uuid = "aa2e0e1c-1c2b-4d3e-8f90-0123456789ab";
  const label = displayName({ id: uuid, name: uuid, scope: "api", purpose: "implementation" });
  assert.ok(!label.includes(uuid));
  assert.match(label, /^[A-Za-z]+ · API Builder$/);
  const slugLabel = displayName({ id: "child:slug", name: "api-worker", scope: "api" });
  assert.ok(!slugLabel.includes("api-worker"));
});
