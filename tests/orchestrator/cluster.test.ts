/**
 * Finding clustering: deterministic, in code, no referee child.
 *
 * Two lenses describing one defect in two spellings is one defect. Counting it
 * twice either double-fixes the document or treats consistent reports as
 * corroboration that does not exist — and both corrupt the readiness verdict.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  clusterFindings,
  openReviewRun,
  pinTarget,
  renderRunSummary,
  type ReviewerReport,
  type ReviewRun,
} from "../../lib/orchestrator/spec-review.ts";
import type { ReviewLens } from "../../lib/orchestrator/review-policy.ts";

function run(): ReviewRun {
  return openReviewRun({
    target: pinTarget({ kind: "artifact", ref: "design.md", title: "Design", content: "# Design\n" }),
    preset: "architecture",
  });
}

function report(
  reviewRun: ReviewRun,
  lens: ReviewLens,
  findings: Array<{ id: string; location: string; severity?: "blocker" | "major" | "nit" }>,
): ReviewerReport {
  return {
    version: 1,
    runId: reviewRun.id,
    lens,
    targetHash: reviewRun.target.contentHash,
    summary: "checked",
    findings: findings.map((finding) => ({
      id: finding.id,
      lens,
      severity: finding.severity ?? "major",
      location: finding.location,
      discrepancy: "same defect described twice",
      rationale: "matters for the same reason",
    })),
    submittedAt: new Date(0).toISOString(),
  };
}

describe("finding clustering", () => {
  it("merges the same location across lenses, ignoring heading syntax and case", () => {
    const reviewRun = run();
    reviewRun.reports.comprehension = report(reviewRun, "comprehension", [
      { id: "F-c-1", location: "## 3. Retry budget" },
    ]);
    reviewRun.reports.critic = report(reviewRun, "critic", [
      { id: "F-cr-1", location: "3. Retry budget", severity: "blocker" },
    ]);

    const clusters = clusterFindings(reviewRun);
    assert.equal(clusters.length, 1, "one location is one cluster");
    assert.deepEqual(clusters[0]!.findingIds.sort(), ["F-c-1", "F-cr-1"]);
    assert.deepEqual(clusters[0]!.lenses, ["comprehension", "critic"]);
    assert.deepEqual(clusters[0]!.severities, ["blocker", "major"], "severity order is rank, not arrival");
  });

  it("keeps distinct locations apart and surfaces the overlap in the summary", () => {
    const reviewRun = run();
    reviewRun.reports.comprehension = report(reviewRun, "comprehension", [
      { id: "F-c-1", location: "§1 Goal" },
      { id: "F-c-2", location: "§2 Interfaces" },
    ]);
    reviewRun.reports.readiness = report(reviewRun, "readiness", [
      { id: "F-r-1", location: "1 Goal" },
      { id: "F-r-2", location: "§4 Verification" },
    ]);

    const clusters = clusterFindings(reviewRun);
    assert.equal(clusters.length, 3, "§1+1 Goal merge; §2 and §4 stay separate");
    const merged = clusters.find((cluster) => cluster.findingIds.includes("F-c-1"))!;
    assert.deepEqual(merged.findingIds.sort(), ["F-c-1", "F-r-1"]);

    const summary = renderRunSummary(reviewRun);
    assert.match(summary, /Overlap: .*Goal .*×2/);
    assert.doesNotMatch(summary, /Interfaces ×2/, "a single-lens finding is not called corroboration");
  });

  it("is stable and deterministic for the same inputs", () => {
    const reviewRun = run();
    reviewRun.reports.comprehension = report(reviewRun, "comprehension", [{ id: "a", location: "§2" }]);
    reviewRun.reports.critic = report(reviewRun, "critic", [{ id: "b", location: "§2" }]);
    assert.deepEqual(clusterFindings(reviewRun), clusterFindings(reviewRun));
  });
});
