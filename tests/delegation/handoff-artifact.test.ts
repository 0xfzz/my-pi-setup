import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHandoffTicket,
  handoffArtifactId,
  isChildReadOnlyArtifact,
  isFrozenHandoffId,
  isFrozenReworkId,
  renderHandoffDocument,
  reportArtifactId,
  reworkArtifactId,
} from "../../lib/delegation/handoff-artifact.ts";

test("artifact ids are stable, ordered and scoped", () => {
  assert.equal(handoffArtifactId("api"), "handoff-api-1");
  assert.equal(handoffArtifactId("api", 3), "handoff-api-3");
  assert.equal(reportArtifactId("api"), "report-api-1");
  assert.equal(reworkArtifactId("api", 2), "rework-api-2");
  // A round below 1 is clamped: round 0 would collide with no handoff at all.
  assert.equal(handoffArtifactId("api", 0), "handoff-api-1");
  // A fractional round never produces a second id for the same document.
  assert.equal(handoffArtifactId("api", 1.9), "handoff-api-1");
});

test("the freeze predicate covers the documents a child must not rewrite", () => {
  assert.equal(isFrozenHandoffId("handoff-api-1"), true);
  assert.equal(isFrozenHandoffId("HANDOFF-API-1"), true, "ids are case-insensitive");
  assert.equal(isFrozenHandoffId("report-api-1"), false, "a child's own report is its own to write");
  assert.equal(isFrozenReworkId("rework-api-2"), true);
  assert.equal(isFrozenReworkId("handoff-api-1"), false);

  assert.equal(isChildReadOnlyArtifact("handoff-api-1"), true);
  assert.equal(isChildReadOnlyArtifact("rework-api-2"), true);
  assert.equal(isChildReadOnlyArtifact("report-api-1"), false);
  assert.equal(isChildReadOnlyArtifact("prd"), false);
});

test("the handoff document states the contract, the freeze and the escalation ladder", () => {
  const doc = renderHandoffDocument({
    scope: "api",
    round: 1,
    assignment: "Add the retry budget to the client.",
    laneFiles: ["src/api.ts"],
    acceptanceCriteria: ["retry budget is configurable", "existing tests pass"],
    role: "worker",
    budgetMinutes: 20,
    guidance: "Follow the existing options object.",
  });

  assert.match(doc, /^# Handoff: api \(round 1\)/, "the document names its work unit and round");
  assert.match(doc, /Add the retry budget to the client\./);
  assert.match(doc, /`src\/api\.ts`/, "the lane is spelled out, not summarised");
  assert.match(doc, /retry budget is configurable/);
  assert.match(doc, /about 20 minutes/);
  assert.match(doc, /Follow the existing options object\./);
  assert.match(doc, /agent_ping/, "an ambiguity routes to the parent");
  assert.match(doc, /You cannot modify this handoff/, "the document says it is frozen");
  assert.match(doc, /report-api-1/, "the report destination is named");
});

test("an undeclared lane forbids writing instead of leaving the question open", () => {
  const doc = renderHandoffDocument({
    scope: "research-only",
    round: 1,
    assignment: "Find where retries are configured.",
    role: "research",
  });
  assert.match(doc, /Do not modify files/);
  assert.match(doc, /No lane declared/);
  assert.match(doc, /No acceptance criteria declared/, "silence is not a passing criterion");
});

test("out-of-lane files are stated as a prohibition", () => {
  const doc = renderHandoffDocument({
    scope: "api",
    round: 1,
    assignment: "Change the client only.",
    laneFiles: ["src/api.ts"],
    outOfLaneFiles: ["src/billing.ts"],
    role: "worker",
  });
  assert.match(doc, /Do NOT touch/);
  assert.match(doc, /`src\/billing\.ts`/);
});

test("a rework quotes the original handoff and the defects it must fix", () => {
  const doc = renderHandoffDocument({
    scope: "api",
    round: 2,
    assignment: "Add the retry budget to the client.",
    laneFiles: ["src/api.ts"],
    role: "worker",
    rework: {
      originalHandoffId: "handoff-api-1",
      originalVersion: 1,
      defects: [
        "Criterion 'retry budget is configurable' is unmet: the budget is a constant in src/api.ts:12.",
        "src/billing.ts was modified and is out of lane.",
      ],
    },
  });

  assert.match(doc, /This is a rework \(round 2\)/);
  assert.match(doc, /handoff-api-1/, "the original is named, not restated from memory");
  assert.match(doc, /\(v1\)/, "the exact revision is cited");
  assert.match(doc, /1\. Criterion 'retry budget is configurable' is unmet/);
  assert.match(doc, /2\. src\/billing\.ts was modified and is out of lane\./);
  assert.match(doc, /keep everything that already matched/, "a rework is a repair, not a rewrite");
  assert.match(doc, /escalate with/, "a disputed defect is escalated, not silently ignored");
});

test("the ticket is a pointer to the handoff, not a copy of it", () => {
  const ticket = buildHandoffTicket({
    scope: "api",
    handoffId: "handoff-api-1",
    role: "worker",
    laneFiles: ["src/api.ts"],
    acceptanceCriteria: ["tests pass"],
  });

  assert.match(ticket, /artifact_recall\(\{ id: "handoff-api-1" \}\)/, "the child is told how to open it");
  assert.match(ticket, /FROZEN/, "and that it cannot rewrite it");
  assert.match(ticket, /an unavailable\s+handoff is a blocker to escalate/, "a missing handoff is not guessed around");
  assert.match(ticket, /`src\/api\.ts`/);
  assert.match(ticket, /tests pass/);
  assert.match(ticket, /report-api-1/);
  // The pointer is short: the assignment prose lives in the artifact.
  assert.doesNotMatch(ticket, /Add the retry budget/);
  assert.ok(ticket.split("\n").length < 30, "a ticket is a pointer, not the document");
});

test("a rework ticket restates the defects so they cannot be missed", () => {
  const ticket = buildHandoffTicket({
    scope: "api",
    round: 2,
    handoffId: "handoff-api-1",
    role: "worker",
    defects: ["the budget is still a constant"],
  });
  assert.match(ticket, /round 2/);
  assert.match(ticket, /Defects this rework must fix/);
  assert.match(ticket, /1\. the budget is still a constant/);
  assert.match(ticket, /report-api-2/, "each round reports into its own artifact");
});
