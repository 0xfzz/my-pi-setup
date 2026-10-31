import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLandlockBinary, planLandlock } from "../lib/scope/sandbox/landlock.ts";
import { clearProbeCache, probeBackend } from "../lib/scope/sandbox/probe.ts";
import { wrapBashCommand } from "../lib/scope/sandbox/wrap.ts";
import type { SandboxPolicy } from "../lib/scope/sandbox/policy.ts";

const execFileAsync = promisify(execFile);

test("findLandlockBinary locates the compiled helper binary", () => {
  const binary = findLandlockBinary();
  assert.ok(binary, "binary path must be found");
});

test("planLandlock produces valid argv with rw roots, chdir, and target command", () => {
  const policy: SandboxPolicy = {
    cwd: "/tmp",
    mode: "workspace",
    writable: ["/tmp", "/dev/null"],
    deny: [],
    scratchDir: "/tmp/scratch",
  };

  const planned = planLandlock(policy, "echo hello", { TEST: "1" });
  assert.ok("argv" in planned);
  const argv = planned.argv;

  assert.ok(argv[0]?.includes("nowrite-guard"));
  assert.ok(argv.includes("--chdir"));
  assert.ok(argv.includes("/tmp"));
  assert.ok(argv.includes("--rw"));

  // Must end with: -- /usr/bin/env TEST=1 /bin/sh -c 'echo hello'
  const envIdx = argv.indexOf("/usr/bin/env");
  assert.ok(envIdx > 0, "env scrub rides the payload via /usr/bin/env");
  assert.equal(argv[envIdx + 1], "TEST=1");
  assert.equal(argv[argv.length - 3], "/bin/sh");
  assert.equal(argv[argv.length - 2], "-c");
  assert.equal(argv[argv.length - 1], "echo hello");
  assert.equal(argv[argv.length - 4], "TEST=1");

  // No env, no /usr/bin/env hop: the payload stays minimal.
  const bare = planLandlock(policy, "echo hello");
  assert.ok("argv" in bare);
  assert.equal(bare.argv[bare.argv.length - 3], "/bin/sh");
  assert.ok(!bare.argv.includes("/usr/bin/env"));
});

test("probeBackend probes Landlock and detects functional ABI on Linux", async () => {
  if (process.platform !== "linux") return;
  clearProbeCache();

  const probe = await probeBackend("landlock");
  assert.equal(probe.ok, true, `Landlock probe failed: ${probe.detail}`);
  assert.equal(probe.backend, "landlock");
  assert.ok(typeof probe.abi === "number" && probe.abi >= 1, `expected ABI >= 1, got ${probe.abi}`);
});

test("nowrite-guard enforces write restrictions at kernel level", async () => {
  if (process.platform !== "linux") return;
  const dir = await mkdtemp(join(tmpdir(), "landlock-test-"));
  const allowedDir = join(dir, "allowed");
  const outsideDir = join(dir, "outside");
  await mkdir(allowedDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });

  try {
    const policy: SandboxPolicy = {
      cwd: dir,
      mode: "workspace",
      writable: [allowedDir, "/dev/null", "/dev/zero"],
      deny: [],
    };

    const wrapped = wrapBashCommand(`touch ${allowedDir}/file.txt`, policy, "landlock");
    assert.ok("argv" in wrapped);

    // Running the command in the allowed directory succeeds
    await execFileAsync(wrapped.argv[0]!, wrapped.argv.slice(1));

    // Running a write command to outside directory fails with EACCES / Permission denied
    const deniedCmd = wrapBashCommand(`touch ${outsideDir}/file.txt`, policy, "landlock");
    assert.ok("argv" in deniedCmd);

    await assert.rejects(
      async () => execFileAsync(deniedCmd.argv[0]!, deniedCmd.argv.slice(1)),
      (err: any) => {
        const stderr = String(err?.stderr ?? err?.message);
        return /Permission denied/i.test(stderr);
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
