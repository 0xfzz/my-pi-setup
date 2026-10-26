import test from "node:test";
import assert from "node:assert/strict";

import {
  CHILD_PREFIX,
  MAIN_PREFIX,
  isStampedName,
  planStamp,
  readSessionFacts,
  stampSessionText,
} from "../lib/session-stamp.ts";

/**
 * Kind is proven, label is written.
 *
 * The picker shows `session.name ?? session.firstMessage`, so an unstamped child
 * is indistinguishable from a conversation the user opened — which is the whole
 * complaint. These tests pin both halves: which files count as children, and the
 * single `session_info` entry that makes them read as children.
 */

const header = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "session", version: 3, id: "01a173c3-aaaa", timestamp: "2026-10-25T15:52:32.756Z", cwd: "/tmp", ...extra });

const userMessage = (text: string, id = "m1") =>
  JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-10-25T15:52:33.000Z", message: { role: "user", content: [{ type: "text", text }] } });

const assistantMessage = (id = "a1", parentId = "m1") =>
  JSON.stringify({ type: "message", id, parentId, timestamp: "2026-10-25T15:52:34.000Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });

const lines = (...parts: string[]) => `${parts.join("\n")}\n`;

const CHILD_TICKET = "Complete your task autonomously.\n\nYou did not inherit your parent's conversation. If the task depends on context you do not have — a decision the parent made — call orch_parent_recall.\n\nAudit the retry policy in src/net/retry.ts.";

test("a header parentSession proves a child, with no other signal", () => {
  const facts = readSessionFacts(lines(header({ parentSession: "/sessions/parent.jsonl" }), userMessage("please look at this")));
  assert.equal(facts.kind, "child");
  assert.equal(facts.evidence, "header");
  assert.equal(facts.parentSession, "/sessions/parent.jsonl");
});

test("the spawn ticket proves a child even without a parentSession header", () => {
  // This is the common case in the real store: 72 of 107 children had no parent
  // recorded, so they appeared as top-level entries in `pi --resume`.
  const facts = readSessionFacts(lines(header(), userMessage(CHILD_TICKET)));
  assert.equal(facts.kind, "child");
  assert.equal(facts.evidence, "ticket");
  assert.equal(facts.parentSession, undefined);
});

test("both signals are reported as both, not collapsed", () => {
  const facts = readSessionFacts(lines(header({ parentSession: "/p.jsonl" }), userMessage(CHILD_TICKET)));
  assert.equal(facts.evidence, "header+ticket");
});

test("a subagent-context entry supplies the parent when the header lacks it", () => {
  const provenance = JSON.stringify({
    type: "custom", id: "c1", parentId: null, timestamp: "2026-10-25T15:52:33.000Z",
    customType: "subagent-context:v1", data: { mode: "digest", parentSession: "/sessions/parent.jsonl" },
  });
  const facts = readSessionFacts(lines(header(), provenance, userMessage("do the thing")));
  assert.equal(facts.kind, "child");
  assert.equal(facts.parentSession, "/sessions/parent.jsonl");
});

test("an ordinary conversation is main, and a quoted ticket does not make it a child", () => {
  const main = readSessionFacts(lines(header(), userMessage("can you fix the router extension?")));
  assert.equal(main.kind, "main");
  assert.equal(main.evidence, "none");
  // Mentioning the marker in prose is not a spawn ticket.
  const quoted = readSessionFacts(lines(header(), userMessage("why does my child session say Complete your task autonomously.")));
  assert.equal(quoted.kind, "child", "the marker is the ticket; a quotation is indistinguishable and costs only a label");
});

test("the label leads with the kind and keeps the task, not the wrapper", () => {
  const facts = readSessionFacts(lines(header(), userMessage(CHILD_TICKET)));
  const plan = planStamp(facts);
  assert.equal(plan.action, "stamp");
  assert.ok(plan.name!.startsWith(`${CHILD_PREFIX} · `), plan.name);
  assert.ok(plan.name!.includes("Audit the retry policy"), plan.name);
  assert.ok(plan.name!.length <= `${CHILD_PREFIX} · `.length + 64, `label too long: ${plan.name}`);
  assert.equal(/\n/.test(plan.name!), false, "a name is one line");
});

test("main sessions are left alone unless asked, and never renamed blind", () => {
  const main = readSessionFacts(lines(header(), userMessage("can you fix the router extension?")));
  assert.equal(planStamp(main).action, "skip");
  assert.equal(planStamp(main, { includeMain: true }).name, `${MAIN_PREFIX} · can you fix the router extension?`);

  const named = readSessionFacts(lines(
    header(),
    userMessage("hello"),
    JSON.stringify({ type: "session_info", id: "s1", parentId: "m1", timestamp: "2026-10-25T15:53:00.000Z", name: "work I care about" }),
  ));
  const kept = planStamp(named, { includeMain: true });
  assert.equal(kept.action, "keep");
  assert.equal(kept.reason, "has a user-set name");
  assert.equal(planStamp(named, { includeMain: true, force: true }).action, "update");
});

test("stamping is idempotent and produces one valid session_info entry", () => {
  const original = lines(header({ parentSession: "/p.jsonl" }), userMessage(CHILD_TICKET), assistantMessage());
  const first = stampSessionText(original);
  assert.equal(first.plan.action, "stamp");
  const appended = first.text.trimEnd().split("\n").at(-1)!;
  const entry = JSON.parse(appended);
  assert.equal(entry.type, "session_info");
  assert.equal(entry.name, first.plan.name);
  // It attaches to the last entry so it lands on the active branch the picker reads.
  assert.equal(entry.parentId, "a1");
  assert.match(entry.id, /^[0-9a-f]{8}$/);
  assert.equal(first.text.split("\n").filter((line) => line.includes('"session_info"')).length, 1);

  const second = stampSessionText(first.text);
  assert.equal(second.plan.action, "keep");
  assert.equal(second.text, first.text, "a stamped session is not rewritten");
});

test("a truncated last line does not hide the facts", () => {
  const truncated = lines(header({ parentSession: "/p.jsonl" }), userMessage(CHILD_TICKET)) + '{"type":"message","id":"x","mess';
  const facts = readSessionFacts(truncated);
  assert.equal(facts.kind, "child");
  assert.equal(facts.leafId, "m1", "the unreadable tail is skipped, not counted as the leaf");
});

test("a stamped name is recognised so a re-run can update instead of duplicating", () => {
  assert.equal(isStampedName(`${CHILD_PREFIX} · audit the retry policy`), true);
  assert.equal(isStampedName(`${MAIN_PREFIX} · fix the router`), true);
  assert.equal(isStampedName("my own session name"), false);
  assert.equal(isStampedName(undefined), false);
});
