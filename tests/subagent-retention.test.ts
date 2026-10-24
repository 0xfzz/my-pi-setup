import test from "node:test";
import assert from "node:assert/strict";
import { PROGRESS_SUFFIX, type ChildRecord } from "../lib/subagent-state.ts";
import {
  RETENTION_DEFAULT_DAYS,
  describeRetention,
  isSettled,
  retentionCandidates,
} from "../lib/subagent-retention.ts";
import type { ContextProvenance } from "../lib/subagent-context.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-23T12:00:00.000Z");

function provenance(mode: "fresh" | "digest" | "fork"): ContextProvenance {
  return {
    version: 1, mode,
    parentSession: "/sessions/parent.jsonl", parentLeafId: "leaf", parentSessionId: "parent-id",
    seededAt: "2026-10-01T00:00:00.000Z", seededEntries: mode === "fork" ? 12 : 0,
    seededChars: mode === "fork" ? 4000 : 0, estimatedTokens: mode === "fork" ? 1000 : 0,
    truncated: null,
  };
}

function record(overrides: Partial<ChildRecord> = {}): ChildRecord {
  return {
    sessionFile: "/sessions/child.jsonl", runId: "run-1", name: "Worker", task: "Do work",
    status: "completed", ended: true, updatedAt: new Date(NOW - 30 * DAY).toISOString(),
    summary: "done", files: [], verification: "", next: "", context: provenance("fork"),
    ...overrides,
  };
}

const exists = () => true;

test("a settled fork copy older than the window is a candidate", () => {
  const r = record();
  const candidates = retentionCandidates([r], new Set([r.sessionFile]), { now: NOW, exists });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sessionFile, r.sessionFile);
  assert.equal(candidates[0].checkpointFile, r.sessionFile + PROGRESS_SUFFIX, "milestone sidecar is retained");
  assert.equal(candidates[0].ageDays, 30);
});

test("fresh and digest children are never offered, however old", () => {
  for (const mode of ["fresh", "digest"] as const) {
    const r = record({ context: provenance(mode) });
    assert.deepEqual(
      retentionCandidates([r], new Set([r.sessionFile]), { now: NOW, exists }),
      [],
      `${mode} holds no copy of the parent branch, so collecting it would trade evidence for nothing`,
    );
  }
});

test("children that are not verifiably finished are never offered", () => {
  // Running and blocked are live by definition.
  for (const status of ["running", "blocked"] as const) {
    const r = record({ status, ended: false });
    assert.deepEqual(retentionCandidates([r], new Set([r.sessionFile]), { now: NOW, exists }), []);
  }
  // ended===false with no observation is `unverified`: it might still be writing.
  const unverified = record({ ended: false, status: "completed" });
  assert.deepEqual(retentionCandidates([unverified], new Set(), { now: NOW, exists }), []);
  assert.equal(isSettled(unverified, false), false);
  // Observed and ended: settled.
  assert.equal(isSettled(record(), true), true);
});

test("the age window is respected, and garbage timestamps are not evidence of age", () => {
  const recent = record({ updatedAt: new Date(NOW - 2 * DAY).toISOString() });
  const candidates = retentionCandidates([recent], new Set([recent.sessionFile]), { now: NOW, exists });
  assert.deepEqual(candidates, [], "within the default retention window");

  // An explicit window overrides the default.
  assert.equal(
    retentionCandidates([recent], new Set([recent.sessionFile]), { now: NOW, olderThanDays: 1, exists }).length,
    1,
  );

  const unparsable = record({ updatedAt: "not-a-date" });
  assert.deepEqual(retentionCandidates([unparsable], new Set([unparsable.sessionFile]), { now: NOW, exists }), []);

  // A missing file is not a candidate: there is nothing to collect.
  const gone = record();
  assert.deepEqual(retentionCandidates([gone], new Set([gone.sessionFile]), { now: NOW, exists: () => false }), []);
});

test("candidates are ordered oldest first and the default window is stated", () => {
  assert.equal(RETENTION_DEFAULT_DAYS, 14);
  const older = record({ name: "Old", sessionFile: "/s/a.jsonl", updatedAt: new Date(NOW - 40 * DAY).toISOString() });
  const newer = record({ name: "New", sessionFile: "/s/b.jsonl", updatedAt: new Date(NOW - 20 * DAY).toISOString() });
  const candidates = retentionCandidates([newer, older], new Set(["/s/a.jsonl", "/s/b.jsonl"]), { now: NOW, exists });
  assert.deepEqual(candidates.map((c) => c.record.name), ["Old", "New"]);
});

test("the confirmation states exactly what goes and what is kept", () => {
  const empty = describeRetention([]);
  assert.match(empty, /Nothing deleted/);

  const r = record({ name: "Forker" });
  const report = describeRetention(
    retentionCandidates([r], new Set([r.sessionFile]), { now: NOW, exists }),
  );
  assert.match(report, /Remove 1 fork transcript copy/);
  assert.match(report, /Forker/);
  assert.match(report, /progress-checkpoint\.json/, "the kept milestone sidecar is named");
  assert.match(report, /cannot be undone/i);
});
