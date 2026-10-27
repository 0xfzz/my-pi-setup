import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SCRATCH_ENV,
  ensureScratch,
  enforceScratchCaps,
  gcStaleScratch,
  piDirIgnored,
  pruneScratchCache,
  removeScratch,
  resolveScratchRoot,
  sanitizeRunId,
  scratchPathProblem,
} from "../../lib/orchestrator/scratch.ts";

async function fixture(gitignore?: string) {
  const root = await mkdtemp(join(tmpdir(), "orch-scratch-"));
  const cwd = join(root, "repo");
  await mkdir(join(cwd, ".git"), { recursive: true });
  if (gitignore !== undefined) await writeFile(join(cwd, ".gitignore"), gitignore, "utf8");
  const tmpRoot = join(root, "tmp");
  await mkdir(tmpRoot, { recursive: true });
  return { root, cwd, tmpRoot, detach: () => rm(root, { recursive: true, force: true }) };
}

test("scratch lives under .pi/orch-research when .pi/ is gitignored", async () => {
  const h = await fixture(".pi/\nnode_modules/\n");
  try {
    assert.equal(piDirIgnored(h.cwd), true);
    const resolved = resolveScratchRoot({ cwd: h.cwd, runId: "run-1", env: {}, tmpRoot: h.tmpRoot });
    assert.equal(resolved.ok, true);
    const ok = resolved as { root: string; source: string; base: string };
    assert.equal(ok.source, "project");
    assert.equal(ok.base, join(h.cwd, ".pi", "orch-research"));
    assert.equal(ok.root, join(h.cwd, ".pi", "orch-research", "run-1"));
  } finally {
    await h.detach();
  }
});

test("scratch falls back to the temp root when .pi/ is not ignored", async () => {
  const h = await fixture("node_modules/\n");
  try {
    assert.equal(piDirIgnored(h.cwd), false);
    const resolved = resolveScratchRoot({ cwd: h.cwd, runId: "run-2", env: {}, tmpRoot: h.tmpRoot });
    assert.equal(resolved.ok, true);
    const ok = resolved as { root: string; source: string };
    assert.equal(ok.source, "tmp");
    assert.equal(ok.root, join(h.tmpRoot, "orch-research", "run-2"));
  } finally {
    await h.detach();
  }
});

test("a directory that is not a repository never gets a .pi/ write", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-scratch-plain-"));
  try {
    const tmpRoot = join(root, "tmp");
    const resolved = resolveScratchRoot({ cwd: root, runId: "run-3", env: {}, tmpRoot });
    assert.equal(resolved.ok, true);
    assert.equal((resolved as { source: string }).source, "tmp");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PI_ORCH_SCRATCH overrides the location, but not into the work tree", async () => {
  const h = await fixture(".pi/\n");
  try {
    const outside = join(h.root, "outside");
    const accepted = resolveScratchRoot({
      cwd: h.cwd,
      runId: "run-4",
      env: { [SCRATCH_ENV]: outside },
      tmpRoot: h.tmpRoot,
    });
    assert.equal(accepted.ok, true);
    const ok = accepted as { root: string; source: string; base: string };
    assert.equal(ok.source, "env");
    assert.equal(ok.base, outside);
    assert.equal(ok.root, join(outside, "run-4"));

    const relative = resolveScratchRoot({
      cwd: h.cwd,
      env: { [SCRATCH_ENV]: "relative/scratch" },
      tmpRoot: h.tmpRoot,
    });
    assert.equal(relative.ok, false);
    assert.match((relative as { problems: string[] }).problems[0]!, /absolute path/);

    const insideWorkTree = resolveScratchRoot({
      cwd: h.cwd,
      env: { [SCRATCH_ENV]: join(h.cwd, "src") },
      tmpRoot: h.tmpRoot,
    });
    assert.equal(insideWorkTree.ok, false);
    assert.match((insideWorkTree as { problems: string[] }).problems[0]!, /inside the repository/);

    const insideAllowed = resolveScratchRoot({
      cwd: h.cwd,
      env: { [SCRATCH_ENV]: join(h.cwd, ".pi", "orch-research", "custom") },
      tmpRoot: h.tmpRoot,
    });
    assert.equal(insideAllowed.ok, true);
    assert.equal((insideAllowed as { source: string }).source, "env");
  } finally {
    await h.detach();
  }
});

test("the scratch layout is private and complete", async () => {
  const h = await fixture(".pi/\n");
  try {
    const layout = ensureScratch(join(h.cwd, ".pi", "orch-research", "run-5"));
    for (const dir of [layout.root, layout.cache, layout.webCache, layout.codeCache, layout.searchCache, layout.tmp, layout.stage]) {
      assert.equal(existsSync(dir), true, dir);
      assert.equal(statSync(dir).mode & 0o777, 0o700, `${dir} must be private`);
    }
  } finally {
    await h.detach();
  }
});

test("a path outside the root, or through a symlink, is refused", async () => {
  const h = await fixture(".pi/\n");
  try {
    const layout = ensureScratch(join(h.cwd, ".pi", "orch-research", "run-6"));
    assert.equal(scratchPathProblem("cache/web/page.txt", layout.root), undefined);

    assert.match(String(scratchPathProblem("../escape.txt", layout.root)), /outside the scratch root/);
    assert.match(String(scratchPathProblem(join(h.root, "absolute.txt"), layout.root)), /outside the scratch root/);

    const outside = join(h.root, "outside-dir");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(layout.root, "link"));
    assert.match(String(scratchPathProblem("link/page.txt", layout.root)), /symlink/);
  } finally {
    await h.detach();
  }
});

test("caps drop oversized files and evict oldest first", async () => {
  const h = await fixture(".pi/\n");
  try {
    const layout = ensureScratch(join(h.cwd, ".pi", "orch-research", "run-7"));
    const huge = join(layout.webCache, "huge.bin");
    await writeFile(huge, Buffer.alloc(64));
    const oldest = join(layout.webCache, "oldest.txt");
    const newest = join(layout.webCache, "newest.txt");
    await writeFile(oldest, Buffer.alloc(10));
    await writeFile(newest, Buffer.alloc(10));
    await utimes(oldest, new Date(1_000), new Date(1_000));

    const report = enforceScratchCaps(layout.root, { maxFileBytes: 20, maxBytes: 10 });
    assert.ok(report.removed.includes(huge), "an oversized file is removed");
    assert.ok(report.removed.includes(oldest), "the oldest entry makes room");
    assert.equal(existsSync(newest), true);
    assert.ok(report.totalBytes <= 10);
  } finally {
    await h.detach();
  }
});

test("cache TTL prunes old entries and keeps fresh ones", async () => {
  const h = await fixture(".pi/\n");
  try {
    const layout = ensureScratch(join(h.cwd, ".pi", "orch-research", "run-8"));
    const old = join(layout.webCache, "old.txt");
    const fresh = join(layout.webCache, "fresh.txt");
    await writeFile(old, "old");
    await writeFile(fresh, "fresh");
    const now = Date.now();
    await utimes(old, new Date(now - 60_000), new Date(now - 60_000));

    const removed = pruneScratchCache(layout.root, { now, ttlMs: 10_000 });
    assert.deepEqual(removed, [old]);
    assert.equal(existsSync(fresh), true);
  } finally {
    await h.detach();
  }
});

test("cleanup removes one run and garbage-collects stale runs only", async () => {
  const h = await fixture(".pi/\n");
  try {
    const base = join(h.cwd, ".pi", "orch-research");
    const current = ensureScratch(join(base, "run-current"));
    const stale = ensureScratch(join(base, "run-stale"));
    const now = Date.now();
    await utimes(stale.root, new Date(now - 48 * 60 * 60 * 1000), new Date(now - 48 * 60 * 60 * 1000));

    const removed = gcStaleScratch(base, { now });
    assert.deepEqual(removed, [stale.root]);
    assert.equal(existsSync(current.root), true);
    assert.equal(existsSync(stale.root), false);

    removeScratch(current.root);
    assert.equal(existsSync(current.root), false);
    removeScratch(current.root); // idempotent
  } finally {
    await h.detach();
  }
});

test("run ids are sanitized so they cannot escape the scratch base", () => {
  assert.equal(sanitizeRunId("../../etc/passwd"), "etc-passwd");
  assert.equal(sanitizeRunId("review:run-1:gate"), "review-run-1-gate");
  assert.equal(sanitizeRunId(""), "scratch");
});
