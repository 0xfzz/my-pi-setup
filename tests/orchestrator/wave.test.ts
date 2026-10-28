import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SPEC_REVIEWERS,
  MAX_SPEC_UNITS_PER_WAVE,
  MAX_UNITS_PER_SPEC_REVIEWER,
  evaluateMemberReadiness,
  evaluateWave,
  planSpecChunks,
  spawnGateProblem,
  structuralChanges,
  type HandoffContractFields,
  type WaveMember,
} from "../../lib/orchestrator/wave.ts";
import type { Disposition, ReviewFinding } from "../../lib/orchestrator/spec-review.ts";

const scopes = (n: number): string[] => Array.from({ length: n }, (_, i) => `unit-${i + 1}`);

const member = (overrides: Partial<WaveMember> = {}): WaveMember => ({
  scope: "alpha",
  handoffId: "alpha-1234abcd",
  artifactId: "handoff-alpha-1234abcd",
  chunkId: "review-1",
  reviewedHash: "a".repeat(64),
  currentHash: "a".repeat(64),
  revision: 1,
  amendments: [],
  ...overrides,
});

const finding = (overrides: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: "F-review-1-1",
  lens: "gate",
  severity: "major",
  location: "## Acceptance criteria",
  discrepancy: "the retry bound is not stated",
  rationale: "a worker must invent one",
  memberId: "alpha",
  ...overrides,
});

const cleanReport = { submitted: true, covered: true, verdict: "clean" as const };

test("the caps are the ones the lifecycle promises", () => {
  assert.equal(MAX_UNITS_PER_SPEC_REVIEWER, 3);
  assert.equal(MAX_SPEC_REVIEWERS, 3);
  assert.equal(MAX_SPEC_UNITS_PER_WAVE, 9);
});

test("five specs become two chunks of 2 + 3, labelled review-1 and review-2", () => {
  const plan = planSpecChunks(["a", "b", "c", "d", "e"]);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(plan.chunks, [
    { id: "review-1", scopes: ["a", "b"] },
    { id: "review-2", scopes: ["c", "d", "e"] },
  ]);
  assert.equal(plan.chunks.length, 2, "two reviewers, not one for the whole split");
});

test("the split is deterministic and covers every spec exactly once", () => {
  for (let n = 1; n <= MAX_SPEC_UNITS_PER_WAVE; n += 1) {
    const plan = planSpecChunks(scopes(n));
    assert.equal(plan.ok, true, `${n} specs should plan`);
    if (!plan.ok) continue;
    assert.deepEqual(plan.chunks.flatMap((chunk) => chunk.scopes), scopes(n));
    for (const chunk of plan.chunks) assert.ok(chunk.scopes.length <= MAX_UNITS_PER_SPEC_REVIEWER);
    assert.deepEqual(planSpecChunks(scopes(n)), plan, "the same set must produce the same split");
  }
});

test("an oversized, empty, or duplicated wave is refused with a reason", () => {
  const tooMany = planSpecChunks(scopes(MAX_SPEC_UNITS_PER_WAVE + 1));
  assert.equal(tooMany.ok, false);
  assert.match((tooMany as { problems: string[] }).problems[0]!, /at most 9 specs/);

  const empty = planSpecChunks([]);
  assert.equal(empty.ok, false);
  assert.match((empty as { problems: string[] }).problems[0]!, /at least one handoff scope/);

  const duplicate = planSpecChunks(["a", "a", "b"]);
  assert.equal(duplicate.ok, false);
  assert.match((duplicate as { problems: string[] }).problems[0]!, /listed twice: a/);
});

test("a reviewer hint may raise the count but never exceed the caps", () => {
  const forced = planSpecChunks(scopes(3), { reviewers: 3 });
  assert.equal(forced.ok, true);
  if (forced.ok) assert.equal(forced.chunks.length, 3);

  const below = planSpecChunks(scopes(5), { reviewers: 1 });
  assert.equal(below.ok, false, "one reviewer cannot judge five specs at three each");

  const above = planSpecChunks(scopes(3), { reviewers: MAX_SPEC_REVIEWERS + 1 });
  assert.equal(above.ok, false);

  const fractional = planSpecChunks(scopes(3), { reviewers: 1.5 });
  assert.equal(fractional.ok, false);
});

test("a member is not ready until its chunk reviewer has covered it", () => {
  const unreported = evaluateMemberReadiness({
    member: member(),
    findings: [],
    dispositions: {},
    report: { submitted: false, covered: false },
  });
  assert.equal(unreported.ready, false);
  assert.match(unreported.reasons.join("; "), /has not reported yet/);

  const uncovered = evaluateMemberReadiness({
    member: member(),
    findings: [],
    dispositions: {},
    report: { submitted: true, covered: false },
  });
  assert.equal(uncovered.ready, false, "a report that skipped this member is not a clean review");
  assert.match(uncovered.reasons.join("; "), /no coverage for this member/);

  const blocked = evaluateMemberReadiness({
    member: member(),
    findings: [],
    dispositions: {},
    report: { submitted: true, covered: true, verdict: "blocked" },
  });
  assert.equal(blocked.ready, false);

  const note = { id: "C-review-1-1", text: "no PRD artifact" };
  const missing = evaluateMemberReadiness({
    member: member(),
    findings: [],
    dispositions: {},
    report: { submitted: true, covered: true, verdict: "clean" },
    missingContext: [note],
  });
  assert.equal(missing.ready, false, "an unaddressed missing-context note is a gate, not a note");
  assert.match(missing.reasons.join("; "), /C-review-1-1 is unaddressed/);

  // The parent answers it with a recorded disposition: no second review round.
  const answered = evaluateMemberReadiness({
    member: member(),
    findings: [],
    dispositions: {
      "C-review-1-1": { action: "accepted", rationale: "the PRD is quoted in the ticket", at: "", targetHash: "x" },
    },
    report: { submitted: true, covered: true, verdict: "clean" },
    missingContext: [note],
  });
  assert.equal(answered.ready, true);

  const contested = evaluateMemberReadiness({
    member: member(),
    findings: [],
    dispositions: {
      "C-review-1-1": { action: "contested", rationale: "it is in the repo", at: "", targetHash: "x" },
    },
    report: { submitted: true, covered: true, verdict: "clean" },
    missingContext: [note],
  });
  assert.equal(contested.ready, false, "a contested note is still a disagreement the user owns");

  assert.equal(evaluateMemberReadiness({ member: member(), findings: [], dispositions: {}, report: cleanReport }).ready, true);
});

test("an undisposed blocker or major holds the member; an undisposed nit does not", () => {
  const gated = evaluateMemberReadiness({
    member: member(),
    findings: [finding()],
    dispositions: {},
    report: cleanReport,
  });
  assert.equal(gated.ready, false);
  assert.equal(gated.open.length, 1);

  const nit = evaluateMemberReadiness({
    member: member(),
    findings: [finding({ id: "F-nit", severity: "nit" })],
    dispositions: {},
    report: cleanReport,
  });
  assert.equal(nit.ready, true, "a nit is advice, never a gate");
});

test("accepting a finding needs a rationale, and a blocker needs the user", () => {
  const acceptedMajor: Disposition = { action: "accepted", rationale: "documented trade-off", at: "", targetHash: "x" };
  assert.equal(
    evaluateMemberReadiness({ member: member(), findings: [finding()], dispositions: { "F-review-1-1": acceptedMajor }, report: cleanReport }).ready,
    true,
  );

  const noRationale: Disposition = { action: "accepted", rationale: "  ", at: "", targetHash: "x" };
  assert.equal(
    evaluateMemberReadiness({ member: member(), findings: [finding()], dispositions: { "F-review-1-1": noRationale }, report: cleanReport }).ready,
    false,
  );

  const blocker = finding({ severity: "blocker" });
  assert.equal(
    evaluateMemberReadiness({ member: member(), findings: [blocker], dispositions: { "F-review-1-1": acceptedMajor }, report: cleanReport }).ready,
    false,
  );
  assert.equal(
    evaluateMemberReadiness({
      member: member(),
      findings: [blocker],
      dispositions: { "F-review-1-1": { ...acceptedMajor, userConfirmed: true } },
      report: cleanReport,
    }).ready,
    true,
  );
});

test("a fix only settles when the amendment's afterHash is the content now", () => {
  const applied: Disposition = {
    action: "fix",
    rationale: "stated the 3-attempt bound",
    at: "",
    targetHash: "a".repeat(64),
    beforeHash: "a".repeat(64),
    afterHash: "b".repeat(64),
  };
  const fixed = member({ currentHash: "b".repeat(64), amendments: [{ findingId: "F-review-1-1", beforeHash: "a".repeat(64), afterHash: "b".repeat(64), rationale: "x", at: "" }] });
  assert.equal(
    evaluateMemberReadiness({ member: fixed, findings: [finding()], dispositions: { "F-review-1-1": applied }, report: cleanReport }).ready,
    true,
    "fix then spawn is the flow; it must not need a second review",
  );

  const claimedOnly = evaluateMemberReadiness({
    member: member(),
    findings: [finding()],
    dispositions: { "F-review-1-1": { action: "fix", rationale: "done", at: "", targetHash: "a".repeat(64) } },
    report: cleanReport,
  });
  assert.equal(claimedOnly.ready, false, "a fix with no applied edit is a claim, not a fix");

  const contested = evaluateMemberReadiness({
    member: member(),
    findings: [finding()],
    dispositions: { "F-review-1-1": { action: "contested", rationale: "reviewer is wrong", at: "", targetHash: "x" } },
    report: cleanReport,
  });
  assert.equal(contested.ready, false, "a disagreement the orchestrator owns is not ready; the user decides");
});

test("structuralChanges names the contract fields and ignores prose", () => {
  const before: HandoffContractFields = {
    scope: "alpha",
    acceptanceCriteria: ["retry is bounded", "metric is emitted"],
    laneFiles: ["src/a.ts"],
    outOfLaneFiles: ["src/b.ts"],
    interfaces: ["RetryPolicy.bound: number"],
    reportShape: "what changed, what verified",
    vision: "one retry engine",
  };
  const proseOnly: HandoffContractFields = {
    ...before,
    acceptanceCriteria: [...before.acceptanceCriteria],
    laneFiles: ["src/a.ts"],
  };
  assert.deepEqual(structuralChanges(before, proseOnly), []);

  assert.deepEqual(structuralChanges(before, { ...before, laneFiles: ["src/a.ts", "src/b.ts"] }), ["lane files"]);
  assert.deepEqual(structuralChanges(before, { ...before, acceptanceCriteria: ["retry is bounded"] }), ["acceptance criteria"]);
  assert.deepEqual(structuralChanges(before, { ...before, interfaces: [] }), ["interfaces"]);
  assert.deepEqual(structuralChanges(before, { ...before, reportShape: "anything" }), ["report shape"]);
  assert.deepEqual(structuralChanges(before, { ...before, vision: "two engines" }), ["vision"]);
  assert.deepEqual(structuralChanges(before, { ...before, outOfLaneFiles: [] }), ["out-of-lane files"]);
  // Lane order is cosmetic; member sets are not.
  assert.deepEqual(structuralChanges(before, { ...before, laneFiles: ["src/a.ts"] }), []);
});

test("the spawn gate refuses unready members and drifted documents", () => {
  const ready = evaluateMemberReadiness({ member: member(), findings: [], dispositions: {}, report: cleanReport });
  assert.equal(spawnGateProblem({ member: member(), readiness: ready, currentHash: "a".repeat(64) }), undefined);

  const drifted = spawnGateProblem({ member: member(), readiness: ready, currentHash: "c".repeat(64) });
  assert.equal(drifted?.code, "document-changed");

  const unready = evaluateMemberReadiness({
    member: member(),
    findings: [finding()],
    dispositions: {},
    report: cleanReport,
  });
  const refused = spawnGateProblem({ member: member(), readiness: unready, currentHash: "a".repeat(64) });
  assert.equal(refused?.code, "not-ready");
  assert.match(refused!.message, /F-review-1-1/);
});

test("the wave phase is derived: one ready member is already spawnable", () => {
  const members = [member({ scope: "alpha" }), member({ scope: "beta", chunkId: "review-2" })];
  const findings = [finding({ id: "F-beta", memberId: "beta" })];
  const evaluation = evaluateWave({
    members,
    findings,
    dispositions: {},
    reports: {
      alpha: { submitted: true, covered: true, verdict: "clean" },
      beta: { submitted: true, covered: true, verdict: "findings" },
    },
    started: true,
  });
  assert.equal(evaluation.phase, "spawnable");
  assert.deepEqual(evaluation.ready, ["alpha"], "beta is still being fixed; alpha can already go");
  assert.equal(evaluation.allReady, false);

  const waiting = evaluateWave({ members, findings: [], dispositions: {}, reports: {}, started: true });
  assert.equal(waiting.phase, "reviewing");

  const nothingYet = evaluateWave({ members, findings: [], dispositions: {}, reports: {}, started: false });
  assert.equal(nothingYet.phase, "drafting");
});
