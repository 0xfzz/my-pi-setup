import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitBranch } from "./git-branch.ts";

const run = promisify(execFile);

/** A throwaway repository so the test never reads (or writes) the real tree. */
async function git(args: string[], cwd: string): Promise<void> {
  await run("git", args, { cwd });
}

async function withRepo(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-branch-"));
  try {
    await git(["init", "-q", "--initial-branch=main"], dir);
    // A commit so HEAD resolves; the branch lookup does not need any files.
    await git(["config", "user.email", "fixture@example.com"], dir);
    await git(["config", "user.name", "Fixture"], dir);
    await writeFile(join(dir, "README.md"), "fixture\n");
    await git(["add", "README.md"], dir);
    await git(["commit", "-q", "-m", "fixture"], dir);
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the branch of a worktree is its current branch, and renaming follows", async () => {
  await withRepo(async (dir) => {
    assert.equal(await gitBranch(dir), "main");
    await git(["checkout", "-q", "-b", "feature/workspace-line"], dir);
    assert.equal(await gitBranch(dir), "feature/workspace-line");
    // A branch name with a slash is reported whole, never shortened.
    await git(["checkout", "-q", "--detach"], dir);
    assert.equal(await gitBranch(dir), null, "a detached HEAD names no branch");
  });
});

test("a directory that is not a repository has no branch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-nobranch-"));
  try {
    assert.equal(await gitBranch(dir), null);
    // A worktree nested in a repository still resolves: git walks up.
    const nested = join(dir, "nested", "deeper");
    await run("mkdir", ["-p", nested]);
    assert.equal(await gitBranch(nested), null, "outside any repository, not invented from the path");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing path and a plain file answer null instead of throwing", async () => {
  assert.equal(await gitBranch(join(tmpdir(), "pi-web-does-not-exist-9c2f")), null);
  const file = join(await mkdtemp(join(tmpdir(), "pi-web-file-")), "not-a-directory");
  try {
    await writeFile(file, "fixture\n");
    assert.equal(await gitBranch(file), null, "git cannot run in a file, and the lookup absorbs it");
  } finally {
    await rm(file, { force: true });
  }
});

test("a repository with no commits yet still names its branch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-unborn-"));
  try {
    await git(["init", "-q", "--initial-branch=just-started"], dir);
    assert.equal(await gitBranch(dir), "just-started");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a subdirectory of a worktree reports the repository's branch", async () => {
  await withRepo(async (dir) => {
    const nested = join(dir, "packages", "inner");
    await run("mkdir", ["-p", nested]);
    assert.equal(await gitBranch(nested), "main", "git resolves the enclosing worktree");
  });
});
