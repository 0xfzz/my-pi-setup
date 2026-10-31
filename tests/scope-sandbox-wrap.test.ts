import assert from "node:assert/strict";
import { test } from "node:test";
import { planBwrap } from "../lib/scope/sandbox/bwrap.ts";
import { clearProbeCache, probeBackend } from "../lib/scope/sandbox/probe.ts";
import { planSeatbelt } from "../lib/scope/sandbox/seatbelt.ts";
import { quoteArg, wrapBashCommand } from "../lib/scope/sandbox/wrap.ts";
import type { SandboxPolicy } from "../lib/scope/sandbox/policy.ts";

test("planBwrap enforces invariants: no unshare-pid/net/new-session and correct mount order", () => {
  const policy: SandboxPolicy = {
    cwd: "/work/project",
    mode: "workspace",
    writable: ["/work/project", "/custom/dir"],
    deny: ["/work/project/secret"],
    scratchDir: "/tmp/scratch-1",
  };

  const planned = planBwrap(policy, "ls -la", { FOO: "bar" });
  assert.ok("argv" in planned);
  const argv = planned.argv;

  assert.equal(argv[0], "bwrap");
  // Crucial invariants:
  assert.ok(!argv.includes("--unshare-pid"), "must NOT unshare pid namespace");
  assert.ok(!argv.includes("--unshare-net"), "must NOT unshare network namespace");
  assert.ok(!argv.includes("--new-session"), "must NOT create new session");

  // Mount order: ro-bind / / comes before dev-bind /dev /dev
  const roIdx = argv.indexOf("--ro-bind");
  const devIdx = argv.indexOf("--dev-bind");
  assert.ok(roIdx >= 0 && devIdx >= 0 && roIdx < devIdx, "--ro-bind must precede --dev-bind");

  assert.ok(argv.includes("--proc"));
  assert.ok(argv.includes("--cap-drop"));
  assert.ok(argv.includes("--die-with-parent"));

  // Check env passthrough
  const setenvIdx = argv.indexOf("--setenv");
  assert.ok(setenvIdx >= 0);
  assert.equal(argv[setenvIdx + 1], "FOO");
  assert.equal(argv[setenvIdx + 2], "bar");

  // Check trailer: -- /bin/sh -c <command>
  assert.equal(argv[argv.length - 4], "--");
  assert.equal(argv[argv.length - 3], "/bin/sh");
  assert.equal(argv[argv.length - 2], "-c");
  assert.equal(argv[argv.length - 1], "ls -la");
});

test("planSeatbelt generates macOS profile with default allow and write restrictions", () => {
  const policy: SandboxPolicy = {
    cwd: "/work/project",
    mode: "workspace",
    writable: ["/work/project", "/custom/dir"],
    deny: ["/work/project/secret"],
    scratchDir: "/tmp/scratch-seatbelt",
  };

  const planned = planSeatbelt(policy, "git status");
  assert.ok("argv" in planned);
  const argv = planned.argv;

  assert.equal(argv[0], "sandbox-exec");
  assert.equal(argv[1], "-p");
  const profile = argv[2]!;

  assert.ok(profile.includes("(version 1)"));
  assert.ok(profile.includes("(allow default)"));
  assert.ok(profile.includes("(deny file-write*)"));
  assert.ok(profile.includes('(allow file-write* (subpath "/dev"))'));
  assert.ok(profile.includes('(allow file-write* (subpath "/work/project"))'));
  assert.ok(profile.includes('(allow file-write* (subpath "/tmp/scratch-seatbelt"))'));
  assert.ok(profile.includes('(deny file-write* (subpath "/work/project/secret"))'));

  assert.equal(argv[argv.length - 3], "/bin/sh");
  assert.equal(argv[argv.length - 2], "-c");
  assert.equal(argv[argv.length - 1], "git status");
});

test("quoteArg safely escapes single quotes", () => {
  assert.equal(quoteArg("normal"), "'normal'");
  assert.equal(quoteArg("with 'single' quote"), "'with '\\''single'\\'' quote'");
  assert.equal(quoteArg("with \"double\" quote"), "'with \"double\" quote'");
  assert.equal(quoteArg("line1\nline2"), "'line1\nline2'");
  assert.equal(quoteArg("$FOO `uname` $(whoami)"), "'$FOO `uname` $(whoami)'");
});

test("wrapBashCommand safely wraps adversarial commands and passes self-check", () => {
  const policy: SandboxPolicy = {
    cwd: process.cwd(),
    mode: "workspace",
    writable: [process.cwd()],
    deny: [],
  };

  const adversarial = [
    "echo 'hello world'",
    "python3 -c \"print('single and double')\"",
    "curl -sS https://example.com/api?a=1&b=2",
    "cat <<'EOF'\nmultiline\nheredoc\nEOF",
    "export FOO=bar && echo $FOO",
    "ls `pwd` $(whoami)",
  ];

  for (const cmd of adversarial) {
    const wrapped = wrapBashCommand(cmd, policy, "bwrap", { TEST: "1" });
    assert.ok("command" in wrapped, `wrap failed for: ${cmd}`);
    assert.ok(wrapped.command.startsWith("'bwrap'"));
    assert.ok(wrapped.command.includes("'/bin/sh' '-c'"));
  }
});

test("wrapBashCommand blocks commands containing NUL bytes", () => {
  const policy: SandboxPolicy = {
    cwd: process.cwd(),
    mode: "workspace",
    writable: [process.cwd()],
    deny: [],
  };

  const wrapped = wrapBashCommand("echo \0 unsafe", policy, "bwrap");
  assert.ok("block" in wrapped);
  assert.match(wrapped.block, /forbidden NUL character/);
});

test("wrapBashCommand with mode off returns original command unchanged", () => {
  const policy: SandboxPolicy = {
    cwd: process.cwd(),
    mode: "off",
    writable: [],
    deny: [],
  };

  const wrapped = wrapBashCommand("echo raw", policy, "bwrap");
  assert.ok("command" in wrapped);
  assert.equal(wrapped.command, "echo raw");
  assert.deepEqual(wrapped.argv, ["/bin/sh", "-c", "echo raw"]);
});

test("probeBackend probes bwrap and caches result", async () => {
  clearProbeCache();

  const probe = await probeBackend("none");
  assert.equal(probe.ok, true);
  assert.equal(probe.backend, "none");

  if (process.platform === "linux") {
    const bwrapProbe = await probeBackend("bwrap");
    assert.equal(typeof bwrapProbe.ok, "boolean");
    assert.equal(bwrapProbe.backend, "bwrap");
    // Second probe should be cached
    const cachedProbe = await probeBackend("bwrap");
    assert.equal(cachedProbe, bwrapProbe);

    const seatbeltProbe = await probeBackend("seatbelt");
    assert.equal(seatbeltProbe.ok, false);
    assert.match(seatbeltProbe.detail, /macOS/);
  }
});
