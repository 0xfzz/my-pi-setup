import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalize } from "../lib/scope/paths.ts";
import {
  DEFAULT_SANDBOX_CONFIG,
  type SandboxConfig,
} from "../lib/scope/sandbox/config.ts";
import { buildSandboxEnv } from "../lib/scope/sandbox/env.ts";
import {
  deriveSandboxPolicy,
  STANDARD_WRITABLE_DEVICES,
} from "../lib/scope/sandbox/policy.ts";
import type { ScopeState } from "../lib/scope/types.ts";

test("deriveSandboxPolicy returns empty writable and deny when mode is off", () => {
  const cwd = canonicalize("/work/repo");
  const state: ScopeState = {
    roots: [
      { path: cwd, access: "rw", source: "session" },
      { path: canonicalize("/other/rw"), access: "rw", source: "project" },
    ],
    rules: [],
    defaults: { external: "ask", readExternal: "allow" },
  };

  const policy = deriveSandboxPolicy(state, DEFAULT_SANDBOX_CONFIG, cwd);
  assert.equal(policy.mode, "off");
  assert.deepEqual(policy.writable, []);
  assert.deepEqual(policy.deny, []);
});

test("deriveSandboxPolicy in workspace mode includes cwd, rw roots, devices, scratch, allow, and excludes deny and ro roots", () => {
  const cwd = canonicalize("/work/repo");
  const rwRoot = canonicalize("/shared/libs");
  const roRoot = canonicalize("/reference/docs");
  const extraAllow = canonicalize("/custom/writable");
  const deniedPath = canonicalize("/work/repo/sensitive");
  const scratchDir = canonicalize("/tmp/sandbox-scratch-123");

  const state: ScopeState = {
    roots: [
      { path: cwd, access: "rw", source: "session" },
      { path: rwRoot, access: "rw", source: "project" },
      { path: roRoot, access: "ro", source: "session" },
      { path: deniedPath, access: "rw", source: "session" },
    ],
    rules: [],
    defaults: { external: "ask", readExternal: "allow" },
  };

  const config: SandboxConfig = {
    ...DEFAULT_SANDBOX_CONFIG,
    mode: "workspace",
    allow: [extraAllow],
    deny: [deniedPath],
  };

  const policy = deriveSandboxPolicy(state, config, cwd, { scratchDir });
  assert.equal(policy.mode, "workspace");
  assert.equal(policy.scratchDir, scratchDir);

  // Must include: cwd, rwRoot, extraAllow, scratchDir, and devices
  assert.ok(policy.writable.includes(cwd));
  assert.ok(policy.writable.includes(rwRoot));
  assert.ok(policy.writable.includes(extraAllow));
  assert.ok(policy.writable.includes(scratchDir));
  for (const dev of STANDARD_WRITABLE_DEVICES) {
    assert.ok(policy.writable.includes(dev));
  }

  // Must NOT include roRoot or deniedPath
  assert.ok(!policy.writable.includes(roRoot), "roRoot must not be in writable set");
  assert.ok(!policy.writable.includes(deniedPath), "deniedPath must not be in writable set");
  assert.ok(policy.deny.includes(deniedPath));
});

test("deriveSandboxPolicy in readonly mode excludes workspace and rw roots", () => {
  const cwd = canonicalize("/work/repo");
  const rwRoot = canonicalize("/shared/libs");
  const extraAllow = canonicalize("/build/temp");
  const scratchDir = canonicalize("/tmp/sandbox-scratch-456");

  const state: ScopeState = {
    roots: [
      { path: cwd, access: "rw", source: "session" },
      { path: rwRoot, access: "rw", source: "project" },
    ],
    rules: [],
    defaults: { external: "ask", readExternal: "allow" },
  };

  const config: SandboxConfig = {
    ...DEFAULT_SANDBOX_CONFIG,
    mode: "readonly",
    allow: [extraAllow],
  };

  const policy = deriveSandboxPolicy(state, config, cwd, { scratchDir });
  assert.equal(policy.mode, "readonly");

  // In readonly mode, workspace and rw roots are NOT in writable
  assert.ok(!policy.writable.includes(cwd), "cwd must not be writable in readonly mode");
  assert.ok(!policy.writable.includes(rwRoot), "rwRoot must not be writable in readonly mode");

  // Scratch, allow, and devices are writable
  assert.ok(policy.writable.includes(scratchDir));
  assert.ok(policy.writable.includes(extraAllow));
  for (const dev of STANDARD_WRITABLE_DEVICES) {
    assert.ok(policy.writable.includes(dev));
  }
});

test("buildSandboxEnv sets incidental-write mitigation variables and scratch caching paths", () => {
  const scratchDir = "/tmp/sandbox-scratch-789";
  const env = buildSandboxEnv({ scratchDir });

  assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
  assert.equal(env.HISTFILE, "/dev/null");
  assert.equal(env.PAGER, "cat");
  assert.equal(env.GIT_PAGER, "cat");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.TMPDIR, scratchDir);
  assert.equal(env.XDG_CACHE_HOME, "/tmp/sandbox-scratch-789/cache");
  assert.equal(env.npm_config_cache, "/tmp/sandbox-scratch-789/npm");
  assert.equal(env.PIP_CACHE_DIR, "/tmp/sandbox-scratch-789/pip");
  assert.equal(env.HOME, undefined, "HOME must not be redirected");
});

test("deriveSandboxPolicy applies a one-shot grant but never over a deny", () => {
  const cwd = canonicalize("/work/repo");
  const denied = canonicalize("/tmp/locked");
  const state: ScopeState = {
    roots: [{ path: cwd, access: "rw", source: "session" }],
    rules: [],
    defaults: { external: "ask", readExternal: "allow" },
  };
  const config: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, mode: "workspace", deny: [denied] };

  const policy = deriveSandboxPolicy(state, config, cwd, { extraWritable: ["/tmp", denied] });
  assert.ok(policy.writable.includes(canonicalize("/tmp")), "the answered folder widens this wrap");
  assert.ok(!policy.writable.includes(denied), "a deny configured by the user still wins");
  assert.deepEqual(policy.deny, [denied]);
});
