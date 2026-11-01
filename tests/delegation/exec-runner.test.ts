import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createExecRunner, DEFAULT_TIMEOUT_MS } from "../../lib/delegation/exec-runner.ts";

test("createExecRunner executes binaries with argv arguments without shell interpretation", async () => {
  const runner = createExecRunner();
  const res = await runner.run("echo", ["hello", "world"], { timeoutMs: 5000 });
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout.trim(), "hello world");
  assert.equal(res.timedOut, false);
});

test("createExecRunner captures nonzero exit code", async () => {
  const runner = createExecRunner();
  const res = await runner.run("false", [], { timeoutMs: 5000 });
  assert.equal(res.exitCode, 1);
  assert.equal(res.timedOut, false);
});

test("createExecRunner handles timeout cleanly", async () => {
  const runner = createExecRunner();
  const res = await runner.run("sleep", ["2"], { timeoutMs: 50 });
  assert.equal(res.timedOut, true);
});

test("exec-runner never walks the tree in JavaScript", () => {
  const source = readFileSync(join(import.meta.dirname, "../../lib/delegation/exec-runner.ts"), "utf8");
  assert.doesNotMatch(source, /\breaddir(Sync)?\b|\bopendir(Sync)?\b/);
  assert.equal(DEFAULT_TIMEOUT_MS, 10_000);
});
