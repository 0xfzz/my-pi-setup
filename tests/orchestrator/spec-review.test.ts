import test from "node:test";
import assert from "node:assert/strict";

import {
  DOCUMENT_LENS,
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
  type ReviewRun,
} from "../../lib/orchestrator/spec-review.ts";

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

function report(runId: string, targetHash: string, findings: any[] = [], extra: any = {}) {
  return {
    version: 1,
    runId,
    lens: DOCUMENT_LENS,
    targetHash,
    summary: "judged the document",
    findings,
    // A clean report must state what it looked at; these fixtures are clean
    // reports, so they carry coverage the way a real reviewer must.
    ...(findings.length === 0 ? { coverage: ["read the whole document"] } : {}),
    ...extra,
  };
}

/** A run whose single reviewer has filed `findings`. */
function runWithReport(overrides: { findings?: any[]; extra?: any } = {}): ReviewRun {
  const target = pinned();
  const run = openReviewRun({ target, now: BASE_TIME });
  const parsed = parseReviewerReport(
    report(run.id, target.contentHash, overrides.findings ?? [], overrides.extra ?? {}),
    { runId: run.id, lens: DOCUMENT_LENS, targetHash: target.contentHash },
  );
  assert.equal(parsed.ok, true, parsed.problems.join("; "));
  run.reports[DOCUMENT_LENS] = parsed.report!;
  run.reviewers[0]!.status = "submitted";
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

test("a document run has exactly one reviewer, and its ids are deterministic", () => {
  const target = pinned();
  assert.equal(reviewRunId(target), reviewRunId(target));
  assert.notEqual(reviewRunId(target), reviewRunId(target, "salt-2"));
  assert.notEqual(reviewRunId(target), reviewRunId(pinned("other")));

  const run = openReviewRun({ target, now: BASE_TIME });
  assert.equal(run.reviewers.length, 1, "a document is judged once, not by a panel");
  assert.equal(run.reviewers[0]!.lens, DOCUMENT_LENS);
  assert.match(run.reviewers[0]!.scope, /^[a-z0-9_-]{1,64}$/);
  assert.equal(run.reviewers[0]!.scope, reviewerScope(run.id));
});

test("a report that reviews a different revision is rejected, not stitched in", () => {
  const target = pinned();
  const run = openReviewRun({ target, now: BASE_TIME });
  const parsed = parseReviewerReport(report(run.id, "deadbeef"), {
    runId: run.id,
    lens: DOCUMENT_LENS,
    targetHash: target.contentHash,
  });
  assert.equal(parsed.ok, false);
  assert.match(parsed.problems.join("; "), /targetHash/);
});

test("a report is validated as data: severities, locations, rationales, duplicate ids", () => {
  const target = pinned();
  const run = openReviewRun({ target, now: BASE_TIME });
  const parsed = parseReviewerReport(
    report(run.id, target.contentHash, [
      { id: "A", severity: "catastrophic", location: "x", discrepancy: "y", rationale: "z" },
      { id: "B", severity: "major", location: "", discrepancy: "y", rationale: "z" },
      { id: "C", severity: "major", location: "x", discrepancy: "y", rationale: "" },
      { id: "D", severity: "nit", location: "x", discrepancy: "y", rationale: "z" },
      { id: "D", severity: "nit", location: "x", discrepancy: "y", rationale: "z" },
    ]),
    { runId: run.id, lens: DOCUMENT_LENS, targetHash: target.contentHash },
  );
  assert.equal(parsed.ok, false);
  const problems = parsed.problems.join("; ");
  assert.match(problems, /invalid severity/);
  assert.match(problems, /no location/);
  assert.match(problems, /no rationale/);
  assert.match(problems, /duplicate finding id: D/);
});

test("a missing report is never a clean review", () => {
  const run = openReviewRun({ target: pinned(), now: BASE_TIME });
  const verdict = evaluateReadiness(run);
  assert.equal(verdict.ready, false);
  assert.match(verdict.reasons.join("; "), /no valid report from the reviewer/);
});

test("a malformed reviewer payload is rejected rather than treated as empty findings", () => {
  const run = openReviewRun({ target: pinned(), now: BASE_TIME });
  assert.equal(parseReviewerReport("not json", { runId: run.id, lens: DOCUMENT_LENS, targetHash: run.target.contentHash }).ok, false);
  assert.equal(
    parseReviewerReport({ ...report(run.id, run.target.contentHash), findings: undefined }, {
      runId: run.id,
      lens: DOCUMENT_LENS,
      targetHash: run.target.contentHash,
    }).ok,
    false,
  );
});

test("a clean report makes the document ready", () => {
  const run = runWithReport();
  const verdict = evaluateReadiness(run);
  assert.equal(verdict.ready, true, verdict.reasons.join("; "));
  assert.equal(settleReadiness(run).status, "ready");
});

test("a blocked reviewer blocks readiness even with zero findings", () => {
  const run = runWithReport({ extra: { verdict: "blocked" } });
  const verdict = evaluateReadiness(run);
  assert.equal(verdict.ready, false);
  assert.match(verdict.reasons.join("; "), /reviewer is blocked/);
  assert.equal(settleReadiness(run).status, "blocked");
});

test("missing context is addressable: it gates until a disposition answers it", () => {
  const run = runWithReport({ extra: { missingContext: ["src/net/retry.ts does not exist", "the rollback path is unstated"] } });
  const blocked = evaluateReadiness(run);
  assert.equal(blocked.ready, false);
  assert.match(blocked.reasons.join("; "), /C-gate-1 is unaddressed: src\/net\/retry\.ts does not exist/);
  assert.match(blocked.reasons.join("; "), /C-gate-2 is unaddressed: the rollback path is unstated/);

  // The escape hatch that the deadlocked session did not have: answer the note.
  const answered = applyDispositions(run, [
    { findingId: "C-gate-1", action: "accepted", rationale: "this lane creates the file" },
    { findingId: "C-gate-2", action: "accepted", rationale: "the rollback path is out of scope for this document" },
  ], { now: BASE_TIME });
  assert.equal(answered.ok, true, answered.problems.join("; "));
  assert.equal(evaluateReadiness(answered.run).ready, true, "answering the notes must not need another review round");

  // A contested note is a disagreement the parent owns, not an answer.
  const contested = applyDispositions(run, [
    { findingId: "C-gate-1", action: "contested", rationale: "it exists" },
  ], { now: BASE_TIME });
  assert.equal(contested.ok, true);
  assert.equal(evaluateReadiness(contested.run).ready, false);
});

test("an invalid verdict is rejected, not silently treated as clean", () => {
  const run = openReviewRun({ target: pinned(), now: BASE_TIME });
  const parsed = parseReviewerReport(report(run.id, run.target.contentHash, [], { verdict: "looks-fine" }), {
    runId: run.id,
    lens: DOCUMENT_LENS,
    targetHash: run.target.contentHash,
  });
  assert.equal(parsed.ok, false);
  assert.match(parsed.problems.join("; "), /invalid verdict/);
});

test("a report written before verdict existed is still a completed report", () => {
  const run = runWithReport();
  assert.equal("verdict" in run.reports[DOCUMENT_LENS]!, false, "legacy reports have no verdict field");
  assert.equal(evaluateReadiness(run).ready, true);
});

test("an empty findings array with coverage is a valid clean report; without coverage it is not", () => {
  const run = runWithReport();
  assert.equal(evaluateReadiness(run).ready, true);
  assert.equal(allFindings(run).length, 0);

  const target = pinned();
  const bare = openReviewRun({ target, now: BASE_TIME });
  const parsed = parseReviewerReport(report(bare.id, target.contentHash, [], { coverage: undefined }), {
    runId: bare.id,
    lens: DOCUMENT_LENS,
    targetHash: target.contentHash,
  });
  assert.equal(parsed.ok, false);
  assert.match(parsed.problems.join("; "), /needs coverage/);
});

test("a blocker blocks until it is explicitly disposed", () => {
  const run = runWithReport({ findings: [{ id: "F1", severity: "blocker", location: "## Goal", discrepancy: "undefined term", rationale: "cannot implement" }] });
  const before = evaluateReadiness(run);
  assert.equal(before.ready, false);
  assert.match(before.reasons.join("; "), /unresolved blocker: F1/);

  const fixed = applyDispositions(run, [{ findingId: "F1", action: "fix" }], { now: BASE_TIME });
  assert.equal(fixed.ok, true, fixed.problems.join("; "));
  // A fix edits the document, so the pinned revision is gone: re-review required.
  // (A split review does not have this rule: its fix is an applied edit with a
  // before/after hash, see chunk-run.ts.)
  const after = evaluateReadiness(fixed.run);
  assert.equal(after.ready, false);
  assert.equal(after.requiresReReview, true);
  assert.match(after.reasons.join("; "), /fresh review/);
});

test("accepting a blocker without the user is refused", () => {
  const run = runWithReport({ findings: [{ id: "F1", severity: "blocker", location: "## Goal", discrepancy: "d", rationale: "r" }] });
  const refused = applyDispositions(run, [{ findingId: "F1", action: "accepted", rationale: "we accept" }], { now: BASE_TIME });
  assert.equal(refused.ok, false);
  assert.match(refused.problems.join("; "), /needs the user's confirmation/);

  const confirmed = applyDispositions(run, [{ findingId: "F1", action: "accepted", rationale: "we accept", userConfirmed: true }], { now: BASE_TIME });
  assert.equal(confirmed.ok, true, confirmed.problems.join("; "));
  assert.equal(evaluateReadiness(confirmed.run).ready, true);
});

test("an accepted major needs a rationale; a contested finding stays open", () => {
  const run = runWithReport({ findings: [{ id: "M1", severity: "major", location: "## Steps", discrepancy: "d", rationale: "r" }] });
  assert.equal(applyDispositions(run, [{ findingId: "M1", action: "accepted" }], { now: BASE_TIME }).ok, false);
  const contested = applyDispositions(run, [{ findingId: "M1", action: "contested", rationale: "wrong because X" }], { now: BASE_TIME });
  assert.equal(contested.ok, true);
  assert.equal(evaluateReadiness(contested.run).ready, false);
  assert.match(evaluateReadiness(contested.run).reasons.join("; "), /is contested/);
});

test("nits do not force a loop and do not block readiness", () => {
  const run = runWithReport({ findings: [{ id: "N1", severity: "nit", location: "## Goal", discrepancy: "wording", rationale: "style" }] });
  const verdict = evaluateReadiness(run);
  assert.equal(verdict.ready, true, "an undisposed nit must not gate readiness");
  assert.equal(verdict.counts.nit, 1);
  assert.equal(verdict.counts.open, 0, "only findings that gate readiness count as open");
  assert.doesNotMatch(verdict.reasons.join("; "), /nit/);
  // A disposition on a nit is still accepted, and `accepted` still needs a rationale.
  assert.equal(applyDispositions(run, [{ findingId: "N1", action: "accepted" }], { now: BASE_TIME }).ok, false);
  assert.equal(applyDispositions(run, [{ findingId: "N1", action: "fix" }], { now: BASE_TIME }).ok, true);
});

test("duplicate or unknown dispositions are reported together", () => {
  const run = runWithReport({ findings: [{ id: "F1", severity: "major", location: "x", discrepancy: "d", rationale: "r" }] });
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
  const run = runWithReport({ findings: [{ id: "F1", severity: "major", location: "x", discrepancy: "d", rationale: "r" }] });
  const fixed = applyDispositions(run, [{ findingId: "F1", action: "fix" }], { now: BASE_TIME });
  assert.equal(fixed.ok, true);
  assert.equal(fixed.run.dispositions.F1!.targetHash, run.target.contentHash);
});

test("a changed document is stale, and a stale readiness cannot back a handoff", () => {
  const run = settleReadiness(runWithReport());
  assert.equal(run.readiness.ready, true);
  assert.equal(stalenessProblem(run, run.target.snapshot), undefined);
  assert.match(String(stalenessProblem(run, `${run.target.snapshot}\nmore text`)), /document changed/);
  assert.match(String(stalenessProblem(run, null)), /could not be read back/);
});

test("designRef ties a worker to the exact reviewed revision", () => {
  const run = settleReadiness(runWithReport());
  const ref = { runId: run.id, targetHash: run.target.contentHash };
  const lookup = (id: string) => (id === run.id ? run : undefined);
  assert.equal(designRefProblem(ref, lookup, run.target.snapshot), undefined);
  assert.match(String(designRefProblem(undefined, lookup, run.target.snapshot)), /no designRef/);
  assert.match(String(designRefProblem({ runId: "sr-nope", targetHash: run.target.contentHash }, lookup, run.target.snapshot)), /not known/);
  assert.match(String(designRefProblem({ ...ref, targetHash: "0".repeat(64) }, lookup, run.target.snapshot)), /covered/);
  assert.match(String(designRefProblem(ref, lookup, "different")), /document changed/);
});

test("an uncollected review cannot back a handoff even with a matching hash", () => {
  const run = openReviewRun({ target: pinned(), now: BASE_TIME });
  const lookup = () => run;
  assert.match(String(designRefProblem({ runId: run.id, targetHash: run.target.contentHash }, lookup, run.target.snapshot)), /not ready/);
});

test("a cancelled run cannot become ready by later settlements", () => {
  const run = { ...runWithReport(), status: "cancelled" as const };
  assert.equal(settleReadiness(run).status, "cancelled");
  assert.equal(evaluateReadiness(run).ready, false);
});

test("the reviewer ticket embeds the pinned revision and the isolation facts", () => {
  const target = pinned();
  const ticket = renderReviewerTicket({ runId: "sr-1", target, policy: { roots: ["/repo"] } });
  assert.ok(ticket.includes(target.snapshot), "the snapshot is inside the ticket");
  assert.ok(ticket.includes(target.contentHash), "the revision is named");
  assert.match(ticket, /did not inherit any parent conversation/);
  assert.match(ticket, /orch_spec_review_submit/);
  assert.match(ticket, /blocker \| major \| nit/);
  // No author reasoning, no sibling scope, no parent path, and no lens panel.
  assert.doesNotMatch(ticket, /orch_parent_recall/);
  assert.doesNotMatch(ticket, /comprehension|zoom-out|critic/);
});
