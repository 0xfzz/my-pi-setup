import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EscalationError,
  EscalationLedger,
  type Escalation,
} from "../../lib/delegation/escalation.ts";

const open = (ledger: EscalationLedger, over: Partial<Parameters<EscalationLedger["open"]>[0]> = {}) =>
  ledger.open({
    id: "esc-1",
    childId: "child-1",
    childName: "NetWorker",
    scope: "net-retry",
    sessionFile: "/tmp/sessions/child-1.jsonl",
    question: "Should the backoff cap be 30s or 60s?",
    ...over,
  });

describe("escalation ladder", () => {
  it("a child's question starts addressed to the parent", () => {
    const ledger = new EscalationLedger();
    const escalation = open(ledger);

    assert.equal(escalation.stage, "parent");
    assert.equal(escalation.answeredBy, undefined);
    assert.deepEqual(ledger.forParent().map((e) => e.id), ["esc-1"]);
    assert.deepEqual(ledger.forUser(), []);
    assert.deepEqual(ledger.settled(), []);
  });

  it("rejects an empty question", () => {
    const ledger = new EscalationLedger();
    assert.throws(() => open(ledger, { question: "   " }), /needs a question/);
  });

  // Rule 3, first rung: the parent knows, so it answers and the child resumes.
  it("the parent answers from its own context", () => {
    const ledger = new EscalationLedger();
    open(ledger);

    const answered = ledger.answerAsParent("esc-1", "Cap at 60s.");
    assert.equal(answered.stage, "answered");
    assert.equal(answered.answeredBy, "parent");
    assert.equal(answered.answer, "Cap at 60s.");
    assert.deepEqual(ledger.forParent(), []);

    const message = ledger.resumeMessage("esc-1");
    assert.match(message, /decided by the parent/);
    assert.match(message, /Cap at 60s\./);
    assert.match(message, /Apply this decision and continue/);
  });

  // Rule 3, second rung: the parent does not know, so the user decides.
  it("the parent escalates to the user, who answers", () => {
    const ledger = new EscalationLedger();
    open(ledger);

    const escalated = ledger.escalateToUser("esc-1", "Both caps are defensible; this is a product decision.");
    assert.equal(escalated.stage, "user");
    assert.match(escalated.history.at(-1)!.note!, /Both caps are defensible/);
    assert.deepEqual(ledger.forUser().map((e) => e.id), ["esc-1"]);
    assert.deepEqual(ledger.forParent(), []);

    const answered = ledger.answerAsUser("esc-1", "60s.");
    assert.equal(answered.stage, "answered");
    assert.equal(answered.answeredBy, "user");
    assert.match(ledger.resumeMessage("esc-1"), /decided by the user/);
  });

  it("escalating to the user requires a reason", () => {
    const ledger = new EscalationLedger();
    open(ledger);
    assert.throws(() => ledger.escalateToUser("esc-1", "  "), /needs a reason/);
    assert.equal(ledger.get("esc-1")!.stage, "parent");
  });

  // The authority rule: a question escalated BECAUSE the parent was not
  // competent must not be answered by the parent afterwards.
  it("the parent cannot answer a question it already escalated", () => {
    const ledger = new EscalationLedger();
    open(ledger);
    ledger.escalateToUser("esc-1", "Not my call.");

    assert.throws(() => ledger.answerAsParent("esc-1", "Actually 30s."), /cannot answer a question it already escalated/);
    assert.equal(ledger.get("esc-1")!.stage, "user");
  });

  // A cancelled dialog is never consent. This is the defect that let a paused child
  // be resumed with a fabricated decision.
  it("a blank or cancelled user answer is CANCELLED, not approved", () => {
    const ledger = new EscalationLedger();
    open(ledger);
    ledger.escalateToUser("esc-1", "Needs a human.");

    const cancelled = ledger.answerAsUser("esc-1", "   ");
    assert.equal(cancelled.stage, "cancelled");
    assert.equal(cancelled.answer, undefined);

    const message = ledger.resumeMessage("esc-1");
    assert.match(message, /NOT answered/);
    assert.match(message, /NOT approval/);
    assert.match(message, /Stop this line of work and report the blocker/);
    assert.match(message, /Do not pick an interpretation and continue/);
  });

  it("an empty parent answer is also treated as unanswered", () => {
    const ledger = new EscalationLedger();
    open(ledger);
    assert.equal(ledger.answerAsParent("esc-1", "   ").stage, "cancelled");
  });

  it("explicit cancel records that it is not consent", () => {
    const ledger = new EscalationLedger();
    open(ledger);
    const cancelled = ledger.cancel("esc-1", "Child should report the blocker instead.");
    assert.equal(cancelled.stage, "cancelled");
    assert.match(cancelled.history.at(-1)!.note!, /not consent/);
    assert.match(cancelled.history.at(-1)!.note!, /Child should report the blocker/);
  });

  // A settled decision is not renegotiated.
  it("an answered escalation cannot be answered or cancelled again", () => {
    const ledger = new EscalationLedger();
    open(ledger);
    ledger.answerAsParent("esc-1", "60s.");

    assert.throws(() => ledger.answerAsParent("esc-1", "30s."), /already answered/);
    assert.throws(() => ledger.answerAsUser("esc-1", "30s."), /already answered/);
    assert.throws(() => ledger.cancel("esc-1", "changed my mind"), /already answered/);
    assert.equal(ledger.get("esc-1")!.answer, "60s.");
  });

  // No answer exists to deliver while the question is still open, so resuming must
  // refuse rather than send an empty resume.
  it("resuming an unresolved escalation throws instead of sending nothing", () => {
    const ledger = new EscalationLedger();
    open(ledger);
    assert.throws(() => ledger.resumeMessage("esc-1"), /still parent/);

    ledger.escalateToUser("esc-1", "Needs a human.");
    assert.throws(() => ledger.resumeMessage("esc-1"), /still user/);
  });

  it("an unknown escalation id is refused everywhere", () => {
    const ledger = new EscalationLedger();
    assert.throws(() => ledger.answerAsParent("nope", "x"), EscalationError);
    assert.throws(() => ledger.resumeMessage("nope"), /No escalation/);
    assert.equal(ledger.get("nope"), undefined);
  });

  it("history records every stage transition in order", () => {
    const ledger = new EscalationLedger();
    open(ledger);
    ledger.escalateToUser("esc-1", "Needs a human.");
    ledger.answerAsUser("esc-1", "60s.");

    const stages = ledger.get("esc-1")!.history.map((h) => h.stage);
    assert.deepEqual(stages, ["parent", "user", "answered"]);
    const actors = ledger.get("esc-1")!.history.map((h) => h.actor);
    assert.deepEqual(actors, ["child", "parent", "user"]);
  });

  it("queues are disjoint: a settled question is on neither waiting list", () => {
    const ledger = new EscalationLedger();
    open(ledger, { id: "esc-a" });
    open(ledger, { id: "esc-b", scope: "db-pool" });
    ledger.answerAsParent("esc-a", "60s.");
    ledger.escalateToUser("esc-b", "Product decision.");

    assert.deepEqual(ledger.forParent(), []);
    assert.deepEqual(ledger.forUser().map((e: Escalation) => e.id), ["esc-b"]);
    assert.deepEqual(ledger.settled().map((e: Escalation) => e.id), ["esc-a"]);
  });

  it("filters by child so a multi-child parent can report per work unit", () => {
    const ledger = new EscalationLedger();
    open(ledger, { id: "esc-a", childId: "child-1" });
    open(ledger, { id: "esc-b", childId: "child-2" });
    assert.deepEqual(ledger.forChild("child-1").map((e) => e.id), ["esc-a"]);
  });
});

it("a repeated poll with no new events is detectable, and the contract ends the turn", async () => {
  const { notePoll, resetPollFingerprints, RETRIGGER_CONTRACT } = await import("../../extensions/agent.ts");
  resetPollFingerprints();
  assert.equal(notePoll("session-a", "running", "same"), false, "the first poll is answered");
  assert.equal(notePoll("session-a", "running", "same"), true, "an identical repeat is refused");
  assert.equal(notePoll("session-a", "running", "changed"), false, "a real change is answered");
  assert.match(RETRIGGER_CONTRACT, /Do not poll or sleep/);
  resetPollFingerprints();
});
