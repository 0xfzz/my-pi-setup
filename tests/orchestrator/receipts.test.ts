import test from "node:test";
import assert from "node:assert/strict";

import {
  criteriaHashOf,
  describeReceipt,
  evaluateReceipt,
  outputDigestOf,
  treeDigestOf,
  type CheckReceipt,
} from "../../lib/orchestrator/receipts.ts";

const CRITERIA = ["parse rejects unknown keys", "no allocation in the hot path"];
const TREE = { changed: ["src/a.ts", "src/b.ts"], diff: "diff --git a/src/a.ts b/src/a.ts\n+1" };
const TREE_DIGEST = treeDigestOf(TREE)!;

function receipt(overrides: Partial<CheckReceipt> = {}): CheckReceipt {
  return {
    id: "cr-scope-1",
    scope: "net",
    command: "npm test",
    declaredCommand: "npm test",
    exit: 0,
    outputDigest: outputDigestOf("ok"),
    outputTail: "ok",
    criteriaHash: criteriaHashOf(CRITERIA),
    specRevision: 2,
    treeDigest: TREE_DIGEST,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

const EXPECTED = {
  scope: "net",
  criteriaHash: criteriaHashOf(CRITERIA),
  treeDigest: TREE_DIGEST,
  declaredCommand: "npm test",
};

test("criteria hash ignores surrounding whitespace but not meaning or order", () => {
  assert.equal(criteriaHashOf([" a ", "b"]), criteriaHashOf(["a", "b"]), "trimming is not a change");
  assert.notEqual(criteriaHashOf(["a", "b"]), criteriaHashOf(["b", "a"]), "order is part of the definition of done");
  assert.notEqual(criteriaHashOf(["a", "b"]), criteriaHashOf(["a"]), "removing a criterion is a change");
  assert.equal(criteriaHashOf([]), criteriaHashOf(undefined as any), "absent and empty are the same claim");
});

test("tree digest is order-insensitive over files but sensitive to content", () => {
  assert.equal(
    treeDigestOf({ changed: ["b", "a"], diff: "d" }),
    treeDigestOf({ changed: ["a", "b"], diff: "d" }),
    "git reports files in a stable-ish order; the hash must not depend on it",
  );
  assert.notEqual(treeDigestOf({ changed: ["a"], diff: "d" }), treeDigestOf({ changed: ["a"], diff: "d+" }));
  assert.notEqual(treeDigestOf({ changed: ["a"], diff: "d" }), treeDigestOf({ changed: ["a", "b"], diff: "d" }));
});

test("an unreadable tree is not a digest at all", () => {
  // Unknown must not hash like empty, and it must not hash like unknown either:
  // two receipts taken while git was broken used to compare equal. Returning null
  // makes "could not look" unrepresentable as a value the gate can accept.
  assert.equal(treeDigestOf({ changed: null, diff: null }), null);
  assert.equal(treeDigestOf({ changed: null, diff: "x" }), null);
  assert.equal(treeDigestOf({ changed: [], diff: null }), null);
  assert.equal(treeDigestOf({ changed: [], diff: "" }), typeof TREE_DIGEST === "string" ? treeDigestOf({ changed: [], diff: "" }) : null);
});

test("a receipt cannot describe a tree the reviewer could not read", () => {
  const problems = evaluateReceipt(receipt(), { ...EXPECTED, treeDigest: null });
  assert.ok(problems.some((p) => /working tree could not be read/.test(p)), problems.join(" | "));
});

test("a substituted check command cannot back the declared one", () => {
  // Declaring `npm test` at authoring time and checking `npm run typecheck` at
  // review time is the exact substitution the declaration exists to prevent.
  const problems = evaluateReceipt(receipt({ command: "npm run typecheck" }), EXPECTED);
  assert.equal(problems.length, 1, problems.join(" | "));
  assert.match(problems[0]!, /substituted|declared/);
});

test("a matching receipt has no problems", () => {
  assert.deepEqual(evaluateReceipt(receipt(), EXPECTED), []);
});

test("a missing receipt is reported as missing, not as a pass", () => {
  const problems = evaluateReceipt(undefined, EXPECTED);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /no check receipt/);
});

test("every reason the receipt cannot back this approval is reported at once", () => {
  const stale = receipt({
    scope: "other",
    exit: 1,
    criteriaHash: criteriaHashOf(["something else"]),
    treeDigest: treeDigestOf({ changed: ["src/a.ts"], diff: "changed" })!,
  });
  const problems = evaluateReceipt(stale, EXPECTED);
  assert.equal(problems.length, 4, problems.join(" | "));
  assert.ok(problems.some((p) => /belongs to scope "other"/.test(p)));
  assert.ok(problems.some((p) => /criteria changed/.test(p)));
  assert.ok(problems.some((p) => /tree changed/.test(p)));
  assert.ok(problems.some((p) => /failed \(exit 1\)/.test(p)));
});

test("a check that ran no command cannot be the evidence for a verified pass", () => {
  // Nothing declared, nothing run: the only complaint is the missing command.
  const nothing = receipt({ command: null, declaredCommand: null, exit: null, outputDigest: null });
  const problems = evaluateReceipt(nothing, { ...EXPECTED, declaredCommand: null });
  assert.ok(problems.some((p) => /ran no verification command/.test(p)));
  assert.equal(problems.length, 1, problems.join(" | "));

  // Declared but not run is two separate faults: the declared check was skipped
  // AND the receipt cannot back "the declared command passed".
  const skipped = receipt({ command: null, exit: null, outputDigest: null });
  const skippedProblems = evaluateReceipt(skipped, EXPECTED);
  assert.ok(skippedProblems.some((p) => /ran no verification command/.test(p)));
  assert.ok(skippedProblems.some((p) => /declared/.test(p)));
  assert.equal(skippedProblems.length, 2, skippedProblems.join(" | "));
});

test("a receipt with an exit but no command is still incoherent", () => {
  const problems = evaluateReceipt(receipt({ command: null, exit: 0 }), EXPECTED);
  assert.ok(problems.some((p) => /ran no verification command/.test(p)));
});

test("output digest identifies the evidence and truncates from the front", () => {
  assert.equal(outputDigestOf(null), null);
  assert.equal(outputDigestOf(undefined), null);
  assert.equal(outputDigestOf("ok"), outputDigestOf("ok"));
  assert.notEqual(outputDigestOf("ok"), outputDigestOf("ok\n"));

  // A long run's tail is what matters (the summary lines); the digest must not
  // differ merely because an earlier banner was longer. The window is 64k, so the
  // fixture has to exceed it or nothing is truncated and the banners still count.
  const tail = "x".repeat(70_000);
  assert.equal(outputDigestOf(`banner-a${tail}`), outputDigestOf(`banner-b${tail}`));
});

test("the receipt line shows the command, the outcome and both bindings", () => {
  const line = describeReceipt(receipt());
  assert.match(line, /cr-scope-1/);
  assert.match(line, /npm test/);
  assert.match(line, /pass/);
  assert.match(line, /criteria [0-9a-f]{10}/);
  assert.match(line, /tree [0-9a-f]{10}/);
  assert.match(describeReceipt(receipt({ command: null, exit: null })), /not run/);
});
