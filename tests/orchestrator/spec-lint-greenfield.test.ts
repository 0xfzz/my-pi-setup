/**
 * Tests for greenfield-aware spec linting.
 *
 * Verifies that:
 * 1. Explicit createdPaths and document creates declarations exempt only declared paths.
 * 2. Undeclared missing references still produce findings; existing paths do not become defects.
 * 3. Lane declarations alone do NOT automatically exempt missing reference paths.
 * 4. Permitted reference paths that do not exist in the repository are still flagged.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractCreatedPaths, lintSpec } from "../../lib/orchestrator/spec-lint.ts";

describe("greenfield-aware spec linting", () => {
  it("exempts paths provided via explicit createdPaths input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-greenfield-"));
    try {
      const findings = lintSpec({
        cwd: dir,
        content: "## Acceptance\n- retry lives in `src/net/planned.ts` and verify with `npm test`\n",
        createdPaths: ["src/net/planned.ts"],
      });
      // Declared planned path is not flagged as missing
      assert.equal(findings.some((f) => f.discrepancy.includes("src/net/planned.ts")), false);
      assert.deepEqual(findings, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("handles path normalization for createdPaths (leading ./ and absolute paths)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-greenfield-"));
    try {
      const findings = lintSpec({
        cwd: dir,
        content: "## Acceptance\n- retry in `./src/net/a.ts` and `src/net/b.ts`; verify with `npm test`\n",
        createdPaths: ["src/net/a.ts", join(dir, "src/net/b.ts")],
      });
      assert.deepEqual(findings, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exempts paths declared in creates: YAML block lists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-greenfield-"));
    try {
      const spec = [
        "## Specification",
        "creates:",
        "  - src/net/planned-service.ts",
        "  - `tests/net/planned-service.test.ts`",
        "",
        "## Acceptance criteria",
        "- `src/net/planned-service.ts` passes `tests/net/planned-service.test.ts` via `npm test`",
      ].join("\n");

      const findings = lintSpec({ cwd: dir, content: spec });
      assert.deepEqual(findings, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exempts paths declared in creates: YAML flow lists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-greenfield-"));
    try {
      const spec = [
        "## Unit Manifest",
        "creates: [src/net/flow-a.ts, \"src/net/flow-b.ts\", `src/net/flow-c.ts`]",
        "",
        "## Acceptance criteria",
        "- `src/net/flow-a.ts`, `src/net/flow-b.ts`, and `src/net/flow-c.ts` pass `npm test`",
      ].join("\n");

      const findings = lintSpec({ cwd: dir, content: spec });
      assert.deepEqual(findings, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exempts paths declared with `path # new` inside backticks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-greenfield-"));
    try {
      const spec = [
        "## Acceptance criteria",
        "- entrypoint in `src/net/entry.ts # new` handles requests",
        "- verify with `npm test`",
      ].join("\n");

      const findings = lintSpec({ cwd: dir, content: spec });
      assert.deepEqual(findings, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exempts paths declared with `path` # new outside backticks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-greenfield-"));
    try {
      const spec = [
        "## Acceptance criteria",
        "- entrypoint in `src/net/entry.ts` # new handles requests",
        "- helper in `src/net/helper.ts` (# new) formats errors",
        "- verify with `npm test`",
      ].join("\n");

      const findings = lintSpec({ cwd: dir, content: spec });
      assert.deepEqual(findings, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exempts list items with `- path # new` without backticks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-greenfield-"));
    try {
      const spec = [
        "## Files",
        "- src/net/worker.ts # new",
        "",
        "## Acceptance criteria",
        "- `src/net/worker.ts` starts cleanly; verify with `npm test`",
      ].join("\n");

      const findings = lintSpec({ cwd: dir, content: spec });
      assert.deepEqual(findings, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lane alone is NOT automatically new", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-greenfield-"));
    try {
      const specWithLaneFiles = [
        "laneFiles:",
        "  - src/net/missing-lane.ts",
        "",
        "## Acceptance criteria",
        "- `src/net/missing-lane.ts` handles connections; verify with `npm test`",
      ].join("\n");

      const findings = lintSpec({ cwd: dir, content: specWithLaneFiles });
      assert.ok(
        findings.some((f) => f.severity === "major" && f.discrepancy.includes("src/net/missing-lane.ts")),
        "laneFiles alone without creates: or # new must be flagged when missing",
      );

      const specWithLaneKey = [
        "lane: src/net/missing-lane.ts",
        "",
        "## Acceptance criteria",
        "- `src/net/missing-lane.ts` handles connections; verify with `npm test`",
      ].join("\n");

      const findingsLaneKey = lintSpec({ cwd: dir, content: specWithLaneKey });
      assert.ok(
        findingsLaneKey.some((f) => f.severity === "major" && f.discrepancy.includes("src/net/missing-lane.ts")),
        "lane key alone without creates: or # new must be flagged when missing",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("undeclared missing references still produce findings when declared paths are present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-greenfield-"));
    try {
      const spec = [
        "creates:",
        "  - src/net/legit-new.ts",
        "",
        "## Acceptance criteria",
        "- `src/net/legit-new.ts` delegates to `src/net/undeclared-ghost.ts`",
        "- verify with `npm test`",
      ].join("\n");

      const findings = lintSpec({ cwd: dir, content: spec });
      // legit-new.ts is exempt
      assert.equal(findings.some((f) => f.discrepancy.includes("src/net/legit-new.ts")), false);
      // undeclared-ghost.ts is flagged
      assert.ok(findings.some((f) => f.discrepancy.includes("src/net/undeclared-ghost.ts")));
      assert.equal(findings.length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not exempt missing permitted reference paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-greenfield-"));
    try {
      const spec = [
        "creates:",
        "  - src/net/legit-new.ts",
        "",
        "## Acceptance criteria",
        "- `src/net/legit-new.ts` works; verify with `npm test`",
      ].join("\n");

      const findings = lintSpec({
        cwd: dir,
        content: spec,
        references: ["src/missing-ref.ts"],
      });
      // The permitted reference path that doesn't exist on disk is flagged
      assert.ok(findings.some((f) => f.location === "permitted reference paths" && f.discrepancy.includes("src/missing-ref.ts")));
      // The created path is not flagged
      assert.equal(findings.some((f) => f.discrepancy.includes("src/net/legit-new.ts")), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("existing paths in the repository do not become defects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-greenfield-"));
    await writeFile(join(dir, "existing-file.ts"), "export const x = 1;\n", "utf8");
    try {
      const spec = [
        "creates:",
        "  - src/net/new-file.ts",
        "",
        "## Acceptance criteria",
        "- `src/net/new-file.ts` imports `existing-file.ts`",
        "- verify with `npm test`",
      ].join("\n");

      const findings = lintSpec({ cwd: dir, content: spec, references: ["existing-file.ts"] });
      assert.deepEqual(findings, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("extractCreatedPaths extracts from explicit input, creates: blocks, and # new comments", () => {
    const content = [
      "creates: [a.ts, b.ts]",
      "creates:",
      "  - c.ts",
      "  - `d.ts` # note",
      "- `e.ts # new`",
      "- `f.ts` # new",
      "- g.ts # new",
      "laneFiles:",
      "  - h.ts",
    ].join("\n");

    const paths = extractCreatedPaths({
      content,
      createdPaths: ["explicit.ts", "./relative.ts"],
    });

    assert.ok(paths.includes("explicit.ts"));
    assert.ok(paths.includes("relative.ts"));
    assert.ok(paths.includes("a.ts"));
    assert.ok(paths.includes("b.ts"));
    assert.ok(paths.includes("c.ts"));
    assert.ok(paths.includes("d.ts"));
    assert.ok(paths.includes("e.ts"));
    assert.ok(paths.includes("f.ts"));
    assert.ok(paths.includes("g.ts"));
    assert.equal(paths.includes("h.ts"), false, "laneFiles alone must not be included in createdPaths");
  });
});
