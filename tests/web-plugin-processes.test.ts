// Process ownership is the durable half of hot-plugging. The failure modes
// pinned here are the ones that leave a machine with orphan processes:
// a child that outlives its plugin, a child that ignores SIGTERM, a child left
// behind by a host that was SIGKILLed, and a reaper that kills a stranger
// because the OS recycled the pid.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createProcessRegistry,
  isOwnedChild,
  isPidAlive,
  reapableChildren,
  reapOrphans,
  startTokenOf,
  type ChildRecord,
  type PidfileContents,
} from "../web/core/plugin-contracts/kernel/processes.ts";

const HOLD = "setInterval(() => {}, 1_000)";
const DEAF = `process.on("SIGTERM", () => {}); ${HOLD}`;
/** A pid no process can have on Linux (pid_max is well under this). */
const DEAD_HOST_PID = 4_000_000;

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pi-plugin-processes-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function waitForExit(pid: number, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (isPidAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function childRecord(pid: number, overrides: Partial<ChildRecord> = {}): ChildRecord {
  return { pid, owner: "test.plugin", command: "node", startToken: startTokenOf(pid), startedAt: 0, ...overrides };
}

function pidfile(children: ChildRecord[], hostPid = DEAD_HOST_PID): PidfileContents {
  return { version: 1, hostPid, hostStartToken: null, children };
}

test("startTokenOf identifies this process and returns nothing for a missing pid", () => {
  const own = startTokenOf(process.pid);
  if (process.platform === "linux") assert.match(String(own), /^\d+$/);
  assert.equal(startTokenOf(DEAD_HOST_PID), null);
  assert.equal(startTokenOf(0), null);
});

test("a recycled pid is not ours: the start token is what makes a kill safe", () => {
  const record = childRecord(process.pid);
  assert.equal(isOwnedChild(record), true);
  // Same pid, different start token — the OS handed this pid to someone else.
  assert.equal(isOwnedChild(record, () => "999999"), false);
  // No token recorded, so ownership cannot be proven: leave it alone.
  assert.equal(isOwnedChild({ ...record, startToken: null }), false);
});

test("reapableChildren skips a host that is still running", () => {
  const record = childRecord(process.pid);
  assert.deepEqual(reapableChildren(pidfile([record], process.pid), DEAD_HOST_PID), []);
  // The previous host is alive and is us: its children are not orphans.
  assert.deepEqual(reapableChildren(pidfile([record], process.pid), 12345), []);
});

test("reapableChildren claims the children of a dead host", () => {
  const record = childRecord(process.pid);
  assert.deepEqual(reapableChildren(pidfile([record]), 12345).map((child) => child.pid), [process.pid]);
});

test("reapOrphans kills what a crashed host left behind, and reports a stranger untouched", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "children.json");
    const orphan = spawn(process.execPath, ["-e", HOLD], { stdio: "ignore" });
    const stranger = spawn(process.execPath, ["-e", HOLD], { stdio: "ignore" });
    try {
      await waitForExit(0, 0);
      assert.ok(orphan.pid !== undefined && stranger.pid !== undefined);
      const ours = childRecord(orphan.pid);
      // Same pid, wrong token: the reaper must treat it as someone else's.
      const recycled = childRecord(stranger.pid, { startToken: "0" });
      writeFileSync(path, JSON.stringify(pidfile([ours, recycled])), "utf8");

      const outcome = await reapOrphans(path, { hostPid: 12345, graceMs: 200 });
      assert.deepEqual(outcome.reaped, [orphan.pid]);
      assert.deepEqual(outcome.skipped, [stranger.pid]);
      await waitForExit(orphan.pid);
      assert.equal(isPidAlive(orphan.pid), false, "the orphan must be gone");
      assert.equal(isPidAlive(stranger.pid), true, "a recycled pid must survive");
    } finally {
      orphan.kill("SIGKILL");
      stranger.kill("SIGKILL");
      await waitForExit(orphan.pid ?? 0);
      await waitForExit(stranger.pid ?? 0);
    }
  });
});

test("reapOrphans leaves the children of a live host alone", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "children.json");
    const child = spawn(process.execPath, ["-e", HOLD], { stdio: "ignore" });
    try {
      assert.ok(child.pid !== undefined);
      // Hosted by this very process, which is alive.
      writeFileSync(path, JSON.stringify(pidfile([childRecord(child.pid)], process.pid)), "utf8");
      const outcome = await reapOrphans(path, { hostPid: 12345, graceMs: 100 });
      assert.deepEqual(outcome.reaped, []);
      assert.deepEqual(outcome.skipped, [child.pid]);
      assert.equal(isPidAlive(child.pid), true);
    } finally {
      child.kill("SIGKILL");
      await waitForExit(child.pid ?? 0);
    }
  });
});

test("reapOrphans tolerates a missing or unreadable pidfile", async () => {
  await withTempDir(async (dir) => {
    const missing = await reapOrphans(join(dir, "absent.json"));
    assert.deepEqual(missing, { reaped: [], skipped: [] });
    const path = join(dir, "broken.json");
    writeFileSync(path, "{not json", "utf8");
    const broken = await reapOrphans(path);
    assert.deepEqual(broken.reaped, []);
    assert.match(String(broken.warning), /not valid JSON/);
  });
});

test("release kills one plugin's children and leaves the other plugin's running", async () => {
  await withTempDir(async (dir) => {
    const registry = createProcessRegistry({ pidFile: join(dir, "children.json"), graceMs: 200 });
    const mine = registry.spawn("acme.mine", process.execPath, ["-e", HOLD]);
    const theirs = registry.spawn("acme.theirs", process.execPath, ["-e", HOLD]);
    try {
      assert.deepEqual(registry.children("acme.mine").map((child) => child.pid), [mine.pid]);
      const released = await registry.release("acme.mine");
      assert.equal(released.length, 1);
      await waitForExit(mine.pid!);
      assert.equal(isPidAlive(mine.pid!), false);
      assert.equal(isPidAlive(theirs.pid!), true, "another plugin's child is not ours to kill");
      assert.deepEqual(registry.children("acme.mine"), []);
      await registry.dispose();
      await waitForExit(theirs.pid!);
      assert.equal(isPidAlive(theirs.pid!), false, "dispose releases everything");
    } finally {
      mine.kill("SIGKILL");
      theirs.kill("SIGKILL");
      await waitForExit(mine.pid ?? 0);
      await waitForExit(theirs.pid ?? 0);
    }
  });
});

test("a child that ignores SIGTERM is escalated to SIGKILL", async () => {
  await withTempDir(async (dir) => {
    const registry = createProcessRegistry({ pidFile: join(dir, "children.json"), graceMs: 150 });
    const deaf = registry.spawn("acme.deaf", process.execPath, ["-e", DEAF]);
    try {
      await registry.release("acme.deaf");
      await waitForExit(deaf.pid!);
      assert.equal(isPidAlive(deaf.pid!), false, "a deaf child must not survive the grace");
    } finally {
      deaf.kill("SIGKILL");
      await waitForExit(deaf.pid ?? 0);
    }
  });
});

test("killAllNow is synchronous, so an exit handler can still clean up", async () => {
  await withTempDir(async (dir) => {
    const registry = createProcessRegistry({ pidFile: join(dir, "children.json"), graceMs: 5_000 });
    const child = registry.spawn("acme.exit", process.execPath, ["-e", DEAF]);
    try {
      registry.killAllNow();
      await waitForExit(child.pid!);
      assert.equal(isPidAlive(child.pid!), false);
      assert.deepEqual(registry.children(), []);
    } finally {
      child.kill("SIGKILL");
      await waitForExit(child.pid ?? 0);
    }
  });
});

test("the pidfile is written on spawn and removed on dispose, so the next boot knows what to reap", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "children.json");
    const registry = createProcessRegistry({ pidFile: path });
    const child = registry.spawn("acme.persist", process.execPath, ["-e", HOLD]);
    try {
      const written = JSON.parse(readFileSync(path, "utf8")) as PidfileContents;
      assert.equal(written.version, 1);
      assert.equal(written.hostPid, process.pid);
      assert.deepEqual(written.children.map((record) => record.owner), ["acme.persist"]);
      assert.equal(written.children[0]?.pid, child.pid);
    } finally {
      child.kill("SIGKILL");
      await waitForExit(child.pid ?? 0);
      await registry.dispose();
    }
    assert.throws(() => readFileSync(path, "utf8"), "the pidfile is removed so nothing is reaped twice");
  });
});

test("a child's own exit drops its record, so the pidfile only lists live children", async () => {
  await withTempDir(async (dir) => {
    const registry = createProcessRegistry({ pidFile: join(dir, "children.json") });
    const child = registry.spawn("acme.oneshot", process.execPath, ["-e", "0"]);
    await waitForExit(child.pid!);
    // The exit event is delivered asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(registry.children(), []);
    await registry.dispose();
  });
});
