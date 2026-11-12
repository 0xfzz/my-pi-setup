import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decideStart,
  decideStop,
  decideStatus,
  defaultReadState,
  defaultWriteState,
  defaultRemoveState,
  startWebUi,
  stopWebUi,
  statusWebUi,
  DEFAULT_WEB_UI_PORT,
  DEFAULT_WEB_UI_URL,
  DEFAULT_PKILL_COMMAND,
  serverSpawnArgs,
  type WebUiState,
  type WebUiDeps,
} from "../lib/web-ui.ts";
import webExtension from "../extensions/web.ts";

async function createTempDir(prefix = "pi-web-ui-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

test("decideStart: pure decision matrix", () => {
  const validState: WebUiState = {
    pid: 12345,
    port: 30142,
    url: "http://127.0.0.1:30142",
    startedBy: "sess-1",
    startedAt: "2026-11-05T00:00:00.000Z",
  };

  // 1. Healthy + valid state -> deny_running
  assert.deepEqual(decideStart(validState, true), {
    action: "deny_running",
    state: validState,
  });

  // 2. Healthy + no state -> deny_unmanaged
  assert.deepEqual(decideStart(null, true), {
    action: "deny_unmanaged",
  });

  // 3. Healthy + corrupt state -> deny_unmanaged
  assert.deepEqual(decideStart("corrupt", true), {
    action: "deny_unmanaged",
  });

  // 4. Unhealthy + valid state -> take_over_stale
  assert.deepEqual(decideStart(validState, false), {
    action: "take_over_stale",
    state: validState,
  });

  // 5. Unhealthy + corrupt state -> take_over_stale
  assert.deepEqual(decideStart("corrupt", false), {
    action: "take_over_stale",
    state: "corrupt",
  });

  // 6. Unhealthy + no state -> start
  assert.deepEqual(decideStart(null, false), {
    action: "start",
  });
});

test("decideStop: pure decision matrix", () => {
  const validState: WebUiState = {
    pid: 12345,
    port: 30142,
    url: "http://127.0.0.1:30142",
    startedBy: "sess-1",
    startedAt: "2026-11-05T00:00:00.000Z",
  };

  // 1. State with live PID -> kill
  assert.deepEqual(decideStop(validState, true, (pid) => pid === 12345), {
    action: "kill",
    pid: 12345,
  });
  assert.deepEqual(decideStop(validState, false, (pid) => pid === 12345), {
    action: "kill",
    pid: 12345,
  });

  // 2. State with dead PID + healthy server -> unmanaged_running
  assert.deepEqual(decideStop(validState, true, () => false), {
    action: "unmanaged_running",
  });

  // 3. State with dead PID + unhealthy server -> not_running with cleanStaleState: true
  assert.deepEqual(decideStop(validState, false, () => false), {
    action: "not_running",
    cleanStaleState: true,
  });

  // 4. Corrupt state + healthy -> unmanaged_running
  assert.deepEqual(decideStop("corrupt", true, () => false), {
    action: "unmanaged_running",
  });

  // 5. Corrupt state + unhealthy -> not_running with cleanStaleState: true
  assert.deepEqual(decideStop("corrupt", false, () => false), {
    action: "not_running",
    cleanStaleState: true,
  });

  // 6. No state + healthy -> unmanaged_running
  assert.deepEqual(decideStop(null, true, () => false), {
    action: "unmanaged_running",
  });

  // 7. No state + unhealthy -> not_running with cleanStaleState: false
  assert.deepEqual(decideStop(null, false, () => false), {
    action: "not_running",
    cleanStaleState: false,
  });
});

test("decideStatus: pure report generation", () => {
  const validState: WebUiState = {
    pid: 12345,
    port: 30142,
    url: "http://127.0.0.1:30142",
    startedBy: "sess-1",
    startedAt: "2026-11-05T00:00:00.000Z",
  };

  // Healthy + live PID -> matching reality
  const r1 = decideStatus(validState, true, () => true);
  assert.equal(r1.serving, true);
  assert.equal(r1.matchesReality, true);
  assert.equal(r1.owner, "sess-1");
  assert.equal(r1.pid, 12345);
  assert.match(r1.message, /State matches reality: yes/);

  // Healthy + dead PID -> not matching reality
  const r2 = decideStatus(validState, true, () => false);
  assert.equal(r2.serving, true);
  assert.equal(r2.matchesReality, false);
  assert.match(r2.message, /PID in state file \(12345\) is not running/);

  // Healthy + no state file -> unmanaged
  const r3 = decideStatus(null, true, () => false);
  assert.equal(r3.serving, true);
  assert.equal(r3.matchesReality, false);
  assert.equal(r3.unmanaged, true);
  assert.match(r3.message, /unmanaged/);

  // Unhealthy + stale state file
  const r4 = decideStatus(validState, false, () => false);
  assert.equal(r4.serving, false);
  assert.equal(r4.matchesReality, false);
  assert.match(r4.message, /Stale state file exists/);

  // Unhealthy + no state file
  const r5 = decideStatus(null, false, () => false);
  assert.equal(r5.serving, false);
  assert.equal(r5.matchesReality, true);
  assert.match(r5.message, /State matches reality: yes/);
});

test("default disk IO: readState, writeState, removeState roundtrip in temporary directory", async () => {
  const tmp = await createTempDir();
  try {
    const statePath = join(tmp, "web-ui-state.json");

    // Initially missing -> null
    assert.equal(await defaultReadState(statePath), null);

    // Write valid state
    const valid: WebUiState = {
      pid: 2468,
      port: DEFAULT_WEB_UI_PORT,
      url: DEFAULT_WEB_UI_URL,
      startedBy: "test-session",
      startedAt: "2026-11-05T00:00:00.000Z",
    };
    await defaultWriteState(statePath, valid);

    // Read back
    const read = await defaultReadState(statePath);
    assert.deepEqual(read, valid);

    // Corrupt JSON
    await writeFile(statePath, "{ broken json", "utf8");
    assert.equal(await defaultReadState(statePath), "corrupt");

    // Partial JSON missing pid
    await writeFile(statePath, JSON.stringify({ port: 30142, url: "http://..." }), "utf8");
    assert.equal(await defaultReadState(statePath), "corrupt");

    // Remove state
    await defaultRemoveState(statePath);
    assert.equal(await defaultReadState(statePath), null);

    // Removing non-existent does not throw
    await assert.doesNotReject(defaultRemoveState(statePath));
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("/web start: denies with owner info when already serving and state file is present", async () => {
  const tmp = await createTempDir();
  try {
    const statePath = join(tmp, "state.json");
    let spawned = false;

    const existingState: WebUiState = {
      pid: 9876,
      port: 30142,
      url: "http://127.0.0.1:30142",
      startedBy: "owner-session-42",
      startedAt: "2026-11-05T00:00:00.000Z",
    };
    await defaultWriteState(statePath, existingState);

    const result = await startWebUi({
      statePath,
      fetchHealth: async () => true,
      spawnServer: () => {
        spawned = true;
        return { pid: 9999 };
      },
    });

    assert.equal(result.status, "denied");
    assert.match(result.message, /already serving at http:\/\/127\.0\.0\.1:30142/);
    assert.match(result.message, /owner-session-42/);
    assert.match(result.message, /2026-11-05T00:00:00\.000Z/);
    assert.match(result.message, /No new instance was started/);
    assert.equal(spawned, false, "Must not spawn when instance is already serving");
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("/web start: denies as unmanaged instance when serving but no state file exists", async () => {
  const tmp = await createTempDir();
  try {
    const statePath = join(tmp, "state.json");
    let spawned = false;

    const result = await startWebUi({
      statePath,
      fetchHealth: async () => true,
      spawnServer: () => {
        spawned = true;
        return { pid: 9999 };
      },
    });

    assert.equal(result.status, "denied");
    assert.match(result.message, /unmanaged instance/);
    assert.match(result.message, /cannot attribute an owner/);
    assert.match(result.message, /No new instance was started/);
    assert.equal(spawned, false, "Must not spawn when unmanaged instance is already serving");
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("/web start: denies as unmanaged instance when serving but state file is corrupt", async () => {
  const tmp = await createTempDir();
  try {
    const statePath = join(tmp, "state.json");
    await writeFile(statePath, "{ broken json", "utf8");
    let spawned = false;

    const result = await startWebUi({
      statePath,
      fetchHealth: async () => true,
      spawnServer: () => {
        spawned = true;
        return { pid: 9999 };
      },
    });

    assert.equal(result.status, "denied");
    assert.match(result.message, /unmanaged instance/);
    assert.equal(spawned, false);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("/web start: takes over stale state when health check fails and spawns fresh instance", async () => {
  const tmp = await createTempDir();
  try {
    const statePath = join(tmp, "state.json");
    const staleState: WebUiState = {
      pid: 1111,
      port: 30142,
      url: "http://127.0.0.1:30142",
      startedBy: "dead-session",
      startedAt: "2026-11-04T00:00:00.000Z",
    };
    await defaultWriteState(statePath, staleState);

    let spawnedPid: number | undefined;
    let healthCallCount = 0;

    const result = await startWebUi({
      statePath,
      sessionId: "new-session",
      checkServerDir: () => true,
      hasBuild: () => true,
      // The build is current: its record matches the sources, so the start must not rebuild.
      fingerprints: async () => ({ build: "b", runtime: "r" }),
      readRecord: async () => ({ build: "b", runtime: "r", builtAt: "t" }),
      fetchHealth: async () => {
        healthCallCount++;
        // 1st call before spawn: unhealthy
        // 2nd call during poll: healthy
        return healthCallCount > 1;
      },
      spawnServer: () => {
        spawnedPid = 2222;
        return { pid: 2222, unref: () => {} };
      },
      pollIntervalMs: 1,
      startupTimeoutMs: 1000,
      sleep: async () => {},
    });

    assert.equal(result.status, "started");
    assert.equal(spawnedPid, 2222);

    // State on disk was replaced with the new session
    const updated = await defaultReadState(statePath);
    assert.ok(updated && typeof updated === "object");
    assert.equal(updated.pid, 2222);
    assert.equal(updated.startedBy, "new-session");
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("/web start: successful start writes state file and reports URL", async () => {
  const tmp = await createTempDir();
  try {
    const statePath = join(tmp, "state.json");
    let healthCallCount = 0;

    const result = await startWebUi({
      statePath,
      sessionId: "my-session-id",
      checkServerDir: () => true,
      hasBuild: () => true,
      // The build is current: its record matches the sources, so the start must not rebuild.
      fingerprints: async () => ({ build: "b", runtime: "r" }),
      readRecord: async () => ({ build: "b", runtime: "r", builtAt: "t" }),
      fetchHealth: async () => {
        healthCallCount++;
        return healthCallCount > 1;
      },
      spawnServer: () => ({ pid: 7777, unref: () => {} }),
      pollIntervalMs: 1,
      startupTimeoutMs: 1000,
      sleep: async () => {},
    });

    assert.equal(result.status, "started");
    assert.match(result.message, /pi-web started and serving at http:\/\/127\.0\.0\.1:30142/);

    const saved = await defaultReadState(statePath);
    assert.ok(saved && typeof saved === "object");
    assert.equal(saved.pid, 7777);
    assert.equal(saved.port, DEFAULT_WEB_UI_PORT);
    assert.equal(saved.startedBy, "my-session-id");
    assert.ok(saved.startedAt.length > 0);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("/web start: timeout kills spawned process and cleans up state", async () => {
  const tmp = await createTempDir();
  try {
    const statePath = join(tmp, "state.json");
    let killedPid: number | undefined;

    let currentTime = 1000;
    const result = await startWebUi({
      statePath,
      checkServerDir: () => true,
      hasBuild: () => true,
      // The build is current: its record matches the sources, so the start must not rebuild.
      fingerprints: async () => ({ build: "b", runtime: "r" }),
      readRecord: async () => ({ build: "b", runtime: "r", builtAt: "t" }),
      fetchHealth: async () => false, // never becomes healthy
      spawnServer: () => ({ pid: 8888, unref: () => {} }),
      killProcess: (pid) => {
        killedPid = pid;
      },
      now: () => currentTime,
      sleep: async () => {
        currentTime += 600; // advance past 500ms timeout
      },
      pollIntervalMs: 100,
      startupTimeoutMs: 500,
    });

    assert.equal(result.status, "error");
    assert.match(result.message, /failed to become healthy/);
    assert.equal(killedPid, 8888, "Must kill the spawned PID on timeout");
    assert.equal(await defaultReadState(statePath), null, "State file must not be left behind on timeout");
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("/web start: fails early when the web package directory is missing", async () => {
  const tmp = await createTempDir();
  try {
    const statePath = join(tmp, "state.json");
    let spawned = false;

    const result = await startWebUi({
      statePath,
      checkServerDir: () => false,
      fetchHealth: async () => false,
      spawnServer: () => {
        spawned = true;
        return { pid: 1234 };
      },
    });

    assert.equal(result.status, "error");
    assert.match(result.message, /server package not found/);
    assert.equal(spawned, false, "Must not attempt spawn when the server directory is missing");
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("/web stop: stops managed instance with live PID and removes state file", async () => {
  const tmp = await createTempDir();
  try {
    const statePath = join(tmp, "state.json");
    let killedPid: number | undefined;

    await defaultWriteState(statePath, {
      pid: 4321,
      port: 30142,
      url: "http://127.0.0.1:30142",
      startedBy: "session-x",
      startedAt: "2026-11-05T00:00:00.000Z",
    });

    const result = await stopWebUi({
      statePath,
      isPidAlive: (pid) => pid === 4321,
      killProcess: (pid) => {
        killedPid = pid;
      },
      fetchHealth: async () => true,
    });

    assert.equal(result.status, "stopped");
    assert.match(result.message, /pi-web \(PID 4321\) stopped/);
    assert.equal(killedPid, 4321);
    assert.equal(await defaultReadState(statePath), null, "State file must be deleted");
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("/web stop: unmanaged instance returns instructions with pkill command", async () => {
  const tmp = await createTempDir();
  try {
    const statePath = join(tmp, "state.json");

    // Case 1: no state file, but server healthy
    const r1 = await stopWebUi({
      statePath,
      fetchHealth: async () => true,
    });
    assert.equal(r1.status, "info");
    assert.match(r1.message, /unmanaged instance/);
    assert.match(r1.message, new RegExp(DEFAULT_PKILL_COMMAND.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")));

    // Case 2: state file has dead PID, but server is still healthy
    await defaultWriteState(statePath, {
      pid: 9999,
      port: 30142,
      url: "http://127.0.0.1:30142",
      startedBy: "dead",
      startedAt: "2026-11-05T00:00:00.000Z",
    });

    const r2 = await stopWebUi({
      statePath,
      isPidAlive: () => false,
      fetchHealth: async () => true,
    });
    assert.equal(r2.status, "info");
    assert.match(r2.message, /unmanaged instance/);
    assert.equal(await defaultReadState(statePath), null, "Dead state file was cleaned up");
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("/web stop: reports not running when not serving", async () => {
  const tmp = await createTempDir();
  try {
    const statePath = join(tmp, "state.json");

    // Case 1: no state file, not healthy
    const r1 = await stopWebUi({
      statePath,
      fetchHealth: async () => false,
    });
    assert.equal(r1.status, "info");
    assert.match(r1.message, /pi-web is not running/);

    // Case 2: stale state file, not healthy -> cleans up stale state and reports not running
    await defaultWriteState(statePath, {
      pid: 9999,
      port: 30142,
      url: "http://127.0.0.1:30142",
      startedBy: "stale",
      startedAt: "2026-11-05T00:00:00.000Z",
    });

    const r2 = await stopWebUi({
      statePath,
      isPidAlive: () => false,
      fetchHealth: async () => false,
    });
    assert.equal(r2.status, "info");
    assert.match(r2.message, /pi-web is not running/);
    assert.equal(await defaultReadState(statePath), null);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("/web status: reports state accuracy and ownership", async () => {
  const tmp = await createTempDir();
  try {
    const statePath = join(tmp, "state.json");

    // 1. Serving and managed
    await defaultWriteState(statePath, {
      pid: 3333,
      port: 30142,
      url: "http://127.0.0.1:30142",
      startedBy: "status-sess",
      startedAt: "2026-11-05T00:00:00.000Z",
    });

    const s1 = await statusWebUi({
      statePath,
      isPidAlive: (pid) => pid === 3333,
      fetchHealth: async () => true,
    });
    assert.match(s1.message, /pi-web is serving at http:\/\/127\.0\.0\.1:30142/);
    assert.match(s1.message, /PID: 3333/);
    assert.match(s1.message, /Started by: status-sess/);
    assert.match(s1.message, /State matches reality: yes/);

    // 2. Not serving, stale state file
    const s2 = await statusWebUi({
      statePath,
      isPidAlive: () => false,
      fetchHealth: async () => false,
    });
    assert.match(s2.message, /pi-web is not serving/);
    assert.match(s2.message, /Stale state file exists/);
    assert.match(s2.message, /State matches reality: no/);

    // 3. Not serving, clean
    await defaultRemoveState(statePath);
    const s3 = await statusWebUi({
      statePath,
      fetchHealth: async () => false,
    });
    assert.match(s3.message, /pi-web is not serving/);
    assert.match(s3.message, /State matches reality: yes/);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("webExtension: command registration, subcommands, and notifications", async () => {
  let registeredCommandName = "";
  let commandDescriptor: any = null;

  const mockPi: any = {
    registerCommand(name: string, desc: any) {
      registeredCommandName = name;
      commandDescriptor = desc;
    },
    // The extension subscribes to session events for the source watcher.
    on: () => undefined,
  };

  const notifications: Array<{ message: string; level: string }> = [];
  const mockCtx: any = {
    sessionManager: {
      getSessionId: () => "mock-sess-id",
    },
    ui: {
      notify(msg: string, level: string) {
        notifications.push({ message: msg, level });
      },
    },
  };

  const testDeps: Partial<WebUiDeps> = {
    fetchHealth: async () => true,
    readState: async () => ({
      pid: 1111,
      port: 30142,
      url: "http://127.0.0.1:30142",
      startedBy: "mock-sess-id",
      startedAt: "2026-11-05T00:00:00.000Z",
    }),
    isPidAlive: () => true,
    killProcess: () => {},
    removeState: async () => {},
  };

  webExtension(mockPi, { deps: testDeps });

  assert.equal(registeredCommandName, "web");
  assert.ok(commandDescriptor);

  // Completions
  const completions = commandDescriptor.getArgumentCompletions("st");
  assert.deepEqual(
    completions.map((c: any) => c.value),
    ["start", "stop", "status"],
  );

  // /web start (denied since healthy + state)
  notifications.length = 0;
  await commandDescriptor.handler("start", mockCtx);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.level, "warning");
  assert.match(notifications[0]?.message ?? "", /already serving/);

  // /web status
  notifications.length = 0;
  await commandDescriptor.handler("status", mockCtx);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.level, "info");
  assert.match(notifications[0]?.message ?? "", /pi-web is serving/);

  // /web stop
  notifications.length = 0;
  await commandDescriptor.handler("stop", mockCtx);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.level, "info");
  assert.match(notifications[0]?.message ?? "", /stopped/);

  // /web unknown
  notifications.length = 0;
  await commandDescriptor.handler("invalid-cmd", mockCtx);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.level, "warning");
  assert.match(notifications[0]?.message ?? "", /Unknown subcommand/);
});

test("serverSpawnArgs: runs the minimal server directly, never a dev watcher", () => {
  const args = serverSpawnArgs();
  assert.deepEqual(args, ["--experimental-strip-types", "core/server/main.ts"]);
  assert.ok(!args.includes("dev"), "dev mode must never be used by /web start");
  assert.ok(!args.includes("build"), "build is a separate step, not a server flag");
});

test("/web start: builds when no production build exists, then serves it", async () => {
  const tmp = await createTempDir();
  try {
    const statePath = join(tmp, "state.json");
    const calls: string[] = [];
    let healthCallCount = 0;

    const result = await startWebUi({
      statePath,
      checkServerDir: () => true,
      hasBuild: () => false,
      buildServer: async () => {
        calls.push("build");
        return { ok: true };
      },
      fetchHealth: async () => {
        healthCallCount++;
        return healthCallCount > 1;
      },
      spawnServer: () => {
        calls.push("spawn");
        return { pid: 5555, unref: () => {} };
      },
      pollIntervalMs: 1,
      startupTimeoutMs: 1000,
      sleep: async () => {},
    });

    assert.equal(result.status, "started");
    assert.deepEqual(calls, ["build", "spawn"], "build must finish before the server starts");
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("/web start: an existing build is served without rebuilding", async () => {
  const tmp = await createTempDir();
  try {
    const statePath = join(tmp, "state.json");
    let builds = 0;
    let healthCallCount = 0;

    const result = await startWebUi({
      statePath,
      checkServerDir: () => true,
      hasBuild: () => true,
      // The build is current: its record matches the sources, so the start must not rebuild.
      fingerprints: async () => ({ build: "b", runtime: "r" }),
      readRecord: async () => ({ build: "b", runtime: "r", builtAt: "t" }),
      buildServer: async () => {
        builds++;
        return { ok: true };
      },
      fetchHealth: async () => {
        healthCallCount++;
        return healthCallCount > 1;
      },
      spawnServer: () => ({ pid: 6666, unref: () => {} }),
      pollIntervalMs: 1,
      startupTimeoutMs: 1000,
      sleep: async () => {},
    });

    assert.equal(result.status, "started");
    assert.equal(builds, 0, "an up-to-date build must not be rebuilt on every start");
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("/web start: a failed build reports the error and starts nothing", async () => {
  const tmp = await createTempDir();
  try {
    const statePath = join(tmp, "state.json");
    let spawned = false;

    const result = await startWebUi({
      statePath,
      checkServerDir: () => true,
      hasBuild: () => false,
      buildServer: async () => ({ ok: false, error: "exit 1: Type error in components/plugins/SlotHost.tsx" }),
      fetchHealth: async () => false,
      spawnServer: () => {
        spawned = true;
        return { pid: 7777 };
      },
    });

    assert.equal(result.status, "error");
    assert.match(result.message, /production build failed/);
    assert.match(result.message, /Type error in components\/plugins\/SlotHost\.tsx/);
    assert.match(result.message, /No server was started/);
    assert.equal(spawned, false, "a failed build must not leave a server half-started");
    assert.equal(await defaultReadState(statePath), null, "no state file may be written");
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("/web start: rebuild forces a build even when output exists", async () => {
  const tmp = await createTempDir();
  try {
    const statePath = join(tmp, "state.json");
    let builds = 0;
    let healthCallCount = 0;

    const result = await startWebUi({
      statePath,
      checkServerDir: () => true,
      hasBuild: () => true,
      // The build is current: its record matches the sources, so the start must not rebuild.
      fingerprints: async () => ({ build: "b", runtime: "r" }),
      readRecord: async () => ({ build: "b", runtime: "r", builtAt: "t" }),
      rebuild: true,
      buildServer: async () => {
        builds++;
        return { ok: true };
      },
      fetchHealth: async () => {
        healthCallCount++;
        return healthCallCount > 1;
      },
      spawnServer: () => ({ pid: 8889, unref: () => {} }),
      pollIntervalMs: 1,
      startupTimeoutMs: 1000,
      sleep: async () => {},
    });

    assert.equal(result.status, "started");
    assert.equal(builds, 1, "--rebuild must rebuild even when a build marker exists");
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});
