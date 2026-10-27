import test from "node:test";
import assert from "node:assert/strict";

import { shellReadCommand, shellTokens } from "../../lib/orchestrator/shell-read.ts";
import {
  artifactGuardProblem,
  artifactScopeFor,
  isArtifactScopeTool,
  type ArtifactScopeRule,
} from "../../lib/orchestrator/review-artifact-scope.ts";

const cwd = "/repo";

test("read-only history and inspection commands are accepted", () => {
  for (const command of [
    "git log --oneline -5",
    "git status",
    "git diff --stat",
    "rg -n needle src",
    "cat package.json",
    "find src -name '*.ts'",
  ]) {
    const result = shellReadCommand(command, { cwd, roots: [cwd] });
    assert.equal(result.ok, true, `${command}: ${JSON.stringify(result)}`);
  }
});

test("mutating or expanding commands never reach the executor", () => {
  for (const command of [
    "git checkout .",
    "git commit -m x",
    "rm -rf src",
    "echo hi > file.txt",
    "cat $(curl http://x)",
    "node -e 'console.log(1)'",
    "cat `id`",
  ]) {
    const result = shellReadCommand(command, { cwd, roots: [cwd] });
    assert.equal(result.ok, false, `${command} must be refused`);
  }
});

test("a path outside the reviewer's roots is refused before execution", () => {
  const result = shellReadCommand("cat ../../etc/passwd", { cwd, roots: [cwd] });
  assert.equal(result.ok, false);
  assert.match((result as { problem: string }).problem, /outside the reviewer's permitted roots/);

  const gitC = shellReadCommand("git -C /etc log", { cwd, roots: [cwd] });
  assert.equal(gitC.ok, false, "git -C is path-checked like any other argument");
});

test("an injected guard can refuse a token without running the grammar twice", () => {
  const result = shellReadCommand("cat package.json", {
    cwd,
    guard: (token) => (token === "package.json" ? "package.json is denied here" : undefined),
  });
  assert.equal(result.ok, false);
  assert.match((result as { problem: string }).problem, /denied here/);
});

test("quoted tokens with apostrophes survive re-quoting", () => {
  const result = shellReadCommand("cat \"it's\"", { cwd, roots: [cwd], guard: () => undefined });
  assert.equal(result.ok, true);
  assert.deepEqual(shellTokens((result as { command: string }).command), ["cat", "it's"]);
});

const rule = (overrides: Partial<ArtifactScopeRule> = {}): ArtifactScopeRule => ({
  scope: "review:run-1:gate",
  idPrefix: "review-run-1-gate-",
  allowedTypes: ["scratchpad", "review"],
  maxChars: 60_000,
  ...overrides,
});

test("scope is derived from the launcher environment, never chosen", () => {
  assert.deepEqual(
    artifactScopeFor({ PI_SUBAGENT_REVIEW_RUN: "run-1", PI_SUBAGENT_REVIEW_LENS: "gate" }),
    { scope: "review:run-1:gate", idPrefix: "review-run-1-gate-", allowedTypes: ["scratchpad", "review"], maxChars: 60_000 },
  );
  assert.deepEqual(
    artifactScopeFor({ PI_SUBAGENT_SCOPE: "net-retry" }),
    { scope: "orch-research:net-retry", idPrefix: "research-net-retry-", allowedTypes: ["scratchpad", "review"], maxChars: 60_000 },
  );
  assert.equal(artifactScopeFor({}), undefined);
  assert.equal(isArtifactScopeTool("artifact_save"), true);
  assert.equal(isArtifactScopeTool("artifact_search"), false);
});

test("artifact_save is confined to the derived scope, type, id and size", () => {
  const base = { id: "review-run-1-gate-notes", type: "scratchpad", content: "evidence" };
  assert.equal(artifactGuardProblem("artifact_save", { ...base, scope: "review:run-1:gate" }, { rule: rule() }), undefined);

  assert.match(
    String(artifactGuardProblem("artifact_save", { ...base, scope: "global" }, { rule: rule() })),
    /scope must be "review:run-1:gate"/,
  );
  assert.match(
    String(artifactGuardProblem("artifact_save", base, { rule: rule() })),
    /scope must be "review:run-1:gate"/,
  );
  assert.match(
    String(artifactGuardProblem("artifact_save", { ...base, scope: rule().scope, type: "plan" }, { rule: rule() })),
    /type must be one of/,
  );
  assert.match(
    String(artifactGuardProblem("artifact_save", { ...base, scope: rule().scope, id: "user-artifact" }, { rule: rule() })),
    /id must start with/,
  );
  assert.match(
    String(artifactGuardProblem("artifact_save", { ...base, scope: rule().scope }, { rule: rule({ maxChars: 3 }) })),
    /the limit is 3/,
  );
});

test("editing or recalling a foreign artifact is refused like an unknown one", () => {
  const lookup = (id: string) =>
    id === "review-run-1-gate-notes" ? { id, scope: "review:run-1:gate" } : undefined;

  assert.equal(
    artifactGuardProblem("artifact_edit", { id: "review-run-1-gate-notes" }, { rule: rule(), lookup }),
    undefined,
  );

  const foreign = artifactGuardProblem("artifact_edit", { id: "review-run-2-critic-notes" }, { rule: rule(), lookup });
  const unknown = artifactGuardProblem("artifact_edit", { id: "review-run-1-gate-missing" }, { rule: rule(), lookup });
  assert.match(String(foreign), /not in this session's scope/);
  assert.equal(foreign, unknown, "the guard is not an existence oracle");
});

test("a reviewer cannot discover artifacts without an explicit id", () => {
  assert.match(
    String(artifactGuardProblem("artifact_recall", { query: "retry" }, { rule: rule() })),
    /explicit artifact id/,
  );
  assert.equal(artifactGuardProblem("artifact_recall", { id: "review-run-1-gate-notes" }, {
    rule: rule(),
    lookup: () => ({ scope: "review:run-1:gate" }),
  }), undefined);
});

test("non-artifact tools pass through the guard untouched", () => {
  assert.equal(
    artifactGuardProblem("artifact_search", { query: "x" }, { rule: rule() }),
    undefined,
    "artifact_search is denied by the allowlist, not by this guard",
  );
  assert.equal(artifactGuardProblem("read", { path: "src/a.ts" }, { rule: rule() }), undefined);
});
