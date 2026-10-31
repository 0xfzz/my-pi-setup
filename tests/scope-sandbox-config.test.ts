import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalize } from "../lib/scope/paths.ts";
import {
  DEFAULT_SANDBOX_CONFIG,
  mergeSandboxConfig,
  parseSandboxConfig,
  type SandboxConfig,
} from "../lib/scope/sandbox/config.ts";
import { loadScopeConfig, scopeSnapshot } from "../lib/scope/state.ts";

async function fixture(config?: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "scope-sandbox-config-"));
  if (config !== undefined) {
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(join(dir, ".pi", "scope.json"), JSON.stringify(config));
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("default sandbox configuration is off, auto backend, both ask mode, model retry", () => {
  assert.equal(DEFAULT_SANDBOX_CONFIG.mode, "off");
  assert.equal(DEFAULT_SANDBOX_CONFIG.backend, "auto");
  assert.equal(DEFAULT_SANDBOX_CONFIG.ask, "both");
  assert.equal(DEFAULT_SANDBOX_CONFIG.retry, "model");
  assert.equal(DEFAULT_SANDBOX_CONFIG.scratch, "session");
  assert.deepEqual(DEFAULT_SANDBOX_CONFIG.allow, []);
  assert.deepEqual(DEFAULT_SANDBOX_CONFIG.deny, []);
});

test("parseSandboxConfig parses valid options and normalizes paths", () => {
  const problems: string[] = [];
  const base = "/tmp/test-base";
  const parsed = parseSandboxConfig(
    {
      mode: "workspace",
      backend: "bwrap",
      ask: "refusal",
      retry: "auto",
      scratch: "session",
      allow: ["relative/dir", "/absolute/dir"],
      deny: ["deny/dir"],
    },
    "test.json",
    base,
    problems,
  );

  assert.equal(problems.length, 0);
  assert.equal(parsed.mode, "workspace");
  assert.equal(parsed.backend, "bwrap");
  assert.equal(parsed.ask, "refusal");
  assert.equal(parsed.retry, "auto");
  assert.equal(parsed.scratch, "session");
  assert.deepEqual(parsed.allow, [
    canonicalize("/tmp/test-base/relative/dir"),
    canonicalize("/absolute/dir"),
  ]);
  assert.deepEqual(parsed.deny, [canonicalize("/tmp/test-base/deny/dir")]);
});

test("unknown keys in sandbox config are reported loudly", () => {
  const problems: string[] = [];
  const parsed = parseSandboxConfig(
    {
      mode: "workspace",
      unknownOption: "value",
      extraKey: 123,
    },
    "/etc/scope.json",
    "/base",
    problems,
  );

  assert.equal(parsed.mode, "workspace");
  assert.equal(problems.length, 2);
  assert.match(problems[0]!, /unknown key "sandbox.unknownOption"/);
  assert.match(problems[1]!, /unknown key "sandbox.extraKey"/);
});

test("invalid enums and types are reported loudly", () => {
  const problems: string[] = [];
  parseSandboxConfig(
    {
      mode: "invalid-mode",
      backend: "invalid-backend",
      ask: "invalid-ask",
      retry: "invalid-retry",
      scratch: 12345,
      allow: "not-an-array",
      deny: [123],
    },
    "bad.json",
    "/base",
    problems,
  );

  assert.ok(problems.some(p => p.includes('invalid "sandbox.mode"')));
  assert.ok(problems.some(p => p.includes('invalid "sandbox.backend"')));
  assert.ok(problems.some(p => p.includes('invalid "sandbox.ask"')));
  assert.ok(problems.some(p => p.includes('invalid "sandbox.retry"')));
  assert.ok(problems.some(p => p.includes('invalid "sandbox.scratch"')));
  assert.ok(problems.some(p => p.includes('"sandbox.allow" must be an array')));
  assert.ok(problems.some(p => p.includes('"sandbox.deny" entries must be non-empty strings')));
});

test("mergeSandboxConfig overrides scalars and unions allow/deny", () => {
  const base: SandboxConfig = {
    mode: "off",
    backend: "auto",
    ask: "both",
    retry: "model",
    scratch: "session",
    allow: ["/global/allow"],
    deny: ["/global/deny"],
  };

  const merged = mergeSandboxConfig(base, {
    mode: "workspace",
    backend: "landlock",
    allow: ["/project/allow", "/global/allow"], // deduplicated
    deny: ["/project/deny"],
  });

  assert.equal(merged.mode, "workspace");
  assert.equal(merged.backend, "landlock");
  assert.equal(merged.ask, "both");
  assert.deepEqual(merged.allow, ["/global/allow", "/project/allow"]);
  assert.deepEqual(merged.deny, ["/global/deny", "/project/deny"]);
});

test("loadScopeConfig loads sandbox configuration from project scope.json", async () => {
  const f = await fixture({
    sandbox: {
      mode: "workspace",
      backend: "bwrap",
      allow: ["extra-allow"],
    },
  });

  try {
    const loaded = loadScopeConfig(f.dir);
    assert.equal(loaded.problems.length, 0);
    assert.equal(loaded.state.sandbox?.mode, "workspace");
    assert.equal(loaded.state.sandbox?.backend, "bwrap");
    assert.deepEqual(loaded.state.sandbox?.allow, [canonicalize(join(f.dir, "extra-allow"))]);
  } finally {
    await f.cleanup();
  }
});

test("scopeSnapshot persists sandbox state when mode is not off", () => {
  const fDir = canonicalize("/mock/workspace");
  const state = {
    roots: [{ path: fDir, access: "rw" as const, source: "session" as const }],
    rules: [],
    defaults: { external: "ask" as const, readExternal: "allow" as const },
    sandbox: {
      ...DEFAULT_SANDBOX_CONFIG,
      mode: "workspace" as const,
      backend: "bwrap" as const,
    },
  };

  const snapshot = scopeSnapshot(state);
  assert.deepEqual(snapshot.sandbox, {
    ...DEFAULT_SANDBOX_CONFIG,
    mode: "workspace",
    backend: "bwrap",
  });
});
