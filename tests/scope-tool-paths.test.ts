import assert from "node:assert/strict";
import { test } from "node:test";
import { claimSetFor, displayPath, shellClaim } from "../lib/scope/tool-paths.ts";

const cwd = "/work";
const options = { cwd };

test("file tools claim their path and carry the write flag", () => {
  assert.deepEqual(claimSetFor("read", { path: "src/a.ts" }, options).paths, [
    { raw: "src/a.ts", write: false, posture: "read", kind: "file", action: "read" },
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
    ["tee /tmp/log < /etc/hosts", "/etc/hosts", false],
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
  for (const command of ["cat $(pwd)/x", "bash -c 'rm -rf /'", "find . -exec rm {} ;", "ls | xargs rm", "python3 <<PY\nprint(1)\nPY"]) {
    const claim = shellClaim(command, cwd);
    assert.equal(claim.unknown, true, command);
    assert.ok((claim.reason ?? "").length > 0, `${command} must say why`);
  }
});

test("a backtick substitution is analysed like $(), not refused", () => {
  // The command inside the substitution is checked; its output is data. Only a
  // substitution that lands in a *path* slot is unresolvable (see `cat $(pwd)/x`).
  const claim = shellClaim("echo `whoami`", cwd);
  assert.equal(claim.unknown, false, `must be analysed: ${claim.reason ?? ""}`);
  assert.deepEqual(claim.paths, []);
});

test("a loop over api paths with command substitution is analysed, not refused", () => {
  // Regression: the substring scan saw `$(` and rejected the whole command, so a
  // plain curl health check asked for a blanket `bash: allow`.
  const command =
    "for p in /api/property/stats /api/property/review-window/status; do " +
    "code=$(curl -s -o /dev/null -w '%{http_code}' -m 25 \"https://dev-admin.example$p\"); " +
    "echo \"$code  dev-admin  $p\"; done";
  const claim = shellClaim(command, cwd);
  assert.equal(claim.unknown, false, `must not be opaque: ${claim.reason ?? ""}`);
  assert.deepEqual(claim.paths.map(path => path.raw), ["/dev/null"], "only the /dev/null sink is a path");
});

test("a quoted pattern that merely looks like substitution is data", () => {
  const claim = shellClaim("grep -E '$(not-code)|/etc/hosts' README.md", cwd);
  assert.equal(claim.unknown, false);
  assert.deepEqual(claim.paths.map(path => path.raw), [], "a pattern and a data operand are not paths");
});

test("cd reads its directory and moves the base for later commands", () => {
  const claim = shellClaim("cd /external && git fetch origin development", cwd);
  assert.equal(claim.unknown, false);
  const changed = claim.paths.find(path => path.raw === "/external");
  assert.ok(changed, `cd must claim its directory: ${JSON.stringify(claim.paths)}`);
  assert.equal(changed.write, false, "changing directory is a read, not a write into a read-only root");
  const fetch = claim.paths.find(path => path.raw === ".");
  assert.equal(fetch?.base, "/external", "the effective cwd follows the cd");
  assert.equal(fetch?.write, true, "fetch updates the repository");
});

test("a quoted heredoc that mentions substitutions is data, not code", () => {
  const command = "cat > /tmp/scratch.sh <<'SH'\ncode=$(curl -s https://example)\nSH";
  const claim = shellClaim(command, cwd);
  assert.equal(claim.unknown, false, `a quoted heredoc body is data: ${claim.reason ?? ""}`);
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
