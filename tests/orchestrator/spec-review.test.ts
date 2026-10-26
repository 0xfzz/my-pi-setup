import test from "node:test";
import assert from "node:assert/strict";

import {
  REVIEW_PRESETS,
  allFindings,
  applyDispositions,
  designRefProblem,
  evaluateReadiness,
  hashContent,
  openReviewRun,
  parseReviewerReport,
  pinTarget,
  renderReviewerTicket,
  reviewRunId,
  reviewerScope,
  settleReadiness,
  stalenessProblem,
  type ReviewPreset,
  type ReviewRun,
} from "../../lib/orchestrator/spec-review.ts";
import type { ReviewLens } from "../../lib/orchestrator/review-policy.ts";

const BASE_TIME = new Date("2026-10-26T10:00:00.000Z");

function pinned(content = "# Spec\n\nUse the retry helper in `src/net/retry.ts`.\n") {
  return pinTarget({
    kind: "artifact",
    ref: "design-doc",
    title: "Retry design",
    content,
    references: ["src/net/retry.ts"],
    now: BASE_TIME,
  });
}

function report(runId: string, lens: any, targetHash: string, findings: any[] = [], extra: any = {}) {
  return {
    version: 1,
    runId,
    lens,
    targetHash,
    summary: `${lens} summary`,
    findings,
    ...extra,
  };
}

function runWithAllReports(overrides: { findings?: Record<string, any[]>; preset?: ReviewPreset } = {}): ReviewRun {
  const target = pinned();
  const preset: ReviewPreset = overrides.preset ?? "quick";
  const run = openReviewRun({ target, preset, now: BASE_TIME });
  for (const lens of REVIEW_PRESETS[preset] as ReviewLens[]) {
    const parsed = parseReviewerReport(report(run.id, lens, target.contentHash, overrides.findings?.[lens] ?? []), {
      runId: run.id,
      lens,
      targetHash: target.contentHash,
    });
    assert.equal(parsed.ok, true, `${lens} report should parse: ${parsed.problems.join("; ")}`);
    run.reports[lens] = parsed.report!;
  }
  run.reviewers = run.reviewers.map((slot) => ({ ...slot, status: "submitted" }));
  return run;
}

test("the pinned target is identified by content, not by id", () => {
  const one = pinned("hello");
  const two = pinned("hello");
  const three = pinned("hello!");
  assert.equal(one.contentHash, two.contentHash);
  assert.notEqual(one.contentHash, three.contentHash);
  assert.equal(one.contentHash, hashContent("hello"));
  assert.throws(() => pinned("   "), /empty/);
});

test("review run ids are deterministic per (ref, content, preset)", () => {
  const target = pinned();
  assert.equal(reviewRunId(target, "quick"), reviewRunId(target, "quick"));
  assert.notEqual(reviewRunId(target, "quick"), reviewRunId(target, "architecture"));
  assert.notEqual(reviewRunId(target, "quick"), reviewRunId(pinned("other"), "quick"));
});

test("reviewer scopes are unique per lens and safe as isolation keys", () => {
  const target = pinned();
  const run = openReviewRun({ target, preset: "architecture", now: BASE_TIME });
  const scopes = run.reviewers.map((slot) => slot.scope);
  assert.equal(new Set(scopes).size, scopes.length);
  for (const scope of scopes) {
    assert.match(scope, /^[a-z0-9_-]{1,64}$/);
    assert.equal(scope, reviewerScope(run.id, scope.replace(`review-${run.id}-`, "") as any));
  }
});

test("a report that reviews a different revision is rejected, not stitched in", () => {
  const target = pinned();
  const run = openReviewRun({ target, preset: "quick", now: BASE_TIME });
  const parsed = parseReviewerReport(report(run.id, "comprehension", "deadbeef"), {
    runId: run.id,
    lens: "comprehension",
    targetHash: target.contentHash,
  });
  assert.equal(parsed.ok, false);
  assert.match(parsed.problems.join("; "), /targetHash/);
});

test("a report is validated as data: severities, locations, rationales, duplicate ids", () => {
  const target = pinned();
  const run = openReviewRun({ target, preset: "quick", now: BASE_TIME });
  const parsed = parseReviewerReport(
    report(run.id, "comprehension", target.contentHash, [
      { id: "A", severity: "catastrophic", location: "x", discrepancy: "y", rationale: "z" },
      { id: "B", severity: "major", location: "", discrepancy: "y", rationale: "z" },
      { id: "C", severity: "major", location: "x", discrepancy: "y", rationale: "" },
      { id: "D", severity: "nit", location: "x", discrepancy: "y", rationale: "z" },
      { id: "D", severity: "nit", location: "x", discrepancy: "y", rationale: "z" },
    ]),
    { runId: run.id, lens: "comprehension", targetHash: target.contentHash },
  );
  assert.equal(parsed.ok, false);
  const problems = parsed.problems.join("; ");
  assert.match(problems, /invalid severity/);
  assert.match(problems, /no location/);
  assert.match(problems, /no rationale/);
  assert.match(problems, /duplicate finding id: D/);
});

test("a missing report is never a clean review", () => {
  const run = openReviewRun({ target: pinned(), preset: "quick", now: BASE_TIME });
  const verdict = evaluateReadiness(run);
  assert.equal(verdict.ready, false);
  assert.match(verdict.reasons.join("; "), /no valid report from the comprehension reviewer/);
});

test("a malformed reviewer payload is rejected rather than treated as empty findings", () => {
  const run = openReviewRun({ target: pinned(), preset: "quick", now: BASE_TIME });
  assert.equal(parseReviewerReport("not json", { runId: run.id, lens: "comprehension", targetHash: run.target.contentHash }).ok, false);
  assert.equal(parseReviewerReport({ ...report(run.id, "comprehension", run.target.contentHash), findings: undefined }, {
    runId: run.id, lens: "comprehension", targetHash: run.target.contentHash,
  }).ok, false);
});

test("two clean reports make a quick review ready", () => {
  const run = runWithAllReports();
  const verdict = evaluateReadiness(run);
  assert.equal(verdict.ready, true, verdict.reasons.join("; "));
  assert.equal(settleReadiness(run).status, "ready");
});

test("an empty findings array is a valid, clean report", () => {
  const run = runWithAllReports({ findings: { comprehension: [], readiness: [] } });
  assert.equal(evaluateReadiness(run).ready, true);
  assert.equal(allFindings(run).length, 0);
});

test("a blocker blocks until it is explicitly disposed", () => {
  const run = runWithAllReports({
    findings: { comprehension: [{ id: "F1", severity: "blocker", location: "## Goal", discrepancy: "undefined term", rationale: "cannot implement" }] },
  });
  const before = evaluateReadiness(run);
  assert.equal(before.ready, false);
  assert.match(before.reasons.join("; "), /unresolved blocker: F1/);

  const fixed = applyDispositions(run, [{ findingId: "F1", action: "fix" }], { now: BASE_TIME });
  assert.equal(fixed.ok, true, fixed.problems.join("; "));
  // A fix edits the document, so the pinned revision is gone: re-review required.
  const after = evaluateReadiness(fixed.run);
  assert.equal(after.ready, false);
  assert.equal(after.requiresReReview, true);
  assert.match(after.reasons.join("; "), /fresh review/);
});

test("accepting a blocker without the user is refused", () => {
  const run = runWithAllReports({
    findings: { comprehension: [{ id: "F1", severity: "blocker", location: "## Goal", discrepancy: "d", rationale: "r" }] },
  });
  const refused = applyDispositions(run, [{ findingId: "F1", action: "accepted", rationale: "we accept" }], { now: BASE_TIME });
  assert.equal(refused.ok, false);
  assert.match(refused.problems.join("; "), /needs the user's confirmation/);

  const confirmed = applyDispositions(run, [{ findingId: "F1", action: "accepted", rationale: "we accept", userConfirmed: true }], { now: BASE_TIME });
  assert.equal(confirmed.ok, true, confirmed.problems.join("; "));
  assert.equal(evaluateReadiness(confirmed.run).ready, true);
});

test("an accepted major needs a rationale; a contested finding stays open", () => {
  const run = runWithAllReports({ findings: { readiness: [{ id: "M1", severity: "major", location: "## Steps", discrepancy: "d", rationale: "r" }] } });
  assert.equal(applyDispositions(run, [{ findingId: "M1", action: "accepted" }], { now: BASE_TIME }).ok, false);
  const contested = applyDispositions(run, [{ findingId: "M1", action: "contested", rationale: "wrong because X" }], { now: BASE_TIME });
  assert.equal(contested.ok, true);
  assert.equal(evaluateReadiness(contested.run).ready, false);
  assert.match(evaluateReadiness(contested.run).reasons.join("; "), /is contested/);
});

test("nits do not force a loop and do not block readiness", () => {
  const run = runWithAllReports({
    findings: { comprehension: [{ id: "N1", severity: "nit", location: "## Goal", discrepancy: "wording", rationale: "style" }] },
  });
  const verdict = evaluateReadiness(run);
  assert.equal(verdict.ready, true, "an undisposed nit must not gate readiness");
  assert.equal(verdict.counts.nit, 1);
  assert.equal(verdict.counts.open, 0, "only findings that gate readiness count as open");
  assert.doesNotMatch(verdict.reasons.join("; "), /nit/);
  // A disposition on a nit is still accepted, and `accepted` still needs a rationale.
  const settled = applyDispositions(run, [{ findingId: "N1", action: "accepted" }], { now: BASE_TIME });
  assert.equal(settled.ok, false, "accepted still needs a rationale");
  const fixed = applyDispositions(run, [{ findingId: "N1", action: "fix" }], { now: BASE_TIME });
  assert.equal(fixed.ok, true);
});

test("an undisposed nit is visible but never blocks", () => {
  const run = runWithAllReports({
    findings: { readiness: [{ id: "N2", severity: "nit", location: "## Steps", discrepancy: "wording", rationale: "style" }] },
  });
  const verdict = evaluateReadiness(run);
  assert.equal(verdict.counts.nit, 1);
  assert.equal(verdict.counts.open, 0);
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.ready, true);
});

test("duplicate or unknown dispositions are reported together", () => {
  const run = runWithAllReports({
    findings: { comprehension: [{ id: "F1", severity: "major", location: "x", discrepancy: "d", rationale: "r" }] },
  });
  const result = applyDispositions(run, [
    { findingId: "missing", action: "fix" },
    { findingId: "F1", action: "accepted" },
    { findingId: "F1", action: "contested", rationale: "bad" },
  ], { now: BASE_TIME });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("; "), /unknown finding id: missing/);
  assert.match(result.problems.join("; "), /accepted and needs a rationale/);
});

test("a disposition is never applied to a finding from another revision", () => {
  const run = runWithAllReports({
    findings: { comprehension: [{ id: "F1", severity: "major", location: "x", discrepancy: "d", rationale: "r" }] },
  });
  const refused = applyDispositions(run, [{ findingId: "F1", action: "fix" }], { now: BASE_TIME });
  assert.equal(refused.ok, true);
  assert.equal(refused.run.dispositions.F1.targetHash, run.target.contentHash);
});

test("a changed document is stale, and a stale readiness cannot back a handoff", () => {
  const run = settleReadiness(runWithAllReports());
  assert.equal(run.readiness.ready, true);
  assert.equal(stalenessProblem(run, run.target.snapshot), undefined);
  assert.match(String(stalenessProblem(run, `${run.target.snapshot}\nmore text`)), /document changed/);
  assert.match(String(stalenessProblem(run, null)), /could not be read back/);
});

test("designRef ties a worker to the exact reviewed revision", () => {
  const run = settleReadiness(runWithAllReports());
  const ref = { runId: run.id, targetHash: run.target.contentHash };
  const lookup = (id: string) => (id === run.id ? run : undefined);
  assert.equal(designRefProblem(ref, lookup, run.target.snapshot), undefined);
  assert.match(String(designRefProblem(undefined, lookup, run.target.snapshot)), /no designRef/);
  assert.match(String(designRefProblem({ runId: "sr-nope", targetHash: run.target.contentHash }, lookup, run.target.snapshot)), /not known/);
  assert.match(String(designRefProblem({ ...ref, targetHash: "0".repeat(64) }, lookup, run.target.snapshot)), /covered/);
  assert.match(String(designRefProblem(ref, lookup, "different")), /document changed/);
});

test("an uncollected review cannot back a handoff even with a matching hash", () => {
  const run = openReviewRun({ target: pinned(), preset: "quick", now: BASE_TIME });
  const lookup = () => run;
  assert.match(String(designRefProblem({ runId: run.id, targetHash: run.target.contentHash }, lookup, run.target.snapshot)), /not ready/);
});

test("a cancelled run cannot become ready by later settlements", () => {
  const run = { ...runWithAllReports(), status: "cancelled" as const };
  assert.equal(settleReadiness(run).status, "cancelled");
  assert.equal(evaluateReadiness(run).ready, false);
});

test("the reviewer ticket embeds the pinned revision and the isolation facts", () => {
  const target = pinned();
  const ticket = renderReviewerTicket({
    runId: "sr-1",
    lens: "readiness",
    target,
    policy: { roots: ["/repo"] },
  });
  assert.ok(ticket.includes(target.snapshot), "the snapshot is inside the ticket");
  assert.ok(ticket.includes(target.contentHash), "the revision is named");
  assert.match(ticket, /did not inherit any parent conversation/);
  assert.match(ticket, /spec_review_submit/);
  assert.match(ticket, /blocker \| major \| nit/);
  // No author reasoning, no sibling scope, no parent path.
  assert.doesNotMatch(ticket, /orch_parent_recall/);
});
