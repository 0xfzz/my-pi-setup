/**
 * One matcher, two questions.
 *
 * Admission asks "do these two lanes overlap?" and review asks "does this lane
 * cover this changed file?". They used to be separate implementations that
 * agreed by comment only: the registry's version had no glob support, so a lane
 * could be disjoint at spawn and overlapping at review — two writers in one lane.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { laneCoversPath, lanesOverlap, pathMatchesAnyLane } from "../../lib/orchestrator/lane.ts";
import { pathMatchesAnyLane as reexported } from "../../lib/orchestrator/evidence.ts";
import { ScopeRegistry, type ScopedChild } from "../../lib/orchestrator/scope-registry.ts";

describe("lane matcher", () => {
  it("covers exact paths, directory prefixes, and bare filenames", () => {
    assert.equal(laneCoversPath("src/net/", "src/net/retry.ts"), true);
    assert.equal(laneCoversPath("src/net", "src/net/retry.ts"), true);
    assert.equal(laneCoversPath("src/net/client.ts", "src/net/client.ts"), true);
    assert.equal(laneCoversPath("src/net/client.ts", "src/net/other.ts"), false);
    assert.equal(laneCoversPath("client.ts", "src/net/client.ts"), true, "a bare filename names that file wherever it lives");
    assert.equal(laneCoversPath("*.md", "docs/README.md"), false, "a bare glob does not cross directories");
    assert.equal(laneCoversPath("**/*.md", "docs/README.md"), true);
  });

  it("treats overlap as symmetric, globs included", () => {
    assert.equal(lanesOverlap("src/net/", "src/net/retry.ts"), true);
    assert.equal(lanesOverlap("src/net/retry.ts", "src/net/"), true);
    assert.equal(lanesOverlap("src/net/", "src/auth/"), false);
    assert.equal(lanesOverlap("**/*.md", "docs/README.md"), true);
    assert.equal(lanesOverlap("docs/README.md", "**/*.md"), true);
  });

  it("the evidence re-export is the same function, not a copy", () => {
    for (const [lane, candidate] of [
      ["src/net/", "src/net/a.ts"],
      ["**/*.md", "docs/x.md"],
      ["client.ts", "src/net/client.ts"],
      ["src/net/", "src/auth/a.ts"],
    ] as const) {
      assert.equal(reexported([lane], candidate), pathMatchesAnyLane([lane], candidate));
      assert.equal(reexported([lane], candidate), laneCoversPath(lane, candidate));
    }
  });
});

describe("admission uses the review matcher", () => {
  const child = (id: string, laneFiles: string[]): ScopedChild =>
    ({
      id,
      name: id,
      scope: id,
      sessionFile: `/tmp/${id}.jsonl`,
      status: "running",
      laneFiles,
      lastMilestoneFiles: [],
      updatedAt: new Date(0).toISOString(),
      watchdog: { trip: null, interrupts: 0 },
    }) as ScopedChild;

  it("refuses a glob lane that covers an active child's file", () => {
    const registry = new ScopeRegistry();
    registry.registerChild(child("docs", ["docs/README.md"]));
    // The old registry matcher compared exact paths and directory prefixes only,
    // so this returned [] and two children could be admitted into one file.
    assert.equal(registry.findLaneConflicts(["**/*.md"]).length, 1);
    assert.equal(registry.findLaneConflicts(["src/net/"]).length, 0);
  });

  it("keeps the prefix rule in both directions", () => {
    const registry = new ScopeRegistry();
    registry.registerChild(child("net", ["src/net/client.ts"]));
    assert.equal(registry.findLaneConflicts(["src/net/"]).length, 1);
    assert.equal(registry.findLaneConflicts(["src/net/client.ts"]).length, 1);
    assert.equal(registry.findLaneConflicts(["src/auth/"]).length, 0);
  });
});
