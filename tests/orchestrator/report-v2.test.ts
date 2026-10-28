import test from "node:test";
import assert from "node:assert/strict";

import {
  chunkContentHash,
  chunkFindings,
  chunkMemberFacts,
  parseChunkReport,
  renderChunkContent,
  renderChunkTicket,
  type ChunkMemberPin,
} from "../../lib/orchestrator/report-v2.ts";

const pin = (scope: string, content = `# Work handoff: ${scope}\n\n## Goal\nDo ${scope}.\n`): ChunkMemberPin => ({
  scope,
  artifactId: `handoff-${scope}`,
  contentHash: "a".repeat(64),
  content,
});

const members = [pin("alpha"), pin("beta")];
const expected = {
  runId: "sr-abc",
  chunkId: "review-1",
  targetHash: chunkContentHash(members),
  memberIds: ["alpha", "beta"],
};

const report = (overrides: Record<string, unknown> = {}) => ({
  version: 2,
  runId: expected.runId,
  chunkId: expected.chunkId,
  targetHash: expected.targetHash,
  summary: "judged both specs",
  members: [
    { memberId: "alpha", verdict: "clean", coverage: ["goal", "criteria"], findings: [] },
    { memberId: "beta", verdict: "clean", coverage: ["goal", "criteria"], findings: [] },
  ],
  ...overrides,
});

test("the chunk hash is order-independent, so the same pins always hash the same", () => {
  assert.equal(chunkContentHash(members), chunkContentHash([...members].reverse()));
  assert.equal(renderChunkContent(members), renderChunkContent([...members].reverse()));
  assert.match(chunkContentHash(members), /^[a-f0-9]{64}$/);
  assert.notEqual(chunkContentHash(members), chunkContentHash([pin("alpha")]));
});

test("a complete two-member report parses, and finds every member", () => {
  const parsed = parseChunkReport(report(), expected);
  assert.equal(parsed.ok, true, parsed.problems.join("; "));
  assert.deepEqual(parsed.report!.members.map((block) => block.memberId), ["alpha", "beta"]);
  const facts = chunkMemberFacts(parsed.report!);
  assert.deepEqual(facts.alpha, { submitted: true, covered: true, verdict: "clean" });
  assert.deepEqual(facts.beta, facts.alpha);
});

test("a reviewer that skips a member is incomplete, never clean", () => {
  const parsed = parseChunkReport(
    report({ members: [{ memberId: "alpha", verdict: "clean", coverage: ["goal"], findings: [] }] }),
    expected,
  );
  assert.equal(parsed.ok, false);
  assert.match(parsed.problems.join("; "), /no block for member "beta"/);
});

test("a clean member with no coverage is refused, because nothing found must not mean nothing looked at", () => {
  const parsed = parseChunkReport(
    report({
      members: [
        { memberId: "alpha", verdict: "clean", coverage: [], findings: [] },
        { memberId: "beta", verdict: "clean", coverage: ["goal"], findings: [] },
      ],
    }),
    expected,
  );
  assert.equal(parsed.ok, false);
  assert.match(parsed.problems.join("; "), /alpha: an empty findings array needs coverage/);
});

test("a finding cannot be moved into a sibling's block", () => {
  const parsed = parseChunkReport(
    report({
      members: [
        {
          memberId: "alpha",
          verdict: "findings",
          coverage: [],
          findings: [{
            id: "F-1", severity: "major", location: "## Goal",
            discrepancy: "vague", rationale: "cannot implement", memberId: "beta",
          }],
        },
        { memberId: "beta", verdict: "clean", coverage: ["goal"], findings: [] },
      ],
    }),
    expected,
  );
  assert.equal(parsed.ok, false);
  assert.match(parsed.problems.join("; "), /names member "beta" inside the "alpha" block/);
});

test("identity fields are checked against the run, not trusted from the payload", () => {
  assert.equal(parseChunkReport(report({ version: 1 }), expected).ok, false);
  assert.equal(parseChunkReport(report({ runId: "sr-other" }), expected).ok, false);
  assert.equal(parseChunkReport(report({ chunkId: "review-2" }), expected).ok, false);
  assert.equal(parseChunkReport(report({ targetHash: "b".repeat(64) }), expected).ok, false);
  assert.equal(parseChunkReport(report({ summary: " " }), expected).ok, false);
  assert.equal(parseChunkReport("not json", expected).ok, false);
});

test("an unknown or duplicated member block is refused", () => {
  const unknown = parseChunkReport(
    report({
      members: [
        { memberId: "alpha", verdict: "clean", coverage: ["goal"], findings: [] },
        { memberId: "beta", verdict: "clean", coverage: ["goal"], findings: [] },
        { memberId: "gamma", verdict: "clean", coverage: ["goal"], findings: [] },
      ],
    }),
    expected,
  );
  assert.equal(unknown.ok, false);
  assert.match(unknown.problems.join("; "), /gamma.*not in this chunk/);

  const duplicated = parseChunkReport(
    report({
      members: [
        { memberId: "alpha", verdict: "clean", coverage: ["goal"], findings: [] },
        { memberId: "alpha", verdict: "clean", coverage: ["goal"], findings: [] },
      ],
    }),
    expected,
  );
  assert.equal(duplicated.ok, false);
  assert.match(duplicated.problems.join("; "), /reported twice/);
});

test("findings keep their member, and ids are derived per member", () => {
  const parsed = parseChunkReport(
    report({
      members: [
        {
          memberId: "alpha",
          verdict: "findings",
          coverage: [],
          findings: [{ severity: "major", location: "## Goal", discrepancy: "vague", rationale: "cannot implement" }],
        },
        {
          memberId: "beta",
          verdict: "findings",
          coverage: [],
          findings: [{ severity: "nit", location: "## Goal", discrepancy: "wordy", rationale: "style" }],
        },
      ],
    }),
    expected,
  );
  assert.equal(parsed.ok, true, parsed.problems.join("; "));
  const findings = chunkFindings(parsed.report!);
  assert.deepEqual(findings.map((finding) => finding.id), ["F-alpha-1", "F-beta-1"]);
  assert.deepEqual(findings.map((finding) => finding.memberId), ["alpha", "beta"]);
});

test("a blocked member marks the chunk facts blocked, not clean", () => {
  const parsed = parseChunkReport(
    report({
      members: [
        { memberId: "alpha", verdict: "blocked", coverage: [], findings: [] },
        { memberId: "beta", verdict: "clean", coverage: ["goal"], findings: [] },
      ],
    }),
    expected,
  );
  assert.equal(parsed.ok, true, parsed.problems.join("; "));
  const facts = chunkMemberFacts(parsed.report!);
  assert.equal(facts.alpha.verdict, "blocked");
  assert.equal(facts.alpha.covered, false);
});

test("the ticket carries only its own members' pinned text and the v2 shape", () => {
  const ticket = renderChunkTicket({
    runId: expected.runId,
    chunkId: expected.chunkId,
    members,
    roots: ["/repo"],
  });
  assert.match(ticket, /review-1 judges: alpha, beta/);
  assert.match(ticket, /<<<PINNED_MEMBER_START alpha/);
  assert.match(ticket, /<<<PINNED_MEMBER_END beta>>>/);
  assert.match(ticket, /"version": 2/);
  assert.match(ticket, /every member listed above appears exactly once/);
  assert.doesNotMatch(ticket, /gamma/);
});
