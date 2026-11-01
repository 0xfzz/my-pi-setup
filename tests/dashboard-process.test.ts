/**
 * Multi-process tests for the shared dashboard runtime.
 *
 * These tests spawn real Node processes (one detached server, several producer
 * fixtures) because the properties under test are cross-process: simultaneous
 * startup must converge on one server, a producer restarted by a server crash
 * must recover, and a replaced producer must stop rather than fight for the
 * session. Nothing here imports Pi; the fixtures use the same public producer
 * class a bridge would.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  ensureDashboard,
  readDashboardAddress,
  stopDashboard,
  stopDashboardByRuntimeDir,
  checkDashboardHealth,
  LOCK_FILE,
} from "../lib/dashboard/lifecycle.ts";
import type { DashboardAddress } from "../lib/dashboard/lifecycle.ts";
import { readRuntimeMetadata } from "../lib/dashboard/server.ts";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const tempDirs: string[] = [];
const children: ChildProcess[] = [];
const spawned: DashboardAddress[] = [];
let fixturePath = "";

async function tempDir(prefix = "pi-dash-proc-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

async function waitFor<T>(check: () => Promise<T | null | undefined | false>, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value as T;
    } catch (error) {
      last = error;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}${last === undefined ? "" : `: ${String(last)}`}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface FixtureEvent {
  event: string;
  sessionId?: string;
  url?: string;
  message?: string;
  pid?: number;
}

interface Fixture {
  child: ChildProcess;
  sessionId: string;
  events: FixtureEvent[];
  stderr(): string;
  waitForEvent(event: string, timeoutMs?: number): Promise<FixtureEvent>;
  waitForReadyCount(count: number, timeoutMs?: number): Promise<FixtureEvent>;
  kill(): Promise<void>;
}

before(async () => {
  fixturePath = join(await tempDir("pi-dash-fixture-"), "producer-fixture.mjs");
  const producerUrl = pathToFileURL(join(REPO_ROOT, "lib", "dashboard", "producer.ts")).href;
  await writeFile(
    fixturePath,
    `import { DashboardProducer } from ${JSON.stringify(producerUrl)};

const [runtimeDir, sessionId, mode] = process.argv.slice(2);
const emit = event => process.stdout.write(JSON.stringify({ ...event, sessionId }) + "\\n");
let revision = 0;
const snapshot = rev => ({
  session: { id: sessionId, name: sessionId + " rev " + rev, project: "proc-test", mode: "orchestrator" },
  delegation: {
    children: [{ id: "child-1", name: "worker", scope: "net-retry", status: "running", laneFiles: [], lastMilestoneFiles: [] }],
    handoffs: [], reviews: [], escalations: [], specReviews: [], paused: false,
  },
  artifacts: [],
});
const producer = new DashboardProducer({
  runtimeDir,
  heartbeatMs: 200,
  retryBaseMs: 100,
  retryMaxMs: 700,
  onReady: url => emit({ event: "ready", url }),
  onError: error => emit({ event: "error", message: String(error?.message ?? error) }),
});
let timer = null;
const publish = () => { revision += 1; producer.publish(snapshot(revision)); };
publish();
if (mode === "live") timer = setInterval(publish, 250);
// The producer deliberately unrefs its heartbeat so it never keeps a process
// alive; a real host (Pi) does that. The fixture needs its own keepalive so it
// stays up to receive SIGTERM and to prove heartbeats work across processes.
const keepAlive = setInterval(() => {}, 1_000);
const shutdown = async () => {
  clearInterval(keepAlive);
  if (timer) clearInterval(timer);
  try {
    await producer.close();
  } finally {
    emit({ event: "closed" });
    process.exit(0);
  }
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
emit({ event: "started", pid: process.pid });
`,
  );
});

after(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const address of spawned.splice(0)) {
    await stopDashboard(address, { timeoutMs: 2_000 }).catch(() => {});
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function spawnFixture(runtimeDir: string, sessionId: string, mode = "hold"): Promise<Fixture> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", fixturePath, runtimeDir, sessionId, mode], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const events: FixtureEvent[] = [];
  let stderrText = "";
  let buffer = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== "") {
        try {
          events.push(JSON.parse(line) as FixtureEvent);
        } catch {
          // Ignore non-JSON noise.
        }
      }
      index = buffer.indexOf("\n");
    }
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderrText += chunk;
  });

  const fixture: Fixture = {
    child,
    sessionId,
    events,
    stderr: () => stderrText,
    async waitForEvent(event: string, timeoutMs = 25_000): Promise<FixtureEvent> {
      return waitFor(
        async () => {
          const found = events.find(entry => entry.event === event);
          if (found) return found;
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(
              `fixture ${sessionId} exited (${String(child.exitCode ?? child.signalCode)}): ${stderrText} ${JSON.stringify(events)}`,
            );
          }
          return null;
        },
        `${sessionId} ${event}`,
        timeoutMs,
      );
    },
    async waitForReadyCount(count: number, timeoutMs = 30_000): Promise<FixtureEvent> {
      const ready = await waitFor(
        async () => {
          const found = events.filter(entry => entry.event === "ready");
          return found.length >= count ? found[count - 1]! : null;
        },
        `${sessionId} ready x${count}`,
        timeoutMs,
      );
      return ready;
    },
    async kill(): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) await sleep(50);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await new Promise<void>(resolveExit => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolveExit();
          return;
        }
        child.once("exit", () => resolveExit());
      });
    },
  };
  return fixture;
}

async function bootstrap(address: { browserUrl: string }): Promise<string> {
  const response = await fetch(address.browserUrl, { redirect: "manual" });
  assert.equal(response.status, 302, "bootstrap must mint a browser cookie");
  return response.headers.getSetCookie()[0]!.split(";")[0]!;
}

async function fetchSessions(address: DashboardAddress, cookie: string): Promise<any[]> {
  const response = await fetch(new URL("api/sessions", address.url), { headers: { cookie } });
  if (!response.ok) throw new Error(`sessions request failed: ${response.status}`);
  return ((await response.json()) as { sessions: any[] }).sessions;
}

async function waitForSessions(
  address: DashboardAddress,
  cookie: string,
  predicate: (sessions: any[]) => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<any[]> {
  return waitFor(async () => {
    const sessions = await fetchSessions(address, cookie);
    return predicate(sessions) ? sessions : null;
  }, label, timeoutMs);
}

async function waitForAddress(runtimeDir: string, timeoutMs = 25_000): Promise<DashboardAddress> {
  return waitFor(async () => readDashboardAddress(runtimeDir), "runtime metadata", timeoutMs);
}

/** Count live server-main processes whose argv names this runtime directory. */
async function serverProcessCount(runtimeDir: string): Promise<number> {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="]);
  return stdout
    .split("\n")
    .filter(line => line.includes("server-main.ts") && line.includes(runtimeDir))
    .length;
}

async function assertNoServerProcesses(runtimeDir: string): Promise<void> {
  await waitFor(async () => (await serverProcessCount(runtimeDir)) === 0, "server processes exit", 8_000);
}

test("separate producer processes share one server even when starting simultaneously", { timeout: 60_000 }, async () => {
  const runtimeDir = await tempDir();
  const fixtures = await Promise.all(
    ["proc-alpha", "proc-beta", "proc-gamma"].map(sessionId => spawnFixture(runtimeDir, sessionId, "hold")),
  );
  try {
    const ready = await Promise.all(fixtures.map(fixture => fixture.waitForEvent("ready")));
    const origins = new Set(ready.map(event => new URL(event.url!).origin));
    assert.equal(origins.size, 1, "all producers received the same server origin");
    assert.equal(await serverProcessCount(runtimeDir), 1, "exactly one server process exists for the directory");

    const address = await waitForAddress(runtimeDir);
    assert.equal(new URL(ready[0]!.url!).origin, new URL(address.url).origin);
    assert.equal(await checkDashboardHealth(address), true);

    const cookie = await bootstrap(address);
    const sessions = await waitForSessions(
      address,
      cookie,
      list => list.length === 3 && list.every(session => session.connected),
      "three registered sessions",
    );
    assert.deepEqual(
      new Set(sessions.map(session => session.id)),
      new Set(["proc-alpha", "proc-beta", "proc-gamma"]),
    );

    // Closing the first producer must not take the shared server down. A graceful
    // close (SIGTERM → producer.close() → unregister) retracts the session card;
    // its process is gone, so leaving it behind would read as work in flight.
    await fixtures[0]!.kill();
    const afterClose = await waitForSessions(
      address,
      cookie,
      list => list.length === 2 && !list.some(session => session.id === "proc-alpha"),
      "first producer removed after shutdown",
    );
    assert.equal(afterClose.filter(session => session.connected).length, 2);
    assert.equal((await readRuntimeMetadata(runtimeDir))?.instanceId, address.instanceId, "server identity unchanged");
    assert.equal(await serverProcessCount(runtimeDir), 1);
    assert.equal(await checkDashboardHealth(address), true);
  } finally {
    for (const fixture of fixtures) await fixture.kill();
    await stopDashboardByRuntimeDir(runtimeDir);
    await assertNoServerProcesses(runtimeDir);
  }
});

test("stale runtime metadata is replaced by a real server started by a producer", { timeout: 60_000 }, async () => {
  const runtimeDir = await tempDir();
  const fakeInstance = "f".repeat(32);
  await writeFile(
    join(runtimeDir, "server.json"),
    JSON.stringify({
      protocol: 1,
      instanceId: fakeInstance,
      pid: 999_999,
      host: "127.0.0.1",
      port: 1,
      url: "http://127.0.0.1:1/",
      browserUrl: "http://127.0.0.1:1/",
      startedAt: 0,
    }),
  );
  await writeFile(join(runtimeDir, "producer-token"), "a".repeat(64));
  // A foreign service occupies the default preferred port; it must not be adopted.
  const occupied = createNetServer(socket => socket.destroy());
  await new Promise<void>(resolveListen => occupied.listen(0, "127.0.0.1", resolveListen));
  const occupiedPort = (occupied.address() as AddressInfo).port;

  const fixture = await spawnFixture(runtimeDir, "proc-stale", "hold");
  try {
    await fixture.waitForEvent("ready");
    const address = await waitForAddress(runtimeDir);
    spawned.push(address);
    assert.notEqual(address.instanceId, fakeInstance);
    assert.notEqual(address.port, 1);
    assert.notEqual(address.port, occupiedPort);
    assert.equal(await checkDashboardHealth(address), true);
    const cookie = await bootstrap(address);
    await waitForSessions(address, cookie, list => list.some(session => session.id === "proc-stale"), "session registered");
    assert.equal(await serverProcessCount(runtimeDir), 1);
  } finally {
    await fixture.kill();
    await new Promise<void>(resolveClose => occupied.close(() => resolveClose()));
    await stopDashboardByRuntimeDir(runtimeDir);
    await assertNoServerProcesses(runtimeDir);
  }
});

test("a producer reconnects to a new server and re-reports a new URL after a server crash", { timeout: 90_000 }, async () => {
  const runtimeDir = await tempDir();
  const fixture = await spawnFixture(runtimeDir, "proc-recover", "live");
  try {
    const firstReady = await fixture.waitForEvent("ready");
    const firstAddress = await waitForAddress(runtimeDir);
    spawned.push(firstAddress);
    const firstCookie = await bootstrap(firstAddress);
    await waitForSessions(firstAddress, firstCookie, list => list.length === 1 && list[0].connected, "initial session");

    await stopDashboard(firstAddress, { timeoutMs: 4_000 });
    assert.equal(await checkDashboardHealth(firstAddress), false);

    // The producer's next heartbeat/publish fails, ensureDashboard respawns a
    // server under the same runtime directory, and a fresh bootstrap URL is emitted.
    const secondReady = await fixture.waitForReadyCount(2, 45_000);
    assert.notEqual(secondReady.url, firstReady.url, "bootstrap URL/token is rotated with the new server");
    const secondAddress = await waitForAddress(runtimeDir);
    spawned.push(secondAddress);
    assert.notEqual(secondAddress.instanceId, firstAddress.instanceId);
    assert.equal(await checkDashboardHealth(secondAddress), true);

    const secondCookie = await bootstrap(secondAddress);
    const [session] = await waitForSessions(
      secondAddress,
      secondCookie,
      list => list.length === 1 && list[0].connected && list[0].revision >= 2,
      "session recovered on the new server",
      30_000,
    );
    assert.equal(session!.id, "proc-recover");
    assert.match(session!.name, /rev \d+/);
    assert.equal(await serverProcessCount(runtimeDir), 1);
  } finally {
    await fixture.kill();
    await stopDashboardByRuntimeDir(runtimeDir);
    await assertNoServerProcesses(runtimeDir);
  }
});

test("a replacement producer takes over a session and the replaced one stops", { timeout: 60_000 }, async () => {
  const runtimeDir = await tempDir();
  const first = await spawnFixture(runtimeDir, "proc-replace", "hold");
  let second: Fixture | null = null;
  try {
    await first.waitForEvent("ready");
    const address = await waitForAddress(runtimeDir);
    spawned.push(address);
    const cookie = await bootstrap(address);
    await waitForSessions(address, cookie, list => list.length === 1 && list[0].connected, "first producer registered");

    // Spawn the replacement only after the first lease is established, so the
    // takeover direction is deterministic rather than a same-tick race.
    second = await spawnFixture(runtimeDir, "proc-replace", "hold");
    await second.waitForEvent("ready");
    await waitFor(
      async () => first.events.some(event => event.event === "error" && /superseded/.test(event.message ?? "")),
      "replaced producer reports superseded",
      20_000,
    );
    assert.equal(
      second.events.some(event => event.event === "error" && /superseded/.test(event.message ?? "")),
      false,
      "the replacing producer keeps the lease",
    );
    const sessions = await waitForSessions(
      address,
      cookie,
      list => list.length === 1 && list[0].connected,
      "replacement kept a single connected session",
    );
    assert.equal(sessions.length, 1);
    assert.equal(await serverProcessCount(runtimeDir), 1);
  } finally {
    await first.kill();
    if (second !== null) await second.kill();
    await stopDashboardByRuntimeDir(runtimeDir);
    await assertNoServerProcesses(runtimeDir);
  }
});

test("a fresh empty lock plus simultaneous separate starters still yields one server", { timeout: 60_000 }, async () => {
  const runtimeDir = await tempDir();
  // The exact race the fs lock must not lose: a competitor can observe a
  // just-created (empty, not-yet-written) lock. The fresh-lock grace plus the
  // OS singleton must still converge on exactly one server.
  await writeFile(join(runtimeDir, LOCK_FILE), "");
  const fixtures = await Promise.all(
    ["lock-alpha", "lock-beta", "lock-gamma", "lock-delta"].map(sessionId =>
      spawnFixture(runtimeDir, sessionId, "hold"),
    ),
  );
  try {
    const ready = await Promise.all(fixtures.map(fixture => fixture.waitForEvent("ready", 30_000)));
    assert.equal(new Set(ready.map(event => new URL(event.url!).origin)).size, 1);
    assert.equal(await serverProcessCount(runtimeDir), 1);
    const address = await waitForAddress(runtimeDir);
    assert.equal(await checkDashboardHealth(address), true);
    const cookie = await bootstrap(address);
    await waitForSessions(
      address,
      cookie,
      list => list.length === 4 && list.every(session => session.connected),
      "all four starters registered on the single server",
    );
  } finally {
    for (const fixture of fixtures) await fixture.kill();
    await stopDashboardByRuntimeDir(runtimeDir);
    await assertNoServerProcesses(runtimeDir);
  }
});

test("an idle server exits and a later ensure starts a fresh instance", { timeout: 45_000 }, async () => {
  const runtimeDir = await tempDir();
  const first = await ensureDashboard({ runtimeDir, preferredPort: 0, idleMs: 250 });
  spawned.push(first);
  await waitFor(async () => (await readRuntimeMetadata(runtimeDir)) === null, "idle exit removes metadata", 10_000);
  await waitFor(async () => !isProcessAlive(first.pid), "idle server process exits", 10_000);

  const second = await ensureDashboard({ runtimeDir, preferredPort: 0, idleMs: 0 });
  spawned.push(second);
  assert.notEqual(second.instanceId, first.instanceId);
  assert.equal(await checkDashboardHealth(second), true);
  await stopDashboard(second);
  await assertNoServerProcesses(runtimeDir);
});
