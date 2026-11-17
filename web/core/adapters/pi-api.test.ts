import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiApiName } from "../shared/pi-api.ts";
import { piApiAdapters } from "./pi-api.ts";
import type { AdapterContext } from "./types.ts";

const API_NAMES: readonly PiApiName[] = [
  "autocomplete.suggestions",
  "commands.builtin",
  "settings.read",
  "settings.write",
  "settings.models.read",
  "settings.models.write",
  "trust.read",
  "trust.write",
  "auth.read",
  "auth.login",
  "auth.state",
  "auth.answer",
  "auth.logout",
  "mcp.read",
  "mcp.write",
];

function context(cwd: string): AdapterContext {
  return { cwd, grantedCapabilities: [] };
}

function activeSignal(): AbortSignal {
  return new AbortController().signal;
}

test("piApiAdapters has exactly one adapter function per pi_api name", () => {
  assert.deepEqual(Object.keys(piApiAdapters).sort(), [...API_NAMES].sort());
  for (const name of API_NAMES) assert.equal(typeof piApiAdapters[name], "function", name);
});

test("pi_api read adapter returns pi's built-in commands for a temp cwd", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "piapi-adapter-cwd-"));
  try {
    const result = await piApiAdapters["commands.builtin"](context(cwd), {}, activeSignal());
    assert.ok(result.ok, result.ok ? "" : result.error.message);
    assert.ok(Array.isArray(result.value));
    assert.ok(result.value.length > 0);
    assert.match(JSON.stringify(result.value), /"compact"/, "pi's builtin list came from the host");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("pi_api validation failure is VALIDATION_FAILED and names the api and field", async () => {
  const result = await piApiAdapters["settings.write"](context(tmpdir()), { key: "theme" }, activeSignal());
  assert.ok(!result.ok, "an incomplete settings.write is rejected");
  assert.equal(result.error.code, "VALIDATION_FAILED");
  assert.equal(result.error.retryable, false);
  assert.equal(result.error.details?.api, "settings.write");
  assert.match(result.error.message, /settings\.write/);
  assert.match(result.error.message, /\bvalue\b/);
});

test("pi_api adapter refuses an already-aborted signal with ADAPTER_UNAVAILABLE", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await piApiAdapters["commands.builtin"](context(tmpdir()), {}, controller.signal);
  assert.ok(!result.ok, "an aborted request is not dispatched");
  assert.equal(result.error.code, "ADAPTER_UNAVAILABLE");
  assert.equal(result.error.retryable, true);
  assert.equal(result.error.details?.api, "commands.builtin");
});

test("pi_api dispatch failure maps to ADAPTER_UNAVAILABLE with safe details", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "piapi-adapter-agent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    // Structurally valid, but pi's own settings facade rejects the key.
    const result = await piApiAdapters["settings.write"](
      context(tmpdir()),
      { key: "no-such-setting", value: true },
      activeSignal(),
    );
    assert.ok(!result.ok, "pi's rejection is returned as a protocol error");
    assert.equal(result.error.code, "ADAPTER_UNAVAILABLE");
    assert.equal(result.error.retryable, true);
    assert.deepEqual(result.error.details, { api: "settings.write" });
    assert.match(result.error.message, /dispatch failed/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(agentDir, { recursive: true, force: true });
  }
});
