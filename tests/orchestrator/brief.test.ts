import test from "node:test";
import assert from "node:assert/strict";

import {
  PACKET_CHAR_BUDGET,
  buildCheckReport,
  buildReviewPacket,
  parseDiff,
  renderReviewPacket,
} from "../../lib/orchestrator/brief.ts";

const DIFF = [
  "diff --git a/src/net/retry.ts b/src/net/retry.ts",
  "index 111..222 100644",
  "--- a/src/net/retry.ts",
  "+++ b/src/net/retry.ts",
  "@@ -38,6 +38,12 @@ export function retry() {",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " ]",
  "@@ -86,4 +92,6 @@ export function budget() {",
  " return x;",
  "+// note",
  " ]",
  "diff --git a/src/auth/jwt.ts b/src/auth/jwt.ts",
  "--- a/src/auth/jwt.ts",
  "+++ b/src/auth/jwt.ts",
  "@@ -1,2 +1,3 @@",
  "+export const leaked = true;",
  " ]",
].join("\n");

test("parseDiff attributes every hunk to the file it belongs to", () => {
  const hunks = parseDiff(DIFF);
  assert.equal(hunks.length, 3);
  assert.equal(hunks[0]!.file, "src/net/retry.ts");
  assert.equal(hunks[2]!.file, "src/auth/jwt.ts", "a hunk header alone does not name its file");
  assert.equal(hunks[0]!.added, 2);
  assert.equal(hunks[0]!.removed, 1);
});

test("parseDiff tolerates no diff at all", () => {
  assert.deepEqual(parseDiff(null), []);
  assert.deepEqual(parseDiff(""), []);
});

test("the packet computes lane violations instead of asking the model", () => {
  const packet = buildReviewPacket({
    scope: "net-retry",
    handoff: { id: "h-net-retry", revision: 1, acceptanceCriteria: ["backoff", "budget"], laneFiles: ["src/net/"] },
    changed: ["src/net/retry.ts", "src/auth/jwt.ts"],
    diff: DIFF,
  });
  assert.deepEqual(packet.outOfLane, ["src/auth/jwt.ts"]);
  assert.deepEqual(packet.criteria, ["backoff", "budget"]);
  assert.equal(packet.frozen, false);
});

test("frozen criteria win over a revised handoff", () => {
  const packet = buildReviewPacket({
    scope: "net-retry",
    handoff: { id: "h", revision: 3, acceptanceCriteria: ["rewritten after the fact"], laneFiles: ["src/net/"] },
    child: {
      id: "c1",
      name: "worker",
      status: "running",
      frozenCriteria: ["as it was at spawn"],
      handoffRevision: 1,
      laneFiles: ["src/net/"],
    },
    changed: [],
  });
  assert.deepEqual(packet.criteria, ["as it was at spawn"]);
  assert.equal(packet.revision, 1);
  assert.equal(packet.frozen, true);
});

test("an uncomputable diff is reported as unknown, never as clean", () => {
  const packet = buildReviewPacket({ scope: "s", changed: null, handoff: { acceptanceCriteria: [], laneFiles: ["src/"] } });
  assert.equal(packet.changed, null);
  assert.deepEqual(packet.outOfLane, [], "no violations is not the same as not looking");
  assert.match(renderReviewPacket(packet), /lane NOT verified/);
});

test("rendering stays inside the budget and states what it dropped", () => {
  // Long lines, so the budget is actually exceeded: 40 short hunks fit inside it,
  // and a test that never truncates cannot prove that truncation is stated.
  const many = Array.from({ length: 40 }, (_, index) => [
    `@@ -${index},1 +${index},2 @@`,
    `+const v${index} = "${"x".repeat(300)}";`,
    " context",
  ].join("\n")).join("\n");
  const packet = buildReviewPacket({
    scope: "big",
    handoff: { acceptanceCriteria: ["one"], laneFiles: ["src/"] },
    changed: ["src/a.ts"],
    diff: `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n${many}`,
  });
  const rendered = renderReviewPacket(packet);
  assert.ok(rendered.length <= PACKET_CHAR_BUDGET, `packet is ${rendered.length} chars`);
  assert.match(rendered, /hunk\(s\) omitted \(budget\)/, "truncation must be stated, not silent");
  assert.ok(rendered.includes("src/a.ts"), "the file must still be named");
});

test("`since` omits files the previous brief already carried", () => {
  const full = buildReviewPacket({
    scope: "net-retry",
    handoff: { acceptanceCriteria: [], laneFiles: ["src/"] },
    changed: ["src/net/retry.ts", "src/auth/jwt.ts"],
    diff: DIFF,
  });
  const incremental = buildReviewPacket({
    scope: "net-retry",
    handoff: { acceptanceCriteria: [], laneFiles: ["src/"] },
    changed: ["src/net/retry.ts", "src/auth/jwt.ts"],
    diff: DIFF,
    previousFiles: ["src/net/retry.ts"],
  });
  assert.equal(full.hunks.length, 3);
  assert.equal(incremental.hunks.length, 1, "only the file that was not sent before");
  assert.deepEqual(incremental.omittedFiles, ["src/net/retry.ts"]);
  assert.match(renderReviewPacket(incremental), /unchanged since last brief: src\/net\/retry\.ts/);
});

test("the child's report is flattened to one bounded paragraph", () => {
  const packet = buildReviewPacket({
    scope: "s",
    changed: [],
    child: { id: "c", name: "w", status: "completed", lastTail: `${"x".repeat(600)}\n\nnext line` },
  });
  const rendered = renderReviewPacket(packet);
  const report = rendered.split("\n").find((line) => line.startsWith("child report:"))!;
  assert.ok(report.length < 400, "a child's log is not the parent's context");
  assert.match(report, /…$/);
});

test("an ad-hoc unit has no lane to violate and says so", () => {
  const packet = buildReviewPacket({
    scope: "spike-cache",
    changed: ["src/a.ts", "src/b.ts"],
    child: { id: "c", name: "Spike", status: "completed", purpose: "adhoc", laneFiles: [] },
  });
  assert.deepEqual(packet.outOfLane, [], "an empty lane is not 'everything is out of lane'");
  assert.equal(packet.handoffId, undefined);
  const rendered = renderReviewPacket(packet);
  assert.match(rendered, /ad-hoc work unit: no handoff spec/);
  assert.match(rendered, /lane: NOT DECLARED/);
  assert.doesNotMatch(rendered, /OUT OF LANE/);
});

test("orch_check reports not-declared for an ad-hoc unit instead of failing it", () => {
  const report = buildCheckReport({
    scope: "spike-cache",
    laneFiles: [],
    laneDeclared: false,
    changed: ["src/a.ts"],
    criteria: [],
    command: undefined,
  });
  assert.equal(report.lane.state, "not-declared");
  assert.deepEqual(report.lane.violations, []);
  assert.match(report.lines.join("\n"), /lane: NOT DECLARED/);
});

test("a declared lane still fails when the diff leaves it", () => {
  const report = buildCheckReport({
    scope: "s",
    laneFiles: ["src/net/"],
    changed: ["src/net/client.ts", "src/auth/jwt.ts"],
    criteria: [],
  });
  assert.equal(report.lane.state, "fail");
  assert.deepEqual(report.lane.violations, ["src/auth/jwt.ts"]);
});
