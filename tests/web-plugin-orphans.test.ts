// The host is the owner of record for the processes plugin code starts. The
// failure this pins: a host that was SIGKILLed leaves its plugin's children
// running, and the next boot has no idea they exist, so the machine slowly
// fills with orphans holding ports and locks.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPluginHost } from "../web/core/plugin-contracts/kernel/host.ts";
import { isPidAlive, startTokenOf } from "../web/core/plugin-contracts/kernel/processes.ts";

const HOLD = "setInterval(() => {}, 1_000)";
/** A pid no process can have on Linux (pid_max is well under this). */
const DEAD_HOST_PID = 4_000_000;

interface Paths {
  statePath: string;
  pidFile: string;
}

function withPaths(fn: (paths: Paths) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "web-plugin-orphans-"));
  const paths = { statePath: join(dir, "web-plugins.json"), pidFile: join(dir, "children.json") };
  return fn(paths).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function holdChild(): ReturnType<typeof spawn> {
  return spawn(process.execPath, ["-e", HOLD], { stdio: "ignore" });
}

/** The pidfile a crashed host would have left: its own pid is dead. */
function crashedHostPidfile(childPid: number, hostPid = DEAD_HOST_PID): string {
  return JSON.stringify({
    version: 1,
    hostPid,
    hostStartToken: null,
    children: [{ pid: childPid, owner: "acme.orphan", command: "node", startToken: startTokenOf(childPid), startedAt: 0 }],
  });
}

async function waitForExit(pid: number, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (isPidAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("boot reaps the child a crashed predecessor left behind", async () => {
  await withPaths(async ({ statePath, pidFile }) => {
    const orphan = holdChild();
    try {
      writeFileSync(pidFile, crashedHostPidfile(orphan.pid!), "utf8");
      const host = createPluginHost({ descriptors: [], descriptorDir: "/repo/web-plugins", statePath, pidFile });
      await host.ready;
      await waitForExit(orphan.pid!);
      assert.equal(isPidAlive(orphan.pid!), false, "the next boot must not inherit a running child");
      assert.ok(
        host.audit.list({ kind: "lifecycle" }).some((entry) => entry.detail.includes("orphaned child")),
        "reaping is recorded, so an operator can see why a process disappeared",
      );
      await host.shutdown();
    } finally {
      orphan.kill("SIGKILL");
      await waitForExit(orphan.pid ?? 0);
    }
  });
});

test("boot leaves the children of a live sibling host alone", async () => {
  await withPaths(async ({ statePath, pidFile }) => {
    const child = holdChild();
    try {
      // This very process wrote the pidfile: it is alive and still owns the child.
      writeFileSync(pidFile, crashedHostPidfile(child.pid!, process.pid), "utf8");
      const host = createPluginHost({ descriptors: [], descriptorDir: "/repo/web-plugins", statePath, pidFile });
      await host.ready;
      assert.equal(isPidAlive(child.pid!), true, "a running host's children are not orphans");
      await host.shutdown();
    } finally {
      child.kill("SIGKILL");
      await waitForExit(child.pid ?? 0);
    }
  });
});

test("shutdown releases every owned child and removes the pidfile", async () => {
  await withPaths(async ({ statePath, pidFile }) => {
    const host = createPluginHost({ descriptors: [], descriptorDir: "/repo/web-plugins", statePath, pidFile });
    await host.ready;
    const child = host.processes.spawn("acme.owned", process.execPath, ["-e", HOLD]);
    try {
      assert.equal(host.processes.children().length, 1);
      assert.equal(existsSync(pidFile), true, "ownership is recorded while the child runs");
      await host.shutdown();
      await waitForExit(child.pid!);
      assert.equal(isPidAlive(child.pid!), false, "a clean shutdown leaves nothing running");
      assert.equal(existsSync(pidFile), false, "nothing is left for the next boot to reap");
    } finally {
      child.kill("SIGKILL");
      await waitForExit(child.pid ?? 0);
    }
  });
});

test("an unreadable pidfile is a warning, not a boot failure", async () => {
  await withPaths(async ({ statePath, pidFile }) => {
    writeFileSync(pidFile, "{not json", "utf8");
    const host = createPluginHost({ descriptors: [], descriptorDir: "/repo/web-plugins", statePath, pidFile });
    await host.ready;
    assert.ok(host.warnings.some((warning) => warning.includes("not valid JSON")), "the operator is told reaping was skipped");
    await host.shutdown();
  });
});
