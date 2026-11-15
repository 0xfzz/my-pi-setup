// The server as the OS sees it: one process, one orderly exit.
//
// The failure this pins is the one that leaves a machine dirty — a SIGTERM that
// never finishes, so the supervisor escalates to SIGKILL and everything the host
// still tracked (a plugin's child, an in-flight write) is left behind. The state
// file is the witness: a clean exit must leave no pending start recorded, or the
// next boot counts a crash it did not have and can boot the kernel into safe
// mode.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SERVER_ENTRY = join(REPO_ROOT, "web", "server.ts");
/** Boot + teardown must fit well inside this; the test fails rather than hangs. */
const BOOT_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 10_000;

interface RunningServer {
  child: ReturnType<typeof spawn>;
  output(): string;
}

function startServer(statePath: string): RunningServer {
  let output = "";
  const child = spawn(process.execPath, ["--experimental-strip-types", SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: { ...process.env, PI_WEB_PORT: "0", PI_WEB_PLUGIN_STATE: statePath, NODE_TEST_CONTEXT: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  return { child, output: () => output };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

test("SIGTERM exits within the teardown budget and records a clean shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "web-server-lifecycle-"));
  const statePath = join(dir, "web-plugins.json");
  const server = startServer(statePath);
  try {
    await waitFor(() => server.output().includes("listening on"), BOOT_TIMEOUT_MS, "the server to boot");
    assert.equal(server.child.pid !== undefined, true);

    const started = Date.now();
    server.child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolveExit) => {
      server.child.once("exit", (exitCode) => resolveExit(exitCode));
    });
    const elapsed = Date.now() - started;

    assert.equal(code, 0, `a deliberate stop is a success exit, got ${String(code)}: ${server.output()}`);
    assert.ok(elapsed < EXIT_TIMEOUT_MS, `teardown took ${elapsed} ms, past the budget`);
    assert.match(server.output(), /stopped \(SIGTERM\)/);
    // No pending start is recorded, so the crash-loop guard does not see this
    // restart as a crash and the next boot starts normally.
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { boots?: unknown[] };
    assert.deepEqual(state.boots ?? [], [], "a clean shutdown must leave no boot pending");
  } finally {
    server.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the server leaves no child process behind on a clean stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "web-server-lifecycle-"));
  const statePath = join(dir, "web-plugins.json");
  const server = startServer(statePath);
  const pid = server.child.pid;
  try {
    await waitFor(() => server.output().includes("listening on"), BOOT_TIMEOUT_MS, "the server to boot");
    server.child.kill("SIGTERM");
    await new Promise<void>((resolveExit) => {
      server.child.once("exit", () => resolveExit());
    });
    assert.ok(pid !== undefined);
    assert.throws(() => process.kill(pid, 0), "the server process must be gone, not a zombie the OS still sees");
  } finally {
    server.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
