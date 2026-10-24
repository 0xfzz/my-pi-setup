import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  HandoffError,
  buildChildTicket,
  handoffIdFor,
  leakedSiblingScopes,
  renderHandoffForChild,
  sanitizeScope,
  validateHandoff,
  writeHandoff,
  type HandoffSpec,
} from "../../lib/orchestrator/handoff.ts";

const spec = (over: Partial<HandoffSpec> = {}): HandoffSpec => ({
  scope: "net-retry",
  goal: "Make retry backoff exponential with jitter.",
  acceptanceCriteria: ["Backoff is exponential", "Jitter is applied", "Existing callers unchanged"],
  laneFiles: ["src/net/client.ts", "src/net/backoff.ts"],
  outOfLaneFiles: ["src/auth/jwt.ts"],
  ...over,
});

describe("handoff spec", () => {
  it("rejects a spec with no goal, no criteria, or no lane", () => {
    assert.throws(() => validateHandoff(spec({ goal: "" })), HandoffError);
    assert.throws(() => validateHandoff(spec({ goal: "   " })), /needs a goal/);

    assert.throws(() => validateHandoff(spec({ acceptanceCriteria: [] })), /acceptance criterion/);
    assert.throws(
      () => validateHandoff(spec({ acceptanceCriteria: ["  ", ""] })),
      /acceptance criterion/,
      "blank strings do not count as criteria",
    );

    // An empty lane is the specific failure that made review impossible: the child
    // owns the whole repository, so no diff can be called out-of-lane.
    assert.throws(() => validateHandoff(spec({ laneFiles: [] })), /lane file/);
    assert.throws(() => validateHandoff(spec({ laneFiles: ["  "] })), /lane file/);
  });

  it("rejects a file listed as both in-lane and out-of-lane", () => {
    assert.throws(
      () => validateHandoff(spec({ laneFiles: ["src/a.ts"], outOfLaneFiles: ["src/a.ts"] })),
      /both in-lane and out-of-lane/,
    );
  });

  it("sanitizeScope normalises slugs and refuses the reserved 'global'", () => {
    assert.equal(sanitizeScope("Net-Retry"), "net-retry");
    assert.equal(sanitizeScope("  db_pool!! "), "db-pool");
    assert.throws(() => sanitizeScope("global"), /reserved/);
    assert.throws(() => sanitizeScope(""), /non-empty/);
    assert.throws(() => sanitizeScope("!!!"), /non-empty/);
  });

  it("handoffIdFor is deterministic per scope and distinct across scopes", () => {
    assert.equal(handoffIdFor("net-retry"), handoffIdFor("Net Retry"));
    assert.notEqual(handoffIdFor("net-retry"), handoffIdFor("db-pool"));
    assert.match(handoffIdFor("net-retry"), /^net-retry-[0-9a-f]{8}$/);
  });

  it("the child's document states both escalation routes and never names a sibling", () => {
    const record = { ...validateHandoff(spec()), parentSessionId: "parent-1" };
    const doc = renderHandoffForChild(record);

    assert.match(doc, /# Work handoff: net-retry/);
    assert.match(doc, /## Goal/);
    assert.match(doc, /## Files you own \(your lane\)/);
    assert.match(doc, /## Acceptance criteria/);
    assert.match(doc, /## Do NOT touch/);
    assert.match(doc, /src\/auth\/jwt\.ts/);

    // Rule 3: the ladder is declared, in order, on every handoff.
    assert.match(doc, /## If you are unsure — escalate, never guess/);
    assert.match(doc, /caller_ping/);
    assert.match(doc, /it escalates to the user/);
    assert.match(doc, /You do not contact the user yourself/);
    assert.match(doc, /Never resolve an ambiguity by picking the interpretation/);

    // The child is told its boundary is a write boundary, not a read one.
    assert.match(doc, /Read whatever you need/);
    assert.match(doc, /write only inside your lane/);
  });

  it("a child ticket carries only its own scope, never a sibling's", () => {
    const a = { ...validateHandoff(spec({ scope: "net-retry" })), parentSessionId: "p" };
    const b = {
      ...validateHandoff(
        spec({
          scope: "db-pool",
          goal: "Pool database connections.",
          laneFiles: ["src/db/pool.ts"],
          outOfLaneFiles: [],
        }),
      ),
      parentSessionId: "p",
    };

    const ticketA = buildChildTicket(a, "Implement it in src/net/backoff.ts.");
    const ticketB = buildChildTicket(b, "Implement it in src/db/pool.ts.");

    assert.deepEqual(leakedSiblingScopes(ticketA, "net-retry", ["net-retry", "db-pool"]), []);
    assert.deepEqual(leakedSiblingScopes(ticketB, "db-pool", ["net-retry", "db-pool"]), []);

    // Neither ticket contains the other's scope token or lane path.
    assert.equal(ticketA.includes("db-pool"), false);
    assert.equal(ticketA.includes("src/db/pool.ts"), false);
    assert.equal(ticketB.includes("net-retry"), false);
    assert.equal(ticketB.includes("src/net/client.ts"), false);
  });

  it("leakedSiblingScopes actually detects a leak (the assertion can fail)", () => {
    const leaky = "Scope net-retry, and also remember db-pool is running.";
    assert.deepEqual(leakedSiblingScopes(leaky, "net-retry", ["net-retry", "db-pool"]), ["db-pool"]);
    // Word-boundary matching: a scope embedded in a longer identifier is not a leak.
    assert.deepEqual(leakedSiblingScopes("edit xnet-retry.ts", "other", ["net-retry"]), []);
    assert.deepEqual(leakedSiblingScopes("see net-retrying", "other", ["net-retry"]), []);
    // A bare mention of another scope in a path segment IS a leak — the child was
    // told a name it should never have learned.
    assert.deepEqual(leakedSiblingScopes("edit src/net-retry.ts", "other", ["net-retry"]), ["net-retry"]);
  });

  it("writeHandoff writes a private per-handoff directory and file", () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-test-"));
    try {
      const { record, path } = writeHandoff(root, "parent-1", spec());

      assert.match(path, /parent-1\/handoffs\/net-retry-[0-9a-f]{8}\/spec\.md$/);
      assert.equal(statSync(path).mode & 0o777, 0o600, "spec file is private");
      assert.equal(statSync(join(root, "parent-1", "handoffs", record.id)).mode & 0o777, 0o700, "handoff dir is private");

      const content = readFileSync(path, "utf8");
      assert.match(content, /# Work handoff: net-retry/);

      // The audit copy and the child's ticket are the same document.
      assert.equal(content, renderHandoffForChild(record));

      // One directory per handoff: a sibling's spec is not in this tree.
      const handoffRoot = join(root, "parent-1", "handoffs");
      assert.deepEqual(readdirSync(handoffRoot), [record.id]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-authoring a scope produces the same id so a revision is not a second spec", () => {
    const first = validateHandoff(spec());
    const second = validateHandoff(spec({ goal: "Revised goal." }));
    assert.equal(first.id, second.id);
  });
});
