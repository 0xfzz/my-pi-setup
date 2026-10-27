import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SddError,
  sddAnalyze,
  sddClarify,
  sddFeatureDir,
  sddFeatureSlug,
  sddPlan,
  sddSpecify,
  sddStatus,
  sddTasks,
} from "../../lib/orchestrator/sdd.ts";

function specify(dir: string, feature = "retry-policy") {
  return sddSpecify(dir, {
    feature,
    title: "Retry policy",
    problem: "Transient network failures surface immediately.",
    goals: ["Retry transient failures"],
    requirements: ["Retry transient failures with exponential backoff."],
    acceptance: ["Given a transient failure, when the call is retried, then it backs off exponentially."],
    constraints: ["No jitter in v1."],
    outOfScope: ["Circuit breakers."],
  });
}

test("specify, plan, tasks, analyze and status form one valid feature", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sdd-unit-"));
  try {
    const spec = specify(dir);
    assert.match(spec.content, /## Problem/);
    assert.match(spec.content, /## Requirements/);
    assert.match(spec.content, /FR-001/);
    assert.match(spec.content, /AC-001/);

    const draft = sddStatus(dir, "retry-policy");
    assert.equal(draft.files.spec, true);
    assert.equal(draft.files.plan, false);
    assert.equal(draft.specStatus, "clarified");
    assert.deepEqual(draft.findings.map((finding) => finding.code), ["SDD-SECTION", "SDD-SECTION"], "plan/tasks are still missing");

    sddPlan(dir, {
      feature: "retry-policy",
      approach: "Add a bounded retry helper around the transport call.",
      files: ["src/net/retry.ts"],
      interfaces: ["retry(fn): Promise<T>"],
      testStrategy: ["Unit-test the backoff schedule"],
    });
    sddTasks(dir, {
      feature: "retry-policy",
      tasks: [{
        title: "Add the retry helper",
        files: ["src/net/retry.ts", "src/net/retry.test.ts"],
        maps: ["FR-001", "AC-001"],
        verify: "npm test -- retry",
      }],
    });

    const analyzed = sddAnalyze(dir, "retry-policy");
    assert.deepEqual(analyzed.findings, []);
    assert.equal(analyzed.ok, true);

    const status = sddStatus(dir, "retry-policy");
    assert.equal(status.files.plan, true);
    assert.equal(status.files.tasks, true);
    assert.equal(status.taskCount, 1);
    assert.deepEqual(status.ready.map((task) => task.id), ["T001"]);

    // analyze is read-only.
    const before = await readFile(join(dir, "specs/retry-policy/spec.md"), "utf8");
    sddAnalyze(dir, "retry-policy");
    assert.equal(await readFile(join(dir, "specs/retry-policy/spec.md"), "utf8"), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact creation is create-only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sdd-create-"));
  try {
    specify(dir);
    assert.throws(() => specify(dir), /already exists/);
    sddPlan(dir, { feature: "retry-policy", approach: "A", testStrategy: ["T"] });
    assert.throws(
      () => sddPlan(dir, { feature: "retry-policy", approach: "B", testStrategy: ["T"] }),
      /already exists/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clarify resolves an open question and is refused after plan", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sdd-clarify-"));
  try {
    sddSpecify(dir, {
      feature: "retry-policy",
      title: "Retry policy",
      problem: "Transient failures surface immediately.",
      goals: ["Retry"],
      requirements: ["Retry transient failures."],
      acceptance: ["Given a failure, when retried, then it backs off."],
      openQuestions: ["Which HTTP statuses are retryable?"],
    });
    assert.equal(sddStatus(dir, "retry-policy").specStatus, "draft");
    assert.throws(
      () => sddPlan(dir, { feature: "retry-policy", approach: "A", testStrategy: ["T"] }),
      /open questions|draft/i,
    );

    const clarified = sddClarify(dir, {
      feature: "retry-policy",
      question: "Which HTTP statuses are retryable?",
      answer: "429 and 5xx only.",
    });
    assert.match(clarified.content, /\*\*Status\*\*: clarified/);
    assert.match(clarified.content, /\[x\] Which HTTP statuses/);
    assert.match(clarified.content, /\*\*Q:\*\* Which HTTP statuses/);

    sddPlan(dir, { feature: "retry-policy", approach: "A", testStrategy: ["T"] });
    assert.throws(
      () => sddClarify(dir, { feature: "retry-policy", question: "Q", answer: "A" }),
      /before plan\.md/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("analyze reports all five finding classes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sdd-analyze-"));
  try {
    const feature = join(dir, "specs", "broken");
    await mkdir(feature, { recursive: true });
    await writeFile(join(feature, "spec.md"), `# Feature Specification: Broken

**Feature**: specs/broken
**Status**: clarified

## Problem
P

## Goals
- G

## Non-goals
- None.

## Requirements
- **FR-001**: One.
- **FR-001**: Duplicate.
- **FR-002**: Two.
- **FR-003**: Unmapped.

## Acceptance scenarios
- **AC-001**: Given A, when B, then C.

## Constraints and assumptions
- None.

## Clarifications
- None.

## Open questions
- [ ] Still unresolved.

## Out of scope
- None.
`, "utf8");
    await writeFile(join(feature, "plan.md"), `# Implementation Plan: Broken

## Approach
A

## Affected files/interfaces
- None.

## Test strategy
- T

## Risks
- None.

## Task mapping
Pending.
`, "utf8");
    await writeFile(join(feature, "tasks.md"), `# Tasks: Broken

## Core
- [ ] T001 [P] One
  Depends: T999
  Maps: FR-001, AC-001
  Files: src/a.ts
  Verify: true
- [ ] T002 [P] Two
  Maps: FR-999
  Files: src/a.ts
  Verify: true
- [ ] T003 Three
  Depends: T004
  Maps: FR-002
  Files: src/b.ts
  Verify: true
- [ ] T004 Four
  Depends: T003
  Maps: FR-002
  Files: src/c.ts
  Verify: true
`, "utf8");

    const result = sddAnalyze(dir, "broken");
    const codes = new Set(result.findings.map((finding) => finding.code));
    for (const code of ["SDD-ID", "SDD-MAP", "SDD-DEP", "SDD-LANE"]) {
      assert.ok(codes.has(code as any), `expected ${code}: ${JSON.stringify(result.findings)}`);
    }
    assert.ok(result.findings.some((finding) => /unknown T999/.test(finding.message)));
    assert.ok(result.findings.some((finding) => /share src\/a\.ts/.test(finding.message)));
    assert.ok(result.findings.some((finding) => /cycle/i.test(finding.message)));
    assert.equal(result.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing required sections are reported", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sdd-sections-"));
  try {
    const feature = join(dir, "specs", "thin");
    await mkdir(feature, { recursive: true });
    await writeFile(join(feature, "spec.md"), "# Feature Specification: Thin\n\n## Problem\nP\n", "utf8");
    const result = sddAnalyze(dir, "thin");
    assert.ok(result.findings.some((finding) => finding.code === "SDD-SECTION" && /## Goals/.test(finding.message)));
    assert.ok(result.findings.some((finding) => finding.code === "SDD-SECTION" && /plan\.md is missing/.test(finding.message)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("feature paths are one slug and symlink escapes are refused", async () => {
  assert.equal(sddFeatureSlug("specs/retry-policy/"), "retry-policy");
  for (const bad of ["../escape", "a/b", "/absolute", "", "Retry Policy"]) {
    assert.throws(() => sddFeatureSlug(bad), SddError, bad);
  }

  const dir = await mkdtemp(join(tmpdir(), "sdd-paths-"));
  const outside = await mkdtemp(join(tmpdir(), "sdd-outside-"));
  try {
    await mkdir(join(dir, "specs"));
    await symlink(outside, join(dir, "specs", "evil"));
    assert.throws(() => sddFeatureDir(dir, "evil", true), /symlink|outside/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("status groups parallel tasks by phase and disjoint files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sdd-status-"));
  try {
    specify(dir);
    sddPlan(dir, { feature: "retry-policy", approach: "A", testStrategy: ["T"] });
    sddTasks(dir, {
      feature: "retry-policy",
      tasks: [
        { title: "A", files: ["src/a.ts"], maps: ["FR-001"], verify: "true", parallel: true, phase: "Core" },
        { title: "B", files: ["src/b.ts"], maps: ["FR-001"], verify: "true", parallel: true, phase: "Core" },
        { title: "C", files: ["src/a.ts"], maps: ["FR-001"], verify: "true", parallel: true, phase: "Core" },
      ],
    });
    const status = sddStatus(dir, "retry-policy");
    assert.equal(status.ready.length, 3);
    assert.equal(status.parallelGroups.length, 2, "A and B group; C overlaps A and must stand alone");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
