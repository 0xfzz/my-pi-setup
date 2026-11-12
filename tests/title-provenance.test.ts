import test from "node:test";
import assert from "node:assert/strict";

import {
  generationCount,
  isGeneratedName,
  latestTitleRecord,
  TITLE_RECORD_ENTRY,
} from "../lib/title/provenance.ts";

function record(data: Record<string, unknown>, customType = TITLE_RECORD_ENTRY) {
  return { type: "custom", customType, data: { v: 1, ownerSessionId: "s1", source: "auto", generation: 1, ...data } };
}

test("the latest record for this session wins, and other sessions are ignored", () => {
  const branch = [
    record({ title: "First title", generation: 1 }),
    record({ title: "Other session", ownerSessionId: "s2", generation: 9 }),
    record({ title: "Second title", generation: 2, source: "manual" }),
  ];
  assert.equal(latestTitleRecord(branch, "s1")?.title, "Second title");
  assert.equal(generationCount(branch, "s1"), 2);
  assert.equal(generationCount(branch, "s3"), 0);
});

test("malformed or foreign entries are not provenance", () => {
  const branch = [
    record({ title: "Wrong version", v: 2 }),
    record({ title: "Bad source", source: "rename" }),
    record({ title: "Missing generation", generation: undefined }),
    record({ title: "Other kind" }, "workflow-dashboard-goal:v1"),
  ];
  assert.equal(latestTitleRecord(branch, "s1"), undefined);
});

test("a name is generated only while it equals the latest generated title", () => {
  const branch = [record({ title: "Fix Login Bug" })];
  assert.equal(isGeneratedName(branch, "s1", "Fix Login Bug"), true);
  assert.equal(isGeneratedName(branch, "s1", "Fix login bug, my edit"), false, "a person's rename is not generated");
  assert.equal(isGeneratedName(branch, "s1", undefined), false);
  assert.equal(isGeneratedName([], "s1", "Fix Login Bug"), false, "no record, nothing is generated");
});
