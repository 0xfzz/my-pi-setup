/**
 * Calibration: the machine-checkable half of "is this spec reviewable?".
 *
 * A judgement cannot be calibrated by another judgement, so this file seeds the
 * defects a computer *can* decide and asserts they are caught, plus the inverse
 * (a good spec produces no lint noise). It is the review gate's equivalent of a
 * mutation test: if the readiness lens could not flag a criterion anchored to a
 * file that does not exist, "clean" would mean nothing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { lintSpec, renderLintForReviewer } from "../../lib/orchestrator/spec-lint.ts";
import { parseReviewerReport } from "../../lib/orchestrator/spec-review.ts";

const RUN = { runId: "sr-x", lens: "readiness" as const, targetHash: "a".repeat(64) };

describe("spec lint catches seeded defects", () => {
  it("flags a criterion anchored to a path that does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-lint-"));
    try {
      const findings = lintSpec({
        cwd: dir,
        content: "## Acceptance\n- retry lives in `src/net/does-not-exist.ts` and npm test passes\n",
      });
      assert.ok(findings.some((f) => f.severity === "major" && f.discrepancy.includes("does-not-exist.ts")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("flags a permitted reference path that does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-lint-"));
    try {
      const findings = lintSpec({ cwd: dir, content: "npm test verifies it", references: ["src/ghost.ts"] });
      assert.ok(findings.some((f) => f.location === "permitted reference paths"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("flags a document with nothing observable at all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-lint-"));
    try {
      const findings = lintSpec({ cwd: dir, content: "The system handles retries better." });
      assert.ok(findings.some((f) => f.id === "L-observable"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stays quiet on a spec whose paths exist and whose check is named", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-lint-"));
    await writeFile(join(dir, "client.ts"), "export {}\n", "utf8");
    try {
      const findings = lintSpec({
        cwd: dir,
        content: "## Acceptance\n- `client.ts` retries twice; verify with `npm test` (exit code 0)\n",
        references: ["client.ts"],
      });
      assert.deepEqual(findings, [], JSON.stringify(findings));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("renders as questions, not as a verdict", () => {
    const rendered = renderLintForReviewer([
      { id: "L-1", severity: "major", location: "line 2", discrepancy: "missing", rationale: "matters" },
    ]);
    assert.match(rendered, /confirm or refute/i);
    assert.match(rendered, /not treat this list as complete/i);
  });
});

describe("attestation: an empty report must say what it looked at", () => {
  const base = {
    version: 1,
    runId: RUN.runId,
    lens: RUN.lens,
    targetHash: RUN.targetHash,
    summary: "nothing wrong found",
    findings: [] as unknown[],
    submittedAt: new Date(0).toISOString(),
  };

  it("refuses a clean report with no coverage", () => {
    const parsed = parseReviewerReport(base, RUN);
    assert.equal(parsed.ok, false);
    assert.match(parsed.problems.join(" "), /coverage/);
  });

  it("accepts the same report once it states what it checked", () => {
    const parsed = parseReviewerReport({ ...base, coverage: ["read the acceptance criteria", "checked the named paths"] }, RUN);
    assert.equal(parsed.ok, true, parsed.problems.join(" | "));
    assert.equal(parsed.report!.coverage!.length, 2);
  });

  it("does not demand coverage from a report that found something", () => {
    const parsed = parseReviewerReport(
      {
        ...base,
        findings: [
          {
            severity: "major",
            location: "§2",
            discrepancy: "undefined interface",
            rationale: "cannot implement",
          },
        ],
      },
      RUN,
    );
    assert.equal(parsed.ok, true, parsed.problems.join(" | "));
  });
});
