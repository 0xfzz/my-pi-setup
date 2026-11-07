import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireReloadLock,
  buildRecordPath,
  evaluateChange,
  fingerprintInputs,
  readBuildRecord,
  sourceFingerprints,
  sourceWatchRoots,
  watchSources,
  writeBuildRecord,
} from "../lib/web-ui-reload.ts";
import { formatElapsed, reloadWebUi, reloadWebUiIfChanged, startWebUi, type WebUiDeps, type WebUiState } from "../lib/web-ui.ts";

async function tree(): Promise<string> {
  return mkdtemp(join(tmpdir(), "web-ui-reload-"));
}

test("fingerprints change when a build input changes, and ignore node_modules, .next and tests", async () => {
  const root = await tree();
  try {
    await mkdir(join(root, "app"), { recursive: true });
    await mkdir(join(root, "node_modules", "x"), { recursive: true });
    await mkdir(join(root, ".next"), { recursive: true });
    await writeFile(join(root, "app", "page.tsx"), "a");
    await writeFile(join(root, "app", "page.test.mjs"), "t");
    await writeFile(join(root, "node_modules", "x", "i.js"), "n");
    await writeFile(join(root, ".next", "BUILD_ID"), "1");
    const before = fingerprintInputs(root, ["app"], []);

    await writeFile(join(root, "node_modules", "x", "i.js"), "changed dependency");
    await writeFile(join(root, ".next", "BUILD_ID"), "2");
    await writeFile(join(root, "app", "page.test.mjs"), "changed test");
    assert.equal(fingerprintInputs(root, ["app"], []), before, "ignored paths do not move the fingerprint");

    await writeFile(join(root, "app", "page.tsx"), "ab");
    assert.notEqual(fingerprintInputs(root, ["app"], []), before, "a source edit does");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file touched with the same size still moves the fingerprint (mtime)", async () => {
  const root = await tree();
  try {
    await mkdir(join(root, "lib"), { recursive: true });
    const file = join(root, "lib", "a.ts");
    await writeFile(file, "x");
    const before = fingerprintInputs(root, ["lib"], []);
    await utimes(file, new Date(2030, 0, 1), new Date(2030, 0, 1));
    assert.notEqual(fingerprintInputs(root, ["lib"], []), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing config file is part of the fingerprint as absence, not an error", async () => {
  const root = await tree();
  try {
    const absent = fingerprintInputs(root, [], ["next.config.ts"]);
    await writeFile(join(root, "next.config.ts"), "export default {};");
    assert.notEqual(fingerprintInputs(root, [], ["next.config.ts"]), absent);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("build and runtime inputs are fingerprinted separately, so a plugin edit does not rebuild", async () => {
  const repo = await tree();
  try {
    const vendor = join(repo, "vendor", "pi-web");
    await mkdir(join(vendor, "app"), { recursive: true });
    await mkdir(join(repo, "lib", "web-plugins"), { recursive: true });
    await writeFile(join(vendor, "app", "page.tsx"), "ui");
    await writeFile(join(repo, "lib", "web-plugins", "host.ts"), "logic");
    const first = sourceFingerprints(vendor, repo);

    await writeFile(join(repo, "lib", "web-plugins", "host.ts"), "logic v2");
    const second = sourceFingerprints(vendor, repo);
    assert.equal(second.build, first.build, "runtime edit leaves the build fingerprint alone");
    assert.notEqual(second.runtime, first.runtime);

    await writeFile(join(vendor, "app", "page.tsx"), "ui v2");
    assert.notEqual(sourceFingerprints(vendor, repo).build, second.build, "a UI edit changes the build fingerprint");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("evaluateChange: no record means everything changed; otherwise each kind is compared on its own", () => {
  const now = { build: "b1", runtime: "r1" };
  assert.deepEqual(evaluateChange(now, null), { build: true, runtime: true });
  assert.deepEqual(evaluateChange(now, { build: "b1", runtime: "r1" }), { build: false, runtime: false });
  assert.deepEqual(evaluateChange(now, { build: "b0", runtime: "r1" }), { build: true, runtime: false });
  assert.deepEqual(evaluateChange(now, { build: "b1", runtime: "r0" }), { build: false, runtime: true });
});

test("the build record round-trips and a corrupt record reads as absent", async () => {
  const dir = await tree();
  try {
    const path = buildRecordPath(join(dir, "web-ui-state.json"));
    assert.equal(path, join(dir, "web-ui-build.json"), "the record sits next to the state file");
    assert.equal(await readBuildRecord(path), null);
    await writeBuildRecord(path, { build: "b", runtime: "r", builtAt: "t" });
    assert.deepEqual(await readBuildRecord(path), { build: "b", runtime: "r", builtAt: "t" });
    await writeFile(path, "{ broken");
    assert.equal(await readBuildRecord(path), null);
    assert.equal((await readFile(path, "utf8")).includes("broken"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the reload lock is exclusive, and a lock whose owner died is taken over", async () => {
  const dir = await tree();
  try {
    const lock = join(dir, "web-ui-reload.lock");
    const alive = () => true;
    const release = acquireReloadLock(lock, alive);
    assert.ok(release, "first taker gets the lock");
    assert.equal(acquireReloadLock(lock, alive), null, "a second taker is refused while the owner lives");
    release!();
    assert.ok(acquireReloadLock(lock, alive), "released locks can be taken again");

    // Simulate a dead owner: the pid in the owner file is not running.
    await writeFile(join(lock, "owner"), `99999 ${Date.now()}`);
    assert.ok(acquireReloadLock(lock, () => false), "a dead owner's lock is taken over");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("source roots name only the build inputs and our runtime directories", () => {
  const roots = sourceWatchRoots("/repo/vendor/pi-web", "/repo");
  assert.ok(roots.includes("/repo/vendor/pi-web/app"));
  assert.ok(roots.includes("/repo/lib/web-plugins"));
  assert.ok(roots.includes("/repo/web-plugins"));
  assert.equal(roots.some((r) => r.includes("node_modules") || r.endsWith("/vendor/pi-web")), false);
});

test("the watcher fires once after a quiet period, and ignores node_modules churn", async () => {
  const root = await tree();
  try {
    await mkdir(join(root, "app"), { recursive: true });
    await mkdir(join(root, "app", "node_modules"), { recursive: true });
    let fired = 0;
    const watcher = watchSources({ roots: [join(root, "app")], debounceMs: 80, onChange: () => { fired++; } });
    try {
      await writeFile(join(root, "app", "node_modules", "dep.js"), "noise");
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(fired, 0, "an ignored path does not trigger a reload");

      await writeFile(join(root, "app", "a.tsx"), "1");
      await writeFile(join(root, "app", "b.tsx"), "2");
      await writeFile(join(root, "app", "c.tsx"), "3");
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(fired, 1, "a burst of saves is one reload");
    } finally {
      watcher.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A fake managed server: health follows whether the process was started and not killed. */
function fakeServer(options: { build?: "current" | "stale"; runtime?: "current" | "stale"; statePath: string; lock?: boolean }) {
  const calls: string[] = [];
  let up = true;
  let state: WebUiState | null = { pid: 1111, port: 30141, url: "http://127.0.0.1:30141", startedBy: "s", startedAt: "t" };
  const record = { build: "b", runtime: "r", builtAt: "t" };
  const current = { build: options.build === "stale" ? "b2" : "b", runtime: options.runtime === "stale" ? "r2" : "r" };
  const deps: Partial<WebUiDeps> = {
    statePath: options.statePath,
    checkVendorDir: () => true,
    hasBuild: () => true,
    sessionId: "s2",
    pollIntervalMs: 1,
    startupTimeoutMs: 1000,
    sleep: async () => {},
    fetchHealth: async () => up,
    // The fake pid is not a real process, so liveness is the fake's own answer.
    isPidAlive: () => up,
    readState: async () => state,
    removeState: async () => {
      calls.push("removeState");
      state = null;
    },
    killProcess: (pid) => {
      calls.push(`kill ${pid}`);
      up = false;
    },
    forceKillProcess: (pid) => {
      calls.push(`force kill ${pid}`);
      up = false;
    },
    stopGraceMs: 1000,
    spawnServer: () => {
      calls.push("spawn");
      up = true;
      return { pid: 2222, unref: () => {} };
    },
    buildServer: async () => {
      calls.push("build");
      return { ok: true };
    },
    fingerprints: async () => current,
    readRecord: async () => (options.build === "stale" || options.runtime === "stale" ? { ...record } : record),
    acquireReloadLock: () => (options.lock ? null : () => {}),
    writeRecord: async () => {
      calls.push("record");
    },
  };
  return { deps, calls, state: () => state };
}

test("/web reload stops the managed server, waits for it to go down, rebuilds when the build changed, then starts", async () => {
  const dir = await tree();
  try {
    const fake = fakeServer({ build: "stale", statePath: join(dir, "state.json") });
    const result = await reloadWebUi(fake.deps);
    assert.equal(result.status, "started");
    assert.match(result.message, /^pi-web reloaded\. pi-web started and serving/);
    assert.match(result.message, /built: sources changed since the last build/);
    assert.deepEqual(fake.calls, ["kill 1111", "removeState", "build", "spawn", "record"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a runtime-only change restarts the server without rebuilding (plugin edits are cheap)", async () => {
  const dir = await tree();
  try {
    const fake = fakeServer({ runtime: "stale", statePath: join(dir, "state.json") });
    const result = await reloadWebUiIfChanged(fake.deps);
    assert.equal(result.status, "started");
    assert.deepEqual(fake.calls, ["kill 1111", "removeState", "spawn", "record"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the automatic reload does nothing when nothing changed, nothing is running, or another reload holds the lock", async () => {
  const dir = await tree();
  try {
    const unchanged = fakeServer({ statePath: join(dir, "a.json") });
    assert.deepEqual(await reloadWebUiIfChanged(unchanged.deps), { status: "unchanged" });
    assert.deepEqual(unchanged.calls, []);

    const busy = fakeServer({ build: "stale", statePath: join(dir, "b.json"), lock: true });
    assert.deepEqual(await reloadWebUiIfChanged(busy.deps), { status: "busy" });
    assert.deepEqual(busy.calls, []);

    const idle = fakeServer({ build: "stale", statePath: join(dir, "c.json") });
    idle.deps.fetchHealth = async () => false;
    assert.deepEqual(await reloadWebUiIfChanged(idle.deps), { status: "idle" });
    assert.deepEqual(idle.calls, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/web reload force-kills an old server that ignores SIGTERM, then starts the new one", async () => {
  const dir = await tree();
  try {
    const fake = fakeServer({ statePath: join(dir, "state.json") });
    // SIGTERM is accepted but the server keeps running (open connections hold it, as Next does).
    fake.deps.killProcess = (pid) => fake.calls.push(`kill ${pid}`);
    fake.deps.stopGraceMs = 0;
    const messages: string[] = [];
    fake.deps.onProgress = (message) => messages.push(message);
    const result = await reloadWebUi(fake.deps);
    assert.equal(result.status, "started");
    assert.deepEqual(fake.calls, ["kill 1111", "removeState", "force kill 1111", "spawn", "record"]);
    assert.ok(messages.some((m) => m.includes("force-killing it")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/web reload refuses to start a second instance when the old one survives even SIGKILL", async () => {
  const dir = await tree();
  try {
    const fake = fakeServer({ statePath: join(dir, "state.json") });
    fake.deps.killProcess = (pid) => fake.calls.push(`kill ${pid}`);
    fake.deps.forceKillProcess = (pid) => fake.calls.push(`force kill ${pid}`);
    fake.deps.stopGraceMs = 0;
    const result = await reloadWebUi(fake.deps);
    assert.equal(result.status, "error");
    assert.match(result.message, /did not stop within 1s/);
    assert.equal(fake.calls.includes("spawn"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/web reload reports each phase in order, so a long reload is never silent", async () => {
  const dir = await tree();
  try {
    const fake = fakeServer({ build: "stale", statePath: join(dir, "state.json") });
    const messages: string[] = [];
    fake.deps.onProgress = (message) => messages.push(message);
    await reloadWebUi(fake.deps);
    assert.deepEqual(messages, [
      "Stopping pi-web (PID 1111)…",
      "pi-web is stopped; starting it again…",
      "Building pi-web production build (sources changed since the last build)…",
      "Build finished in 0s.",
      "Starting pi-web server…",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a slow start reports the health wait while it lasts", async () => {
  const dir = await tree();
  try {
    let starting = false;
    let polls = 0;
    const messages: string[] = [];
    const result = await startWebUi({
      statePath: join(dir, "state.json"),
      checkVendorDir: () => true,
      hasBuild: () => true,
      fingerprints: async () => ({ build: "b", runtime: "r" }),
      readRecord: async () => ({ build: "b", runtime: "r", builtAt: "t" }),
      readState: async () => null,
      fetchHealth: async () => starting && ++polls > 2,
      spawnServer: () => {
        starting = true;
        return { pid: 3333, unref: () => {} };
      },
      pollIntervalMs: 1,
      startupTimeoutMs: 1000,
      sleep: async () => {},
      onProgress: (message) => messages.push(message),
    });
    assert.equal(result.status, "started");
    assert.ok(messages.includes("Starting pi-web server…"));
    assert.ok(messages.includes("Waiting for pi-web to answer… 0s"), messages.join(" | "));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("elapsed time reads as seconds, then minutes and seconds", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(42_900), "42s");
  assert.equal(formatElapsed(125_000), "2m 05s");
  assert.equal(formatElapsed(-5), "0s");
});
