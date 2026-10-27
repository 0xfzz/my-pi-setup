import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_ROLE_PROMPTS,
  ROLE_PROMPT_FILES,
  ensureRolePrompts,
  loadRolePrompt,
  projectRolePromptDir,
  renderRolePromptReport,
  rolePromptFileNames,
} from "../../lib/orchestrator/role-prompts.ts";
import { ORCH_ROLES } from "../../lib/orchestrator/role-models.ts";

async function ws(): Promise<{ cwd: string; globalDir: string; detach: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "role-prompts-"));
  const cwd = join(root, "repo");
  const globalDir = join(root, "agent", "orch-agents");
  await mkdir(cwd, { recursive: true });
  return { cwd, globalDir, detach: () => rm(root, { recursive: true, force: true }) };
}

async function writePrompt(dir: string, name: string, text: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), text, "utf8");
}

test("every role has a distinct built-in default that states its authority boundary", () => {
  const texts = ORCH_ROLES.map((role) => DEFAULT_ROLE_PROMPTS[role]);
  assert.equal(new Set(texts).size, ORCH_ROLES.length, "defaults are not copies of each other");
  assert.match(DEFAULT_ROLE_PROMPTS["devil-advocate"], /independent specification reviewer/);
  assert.match(DEFAULT_ROLE_PROMPTS.worker, /laneFiles.*only files you may change/s);
  assert.match(DEFAULT_ROLE_PROMPTS["qa-review"], /verdict, not a patch/);
});

test("canonical file names follow the documented workspace layout", () => {
  assert.equal(ROLE_PROMPT_FILES["devil-advocate"].canonical, "devil-advocate.md");
  assert.equal(ROLE_PROMPT_FILES.worker.canonical, "worker.md");
  assert.equal(ROLE_PROMPT_FILES["qa-review"].canonical, "qa-reviewer.md");
  assert.deepEqual(rolePromptFileNames("qa-review"), ["qa-reviewer.md", "qa-review.md"]);
});

test("a workspace file overrides the global file, which overrides the built-in", async () => {
  const h = await ws();
  try {
    const projectDir = projectRolePromptDir(h.cwd);

    assert.equal(loadRolePrompt("worker", h.cwd, { globalDir: h.globalDir }).source, "builtin");

    await writePrompt(h.globalDir, "worker.md", "global worker prompt\n");
    assert.equal(loadRolePrompt("worker", h.cwd, { globalDir: h.globalDir }).source, "global");

    await writePrompt(projectDir, "worker.md", "workspace worker prompt\n");
    const resolved = loadRolePrompt("worker", h.cwd, { globalDir: h.globalDir });
    assert.equal(resolved.source, "project");
    assert.equal(resolved.text, "workspace worker prompt");
    assert.equal(resolved.path, join(projectDir, "worker.md"));
  } finally {
    await h.detach();
  }
});

test("an empty workspace file falls through instead of silencing the role", async () => {
  const h = await ws();
  try {
    await writePrompt(projectRolePromptDir(h.cwd), "worker.md", "   \n\n");
    await writePrompt(h.globalDir, "worker.md", "global fallback\n");
    const resolved = loadRolePrompt("worker", h.cwd, { globalDir: h.globalDir });
    assert.equal(resolved.source, "global");
    assert.equal(resolved.text, "global fallback");
  } finally {
    await h.detach();
  }
});

test("qa-review accepts the role-id file name as an alias", async () => {
  const h = await ws();
  try {
    await writePrompt(projectRolePromptDir(h.cwd), "qa-review.md", "alias prompt\n");
    const resolved = loadRolePrompt("qa-review", h.cwd, { globalDir: h.globalDir });
    assert.equal(resolved.source, "project");
    assert.equal(resolved.text, "alias prompt");
  } finally {
    await h.detach();
  }
});

test("init writes the three canonical files and never discards authored content", async () => {
  const h = await ws();
  try {
    const first = ensureRolePrompts(h.cwd);
    assert.equal(first.created.length, 3);
    assert.deepEqual(
      first.created.map((path) => path.slice(first.dir.length + 1)).sort(),
      ["devil-advocate.md", "qa-reviewer.md", "worker.md"],
    );
    assert.equal(await readFile(join(first.dir, "worker.md"), "utf8"), `${DEFAULT_ROLE_PROMPTS.worker}\n`);

    await writeFile(join(first.dir, "worker.md"), "team-specific worker\n", "utf8");
    const second = ensureRolePrompts(h.cwd);
    assert.deepEqual(second.created, []);
    assert.equal(second.skipped.length, 3);
    assert.equal(await readFile(join(first.dir, "worker.md"), "utf8"), "team-specific worker\n");

    const forced = ensureRolePrompts(h.cwd, { force: true });
    assert.equal(forced.created.length, 3);
    assert.equal(await readFile(join(first.dir, "worker.md"), "utf8"), `${DEFAULT_ROLE_PROMPTS.worker}\n`);
  } finally {
    await h.detach();
  }
});

test("the report names where each prompt actually comes from", async () => {
  const h = await ws();
  try {
    let rows = renderRolePromptReport(h.cwd, { globalDir: h.globalDir });
    assert.equal(rows.length, 3);
    for (const row of rows) assert.match(row, /builtin default \(not saved\)/);

    ensureRolePrompts(h.cwd);
    rows = renderRolePromptReport(h.cwd, { globalDir: h.globalDir });
    assert.match(rows[0]!, /^devil-advocate {2}project {2}\.pi\/orch-agents\/devil-advocate\.md/);
    assert.match(rows[2]!, /qa-review {2}project {2}\.pi\/orch-agents\/qa-reviewer\.md/);
    assert.equal(existsSync(join(h.cwd, ".pi", "orch-agents", "worker.md")), true);
  } finally {
    await h.detach();
  }
});
