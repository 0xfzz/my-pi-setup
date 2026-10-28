import assert from "node:assert/strict";
import { test } from "node:test";
import { claimSetFor, displayPath, shellClaim } from "../lib/scope/tool-paths.ts";

const cwd = "/work";
const options = { cwd };

test("file tools claim their path and carry the write flag", () => {
  assert.deepEqual(claimSetFor("read", { path: "src/a.ts" }, options).paths, [
    { raw: "src/a.ts", write: false, kind: "file", action: "read" },
  ]);
  assert.equal(claimSetFor("write", { path: "src/a.ts" }, options).paths[0]?.write, true);
  assert.equal(claimSetFor("edit", { path: "src/a.ts" }, options).paths[0]?.write, true);
});

test("search tools default to the cwd when no path is given", () => {
  for (const tool of ["grep", "find", "ls", "ffgrep", "fffind"]) {
    const claim = claimSetFor(tool, { pattern: "x" }, options);
    assert.equal(claim.paths.length, 1, tool);
    assert.equal(claim.paths[0]?.raw, cwd);
    assert.equal(claim.paths[0]?.write, false);
    assert.equal(claim.unknown, false);
  }
});

test("session-state tools make no filesystem claim", () => {
  for (const tool of ["todo_plan", "artifact_save", "ask_user", "agent_spawn", "session_goal", "vcc_recall"]) {
    const claim = claimSetFor(tool, {}, options);
    assert.deepEqual(claim.paths, [], tool);
    assert.equal(claim.unknown, false, `${tool} must not ask`);
  }
});

test("bash extracts absolute, home, parent and redirection paths", () => {
  const cases: Array<[string, string, boolean]> = [
    ["cat ../other/a.txt", "../other/a.txt", false],
    ["cat /etc/passwd", "/etc/passwd", false],
    ["ls ~/notes", "~/notes", false],
    ["find .. -name '*.ts'", "..", false],
    ["echo hi > /tmp/out.txt", "/tmp/out.txt", true],
    ["tee /tmp/log < /etc/hosts", "/etc/hosts", true],
  ];
  for (const [command, expected, write] of cases) {
    const claim = shellClaim(command, cwd);
    assert.equal(claim.unknown, false, command);
    const hit = claim.paths.find(path => path.raw === expected);
    assert.ok(hit, `${command} should claim ${expected}: ${JSON.stringify(claim.paths)}`);
    assert.equal(hit.write, write, command);
  }
});

test("bash inside the workspace is not treated as a write when it is a read-only inspection", () => {
  assert.equal(shellClaim("git -C ../repo status", cwd).paths[0]?.write, false);
  assert.equal(shellClaim("rm -rf ../build", cwd).paths[0]?.write, true);
});

test("bash refuses to guess when the command can escape a tokenizer", () => {
  for (const command of ["cat $(pwd)/x", "bash -c 'rm -rf /'", "find . -exec rm {} ;", "echo `whoami`", "ls | xargs rm", "python3 <<PY\nprint(1)\nPY"]) {
    const claim = shellClaim(command, cwd);
    assert.equal(claim.unknown, true, command);
    assert.match(claim.reason ?? "", /cannot be determined/);
  }
});

test("a heredoc that carries data is not an opaque command", () => {
  // Regression: `git commit -F - <<EOF` used to be denied outright because the
  // whole command was treated as "paths cannot be determined". A heredoc body is
  // data for git; it is code only when an interpreter reads it.
  const claim = shellClaim("git commit -F - <<EOF\nfeat: x\nEOF", cwd);
  assert.equal(claim.unknown, false);
  assert.equal(claim.reason, undefined);

  const redirect = shellClaim("git commit -F msg.txt <<EOF\nbody\nEOF", cwd);
  assert.equal(redirect.unknown, false);
});

test("an unmapped MCP tool is unknown until config names its path field", () => {
  const unmapped = claimSetFor("mcp__private", { file: "x" }, options);
  assert.equal(unmapped.unknown, true);
  const mapped = claimSetFor("mcp__fs", { file: "../x" }, { ...options, mcpPathFields: { mcp__fs: "file" } });
  assert.equal(mapped.unknown, false);
  assert.equal(mapped.paths[0]?.raw, "../x");
  assert.equal(mapped.paths[0]?.write, true, "an unmapped semantics defaults to the write side");
});

test("an unknown tool asks unless it declares readOnlyHint", () => {
  assert.equal(claimSetFor("brand_new", {}, options).unknown, true);
  assert.equal(claimSetFor("brand_new", {}, { ...options, annotations: { readOnlyHint: true } }).unknown, false);
  assert.equal(
    claimSetFor("brand_new", {}, { ...options, annotations: { readOnlyHint: true, destructiveHint: true } }).unknown,
    true,
    "destructiveHint outranks readOnlyHint",
  );
});

test("displayPath prefers the workspace-relative spelling", () => {
  assert.equal(displayPath("/work", "/work/src/a.ts"), "src/a.ts");
  assert.equal(displayPath("/work", "/other/a.ts"), "/other/a.ts");
  assert.equal(displayPath("/work", "/work"), ".");
});
