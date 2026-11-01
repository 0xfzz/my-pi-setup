import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readOnlyShellCommand } from "../lib/plan/plan-shell.ts";
import { EXPECTED_PLAN_TOOLS, PLAN_TOOLS, isPlanTool, missingPlanTools } from "../lib/plan/plan-mode.ts";

const allowed = [
  "pwd", "ls -la /tmp", "cat /etc/hosts", "head -n 10 '../a b.txt' | wc -l",
  "cd '/tmp/a b' && rg 'foo|bar' . | head -n 10", "grep -n 'a;touch /tmp/no' file",
  "find /tmp -maxdepth 2 -type f -name '*.ts' -print", "git status --short", "git log -n 2",
  "git diff -- src/file.ts", "git show HEAD:package.json", "git ls-files", "git rev-parse HEAD",
  // Reviewer shapes recorded in real sessions: a read-only chain joined with `;`,
  // a repo inspected from outside its worktree, the environment dumped, a probe.
  "ls -la /tmp; ls -la /var; wc -l /etc/hosts", "git -C /tmp/repo status --short",
  "git -C /tmp/repo diff --stat", "env", "env -i", "echo test",
];
const blocked = [
  "", "touch new", "cat file > copy", "cat file >> copy", "cat file 2>/tmp/error", "cat file; touch copy",
  "cat file\ntouch copy", "cat file || touch copy", "cat file &", "cat file | tee copy", "cat file && rm copy",
  "cat $(touch copy)", "cat `touch copy`", "cat <(touch copy)", "cat ${HOME}/file", "cat $'file'",
  "cat file # comment", "cat 'unfinished", "cat file\\", "cat file |", "| cat file",
  "env touch copy", "bash -c 'touch copy'", "python -c 'open(\"copy\",\"w\")'", "node -e 'process.exit()'",
  "find . -delete", "find . -exec touch copy ';'", "find . -execdir touch copy ';'", "find . -fprint copy",
  "find . -fprintf copy '%p'", "find . -ok touch copy ';'", "find . -fls copy",
  "rg --pre 'touch copy' x", "rg --pre='touch copy' x", "rg --hostname-bin=script x", "rg -z x", "rg -nz x",
  "sed -i s/a/b/ file", "awk 'BEGIN {system(\"touch copy\")}'", "sort -o copy file", "curl -o copy https://example.com",
  "git add file", "git config key value", "git branch -D branch", "git -c alias.x='!touch copy' x",
  "git diff --output=copy", "git log --output copy", "git diff --out=copy", "git diff --ext-diff", "git show --textconv file",
  "git show --no-no-textconv", "git diff --no-no-ext-diff", "git log -cexternal.key=value",
  "/tmp/fake-cat file", "PATH=/tmp cat file", "cd -P /tmp", "cd /tmp | cat file", "ls *.ts",
  // `;` is only a separator between read-only segments, and it cannot smuggle a
  // command, a leading segment, or a cd that changes what follows.
  "; cat file", "cat file;", "cat file; touch copy", "ls; rm -rf /tmp/x", "cd /tmp; cat file",
  // `env` is a launcher as soon as it gets a non-flag argument.
  "env FOO=1 cat file", "env -u FOO cat file", "env cat file",
  // `-C` accepts a path, not a config override or a `-c` escape.
  "git -C /tmp/repo -c alias.x='!touch copy' status", "git -C /tmp/repo commit -m x",
  "git -C -c status",
];
test("Plan shell parses and normalizes supported read-only commands", () => {
  for (const command of allowed) assert.equal(typeof readOnlyShellCommand(command), "string", command);
  assert.equal(readOnlyShellCommand("cat 'a b' | head -n 2"), "'cat' 'a b' | 'head' '-n' '2'");
  assert.equal(readOnlyShellCommand('cat "a\\\"b"'), `'cat' 'a"b'`);
  assert.equal(readOnlyShellCommand("cat 'a'\\''b'"), "'cat' 'a'\\''b'");
  assert.match(readOnlyShellCommand("rg foo .")!, /'rg' '--no-config'/);
  assert.match(readOnlyShellCommand("git diff")!, /core.fsmonitor=false/);
  assert.match(readOnlyShellCommand("git diff")!, /--no-ext-diff.*--no-textconv/);
  assert.equal(readOnlyShellCommand("ls 2>/dev/null"), "'ls' 2>/dev/null");
  assert.equal(readOnlyShellCommand("grep -rl foo /tmp 2>/dev/null | head -n 2"), "'grep' '-rl' 'foo' '/tmp' 2>/dev/null | 'head' '-n' '2'");
  assert.match(readOnlyShellCommand("ls ~/projects")!, /'ls' '.*\/projects'/);
  assert.equal(readOnlyShellCommand("ls -la /tmp; wc -l /etc/hosts"), "'ls' '-la' '/tmp' ; 'wc' '-l' '/etc/hosts'");
  assert.match(readOnlyShellCommand("git -C /tmp/repo status")!, /'git' '--no-pager'.*'-C' '\/tmp\/repo' .*'status'$/);
});
test("Plan shell rejects mutation, command execution and shell expansion routes", () => {
  for (const command of blocked) assert.equal(readOnlyShellCommand(command), undefined, command);
  for (const command of [undefined, null, 5, {}, []]) assert.equal(readOnlyShellCommand(command), undefined);
});
test("normalized shell reads files outside the working directory without changing them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-shell-"));
  const source = join(dir, "literal;name.txt");
  try {
    await writeFile(source, "outside workspace\nsecond line\n");
    const command = readOnlyShellCommand(`cat '${source}' | head -n 1`)!;
    assert.equal(execFileSync("bash", ["--noprofile", "--norc", "-c", command], { cwd: "/", encoding: "utf8" }), "outside workspace\n");
    assert.equal(await readFile(source, "utf8"), "outside workspace\nsecond line\n");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("read-only tool annotations allow research but do not reopen opaque execution tools", () => {
  // Plan may delegate, because researching and reviewing is read-only for the parent.
  for (const name of ["agent_spawn", "agent_running", "agent_escalate"]) {
    assert.equal(isPlanTool(name), true, `${name} is a plan-safe parent tool`);
  }
  assert.equal(isPlanTool("mcp__docs__search", { name: "mcp__docs__search", annotations: { readOnlyHint: true } }), true);
  assert.equal(isPlanTool("unknown"), false);
  assert.equal(isPlanTool("mcp__docs__write", { name: "mcp__docs__write", annotations: { destructiveHint: false } }), false);
  assert.equal(isPlanTool("mcp__docs__broken", { name: "mcp__docs__broken", annotations: { readOnlyHint: true, destructiveHint: true } }), false);
  for (const name of ["write", "edit", "browser", "codemode", "mcp", "mcpScript"]) {
    assert.equal(isPlanTool(name, { name, annotations: { readOnlyHint: true } }), false, name);
  }
});

// Regression: the allowlist named tools that do not exist (`web_fetch`,
// `web_enable`), and nothing reported drift when a name was renamed.
test("plan allowlist has no dead names and reports drift", () => {
  for (const dead of ["web_fetch", "web_enable"]) {
    assert.equal(isPlanTool(dead), false, `${dead} must not be allowlisted`);
  }
  for (const real of ["web_search", "google_search", "vcc_recall", "ffgrep", "bash"]) {
    assert.equal(isPlanTool(real), true, `${real} must remain allowlisted`);
  }
  // Read-only MCP tools still pass via annotations, not the allowlist.
  assert.equal(isPlanTool("mcp__docs__search", { name: "mcp__docs__search", annotations: { readOnlyHint: true } }), true);

  const missing = missingPlanTools(["read", "bash", "web_search"]);
  assert.deepEqual(missing, ["find", "grep", "ls"], "only always-registered tools are reported");
  assert.deepEqual(missing, [...missing].sort(), "drift list is deterministic");
  assert.deepEqual(missingPlanTools(["read", "grep", "find", "ls", "bash"]), []);
});

// Regression: `list_mcp_resources`, `list_mcp_resource_templates` and
// `read_mcp_resource` are registered ONLY when a connected MCP server advertises
// resources, so listing them in PLAN_TOOLS warned "unregistered tool(s)" in every
// session without an MCP resource server. They are read-only by annotation, which
// is the path that must keep them usable in Plan mode.
test("conditionally registered MCP resource tools never cause drift warnings", () => {
  const resourceTools = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

  // A session with no MCP resource server registers none of them, and says nothing.
  assert.deepEqual(missingPlanTools(["read", "grep", "find", "ls", "bash"]), []);

  for (const name of resourceTools) {
    // Not asserted as always-present, so absence is not drift.
    assert.equal(EXPECTED_PLAN_TOOLS.has(name), false, `${name} must not be an expected tool`);
    // Still usable in Plan mode: Pi declares them read-only.
    assert.equal(
      isPlanTool(name, { name, annotations: { readOnlyHint: true } }),
      true,
      `${name} must stay read-only-usable via its annotation`,
    );
    // No allowlist entry is needed for that, so the redundant name stays gone.
    assert.equal(PLAN_TOOLS.has(name), false, `${name} needs no allowlist entry`);
  }

  // A destructive MCP tool is still refused even though other MCP tools are read-only.
  assert.equal(
    isPlanTool("mcp__docs__delete", { name: "mcp__docs__delete", annotations: { readOnlyHint: false } }),
    false,
  );
});
