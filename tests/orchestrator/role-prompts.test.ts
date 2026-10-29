import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_ROLE_PROMPTS,
  ROLE_PROMPT_DIR,
  ROLE_PROMPT_FILES,
  ensureRolePrompts,
  globalRolePromptDir,
  loadRolePrompt,
  projectRolePromptDir,
  renderRolePromptReport,
} from "../../lib/orchestrator/role-prompts.ts";
import { ORCH_ROLES } from "../../lib/orchestrator/role-models.ts";

test("ORCH_ROLES contains exactly planner and worker primitives", () => {
  assert.deepEqual(ORCH_ROLES, ["planner", "worker"]);
  assert.equal(ROLE_PROMPT_FILES.planner.canonical, "planner.md");
  assert.equal(ROLE_PROMPT_FILES.worker.canonical, "worker.md");
  assert.equal(ROLE_PROMPT_DIR, join(".pi", "agents", "system-prompts"));
});

test("globalRolePromptDir resolves default global agents directory", () => {
  const dir = globalRolePromptDir();
  assert.ok(dir.endsWith(join("agents", "system-prompts")));
});

test("builtin defaults are general-purpose, non-empty, and role-differentiated", () => {
  for (const role of ORCH_ROLES) {
    const text = DEFAULT_ROLE_PROMPTS[role];
    assert.ok(text.length > 50, `${role} default prompt must be substantial`);
    assert.match(text, new RegExp(`# Role: ${role}`));
  }

  // Planner must be read-only and focus on research/planning
  assert.match(DEFAULT_ROLE_PROMPTS.planner, /read-only/i);
  assert.match(DEFAULT_ROLE_PROMPTS.planner, /artifact/i);
  assert.match(DEFAULT_ROLE_PROMPTS.planner, /planning/i);

  // Worker must be focused on execution and verification
  assert.match(DEFAULT_ROLE_PROMPTS.worker, /implementation|execute/i);
  assert.match(DEFAULT_ROLE_PROMPTS.worker, /verification/i);
});

test("loadRolePrompt falls back to builtin when no file exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "role-prompts-test-"));
  try {
    for (const role of ORCH_ROLES) {
      const prompt = loadRolePrompt(role, dir);
      assert.equal(prompt.role, role);
      assert.equal(prompt.source, "builtin");
      assert.equal(prompt.text, DEFAULT_ROLE_PROMPTS[role]);
      assert.equal(prompt.path, undefined);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace file overrides global and builtin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "role-prompts-workspace-"));
  const globalDir = await mkdtemp(join(tmpdir(), "role-prompts-global-"));
  try {
    const projectDir = projectRolePromptDir(dir);
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "planner.md"), "# Custom Workspace Planner\nExplore carefully.", "utf8");
    await writeFile(join(globalDir, "planner.md"), "# Global Planner\nExplore globally.", "utf8");

    const prompt = loadRolePrompt("planner", dir, { globalDir });
    assert.equal(prompt.source, "project");
    assert.match(prompt.text, /Custom Workspace Planner/);
    assert.equal(prompt.path, join(projectDir, "planner.md"));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(globalDir, { recursive: true, force: true });
  }
});

test("global file overrides builtin when workspace has no file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "role-prompts-workspace-"));
  const globalDir = await mkdtemp(join(tmpdir(), "role-prompts-global-"));
  try {
    await mkdir(globalDir, { recursive: true });
    await writeFile(join(globalDir, "worker.md"), "# Global Worker\nExecute with care.", "utf8");

    const prompt = loadRolePrompt("worker", dir, { globalDir });
    assert.equal(prompt.source, "global");
    assert.match(prompt.text, /Global Worker/);
    assert.equal(prompt.path, join(globalDir, "worker.md"));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(globalDir, { recursive: true, force: true });
  }
});

test("empty or whitespace-only files fall through to builtin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "role-prompts-empty-"));
  try {
    const projectDir = projectRolePromptDir(dir);
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "planner.md"), "   \n\n  \t ", "utf8");

    const prompt = loadRolePrompt("planner", dir);
    assert.equal(prompt.source, "builtin");
    assert.equal(prompt.text, DEFAULT_ROLE_PROMPTS.planner);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureRolePrompts creates planner.md and worker.md and respects force", async () => {
  const dir = await mkdtemp(join(tmpdir(), "role-prompts-ensure-"));
  try {
    const res1 = ensureRolePrompts(dir);
    assert.equal(res1.created.length, 2);
    assert.equal(res1.skipped.length, 0);

    const plannerFile = join(projectRolePromptDir(dir), "planner.md");
    const workerFile = join(projectRolePromptDir(dir), "worker.md");
    assert.ok(existsSync(plannerFile));
    assert.ok(existsSync(workerFile));

    const content = await readFile(plannerFile, "utf8");
    assert.match(content, /Role: planner/);

    // Run again without force: should skip both
    const res2 = ensureRolePrompts(dir);
    assert.equal(res2.created.length, 0);
    assert.equal(res2.skipped.length, 2);

    // Overwrite with custom content
    await writeFile(plannerFile, "# Custom Content\n", "utf8");

    // Run with force: should overwrite
    const res3 = ensureRolePrompts(dir, { force: true });
    assert.equal(res3.created.length, 2);
    const renewed = await readFile(plannerFile, "utf8");
    assert.match(renewed, /Role: planner/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renderRolePromptReport lists all roles with source attribution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "role-prompts-report-"));
  try {
    const report = renderRolePromptReport(dir);
    assert.equal(report.length, 2);
    assert.match(report[0]!, /planner\s+builtin/);
    assert.match(report[1]!, /worker\s+builtin/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
