import test from "node:test";
import assert from "node:assert/strict";

import {
  isSpecOnlyDeniedTool,
  pathPolicyProblem,
  readTargets,
  reviewPolicyFromEnv,
  reviewPolicyStatus,
  SPEC_ONLY_TOOLS,
  SPEC_ONLY_POLICY,
  REVIEW_DIR_ENV,
  REVIEW_LENS_ENV,
  REVIEW_POLICY_ENV,
  REVIEW_ROOTS_ENV,
  REVIEW_RUN_ENV,
  REVIEW_TARGET_ENV,
} from "../../lib/orchestrator/review-policy.ts";

const env = (overrides: Record<string, string | undefined> = {}) => ({
  [REVIEW_POLICY_ENV]: SPEC_ONLY_POLICY,
  [REVIEW_RUN_ENV]: "sr-abc123",
  [REVIEW_LENS_ENV]: "comprehension",
  [REVIEW_TARGET_ENV]: "f".repeat(64),
  [REVIEW_DIR_ENV]: "/tmp/review/sr-abc123",
  ...overrides,
});

test("an ordinary child has no review policy", () => {
  assert.equal(reviewPolicyFromEnv({}), undefined);
  assert.equal(reviewPolicyFromEnv({ [REVIEW_POLICY_ENV]: "advisory" }), undefined);
});

test("a half-written policy is refused rather than weakened", () => {
  for (const missing of [REVIEW_RUN_ENV, REVIEW_LENS_ENV, REVIEW_TARGET_ENV, REVIEW_DIR_ENV]) {
    const withHole = env({ [missing]: undefined });
    assert.equal(reviewPolicyFromEnv(withHole), undefined, `${missing} is required`);
    const status = reviewPolicyStatus(withHole);
    assert.equal(status.state, "invalid", `${missing} must make the policy invalid, not ordinary`);
    assert.ok(status.state === "invalid" && status.problems.length > 0);
  }
});

test("policy status distinguishes absent, valid and invalid", () => {
  assert.equal(reviewPolicyStatus({}).state, "none");
  assert.equal(reviewPolicyStatus({ [REVIEW_POLICY_ENV]: "" }).state, "none");
  assert.equal(reviewPolicyStatus({ [REVIEW_POLICY_ENV]: "spec-only" }).state, "invalid");
  assert.equal(reviewPolicyStatus({ [REVIEW_POLICY_ENV]: "advisory" }).state, "invalid");
  assert.equal(reviewPolicyStatus(env()).state, "valid");

  const badHash = reviewPolicyStatus(env({ [REVIEW_TARGET_ENV]: "not-a-hash" }));
  assert.equal(badHash.state, "invalid");
  assert.ok(badHash.state === "invalid" && badHash.problems.some(problem => /sha256/.test(problem)));

  const badLens = reviewPolicyStatus(env({ [REVIEW_LENS_ENV]: "vibes" }));
  assert.equal(badLens.state, "invalid");
  assert.ok(badLens.state === "invalid" && badLens.problems.some(problem => /not a known review lens/.test(problem)));
});

test("a complete policy resolves roots absolutely", () => {
  const policy = reviewPolicyFromEnv(env({ [REVIEW_ROOTS_ENV]: "/repo/a, /repo/b" }));
  assert.ok(policy);
  assert.equal(policy!.runId, "sr-abc123");
  assert.equal(policy!.lens, "comprehension");
  assert.deepEqual(policy!.roots, ["/repo/a", "/repo/b"]);
  assert.deepEqual(reviewPolicyFromEnv(env())!.roots, []);
});

test("reviewers can research, but cannot reach the author, a writer, a provider, or another scope", () => {
  for (const name of ["bash", "write", "edit", "orch_parent_recall", "orch_parent_digest", "orch_history", "browser", "mcp", "codemode", "google_search", "web_search", "fetch_content", "source_check", "artifact_search", "artifact_list", "orch_spawn", "orch_review", "tool_search"]) {
    assert.equal(isSpecOnlyDeniedTool(name), true, `${name} must be denied`);
  }
  for (const name of ["read", "grep", "find", "ls", "ffgrep", "fffind", "web_read", "web_research", "web_fetch", "code_map", "code_search", "code_read", "shell_read", "artifact_save", "artifact_edit", "artifact_recall", "orch_spec_review_submit", "orch_ping", "orch_done"]) {
    assert.equal(isSpecOnlyDeniedTool(name), false, `${name} must be allowed`);
  }
  // Fail closed: an unknown third-party or gateway tool is not in the allowlist.
  assert.equal(isSpecOnlyDeniedTool("some_new_gateway"), true);
  assert.equal(isSpecOnlyDeniedTool(""), true);
  assert.ok(SPEC_ONLY_TOOLS.has("orch_spec_review_submit"));
  assert.equal(isSpecOnlyDeniedTool("orch_spec_review_submit"), false, "the reviewer's own submit tool survives the orch_ prefix rule");
});

test("control-plane paths are unreadable to a reviewer", () => {
  const cwd = "/work/repo";
  const sessionDir = "/home/u/.pi/agent/sessions/--work-repo--";
  const options = { cwd, deny: [sessionDir] };

  assert.equal(pathPolicyProblem("src/a.ts", options), undefined);
  assert.match(String(pathPolicyProblem(`${sessionDir}/handoffs/x/spec.md`, options)), /control-plane/,
    "an absolute path inside the session state directory is refused");
});

test("permitted roots confine reads when roots are declared", () => {
  const options = { cwd: "/work/repo", roots: ["/work/repo"], deny: [] };
  assert.equal(pathPolicyProblem("src/a.ts", options), undefined);
  assert.match(String(pathPolicyProblem("/etc/passwd", options)), /outside the reviewer's permitted roots/);
  assert.match(String(pathPolicyProblem("../sibling/secret.ts", options)), /outside the reviewer's permitted roots/);
  // A dotdot escape that lands back inside the root is fine: the boundary is the resolved path.
  assert.equal(pathPolicyProblem("src/../src/a.ts", options), undefined);
});

test("`..` is collapsed before the control-plane check, so it cannot be smuggled", () => {
  const sessionDir = "/work/repo/.pi/agent/sessions";
  const problem = pathPolicyProblem("src/../.pi/agent/sessions/parent.jsonl", { cwd: "/work/repo", deny: [sessionDir] });
  assert.match(String(problem), /control-plane/);
});

test("read guards inspect the paths a read tool actually names", () => {
  assert.deepEqual(readTargets("read", { path: "src/a.ts" }), ["src/a.ts"]);
  assert.deepEqual(readTargets("ls", { path: "src" }), ["src"]);
  assert.deepEqual(readTargets("grep", { path: "src", pattern: "retry" }), ["src"]);
  assert.deepEqual(readTargets("fffind", { pattern: "src/**" }), ["src/**"]);
  assert.deepEqual(readTargets("orch_spec_review_submit", { path: "ignored" }), []);
});
