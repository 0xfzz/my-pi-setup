import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  sddPlan,
  sddSpecify,
  sddTaskSelection,
  sddTaskSelectionProblem,
  sddTaskSnapshot,
  sddTasks,
} from "../../lib/orchestrator/sdd.ts";
import { renderHandoffForChild, validateHandoff } from "../../lib/orchestrator/handoff.ts";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "sdd-handoff-"));
  sddSpecify(dir, {
    feature: "retry-policy",
    title: "Retry policy",
    problem: "Transient failures surface immediately.",
    goals: ["Retry transient failures"],
    requirements: ["Retry transient failures.", "Expose a bounded attempt count."],
    acceptance: ["Given a failure, when retried, then it backs off."],
  });
  sddPlan(dir, { feature: "retry-policy", approach: "A", testStrategy: ["T"] });
  sddTasks(dir, {
    feature: "retry-policy",
    tasks: [
      { id: "T001", title: "Add retry helper", files: ["src/retry.ts"], maps: ["FR-001", "AC-001"], verify: "npm test -- retry" },
      { id: "T002", title: "Add attempt limit", files: ["src/limit.ts"], maps: ["FR-002"], verify: "npm test -- limit", dependsOn: ["T001"] },
      { id: "T003", title: "Document retry", files: ["docs/retry.md"], maps: ["FR-001"], verify: "npm test -- retry" },
    ],
  });
  return dir;
}

test("a task selection derives the lane, criteria and common verification", async () => {
  const dir = await fixture();
  try {
    const selection = sddTaskSelection(dir, "retry-policy", ["T001", "T003"]);
    assert.deepEqual(selection.featureRef, "specs/retry-policy");
    assert.deepEqual(selection.tasks.map((task) => task.id), ["T001", "T003"]);
    assert.deepEqual(selection.laneFiles, ["src/retry.ts", "docs/retry.md"]);
    assert.equal(selection.verifyCommand, "npm test -- retry");
    assert.match(selection.acceptanceCriteria.join("\n"), /T001: Add retry helper/);
    assert.match(selection.acceptanceCriteria.join("\n"), /FR-001, AC-001/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task selection rejects unknown, done and dependency-unready tasks", async () => {
  const dir = await fixture();
  try {
    assert.throws(() => sddTaskSelection(dir, "retry-policy", ["T999"]), /not in tasks\.md/);
    assert.throws(() => sddTaskSelection(dir, "retry-policy", ["T002"]), /depends on T001, which is not done/);

    const tasksFile = join(dir, "specs/retry-policy/tasks.md");
    const content = await readFile(tasksFile, "utf8");
    await writeFile(tasksFile, content.replace("- [ ] T001", "- [X] T001"), "utf8");
    assert.throws(() => sddTaskSelection(dir, "retry-policy", ["T001"]), /already done/);
    assert.equal(sddTaskSelection(dir, "retry-policy", ["T002"]).tasks[0]!.id, "T002");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the handoff revalidation detects a changed task slice", async () => {
  const dir = await fixture();
  try {
    const selection = sddTaskSelection(dir, "retry-policy", ["T003"]);
    const ref = {
      featureDir: selection.featureRef,
      taskIds: ["T003"],
      tasks: selection.tasks.map(sddTaskSnapshot),
    };
    assert.equal(sddTaskSelectionProblem(dir, ref), undefined);

    const tasksFile = join(dir, "specs/retry-policy/tasks.md");
    const content = await readFile(tasksFile, "utf8");
    await writeFile(tasksFile, content.replace("Document retry", "Document retry carefully"), "utf8");
    assert.match(sddTaskSelectionProblem(dir, ref) ?? "", /task slice changed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the child handoff contains only its selected task slice", async () => {
  const dir = await fixture();
  try {
    const selection = sddTaskSelection(dir, "retry-policy", ["T001"]);
    const record = validateHandoff({
      scope: "retry-t001",
      goal: "Implement the retry helper",
      acceptanceCriteria: selection.acceptanceCriteria,
      laneFiles: selection.laneFiles,
      sdd: {
        featureDir: selection.featureRef,
        taskIds: ["T001"],
        tasks: selection.tasks.map(sddTaskSnapshot),
      },
    });
    const rendered = renderHandoffForChild(record);
    assert.match(rendered, /## SDD task slice/);
    assert.match(rendered, /T001: Add retry helper/);
    assert.doesNotMatch(rendered, /T002: Add attempt limit/);
    assert.doesNotMatch(rendered, /T003: Document retry/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("handoff validation rejects malformed SDD metadata", () => {
  assert.throws(
    () => validateHandoff({
      scope: "bad",
      goal: "G",
      acceptanceCriteria: ["A"],
      laneFiles: ["src/a.ts"],
      sdd: { featureDir: "../../etc", taskIds: ["T001"] },
    }),
    /sdd\.featureDir/,
  );
  assert.throws(
    () => validateHandoff({
      scope: "bad",
      goal: "G",
      acceptanceCriteria: ["A"],
      laneFiles: ["src/a.ts"],
      sdd: { featureDir: "specs/good", taskIds: [] },
    }),
    /taskIds/,
  );
});
