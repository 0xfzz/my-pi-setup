import test from "node:test";
import assert from "node:assert/strict";

import {
  contractFieldsOf,
  contractFieldsOfRecord,
  mergeHandoffDocument,
  parseHandoffDocument,
} from "../../lib/orchestrator/handoff-document.ts";
import { renderHandoffForChild, validateHandoff, type HandoffRecord } from "../../lib/orchestrator/handoff.ts";
import { structuralChanges } from "../../lib/orchestrator/wave.ts";

const record = (overrides: Partial<HandoffRecord> = {}): HandoffRecord => ({
  ...validateHandoff({
    scope: "net-retry",
    goal: "Add a bounded retry policy to the client",
    acceptanceCriteria: ["retries are capped at 3", "a metric is emitted per attempt"],
    laneFiles: ["src/net/retry.ts"],
    outOfLaneFiles: ["src/net/client.ts"],
    interfaces: ["RetryPolicy.bound: number"],
    guidance: "Follow the existing jitter helper.",
    reportShape: "What changed, and the command you ran.",
    verifyCommand: "npm test",
    vision: "one retry engine",
  }),
  id: "net-retry-12345678",
  artifactId: "handoff-net-retry-12345678",
  parentSessionId: "s",
});

test("the worker-facing document parses back to the record's contract fields", () => {
  const source = record();
  const parsed = parseHandoffDocument(renderHandoffForChild(source));
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.problems.join("; "));
  if (!parsed.ok) return;
  assert.equal(parsed.doc.scope, "net-retry");
  assert.deepEqual(contractFieldsOf(parsed.doc), contractFieldsOfRecord(source));
});

test("prose sections survive the round trip", () => {
  const source = record();
  const parsed = parseHandoffDocument(renderHandoffForChild(source));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.match(parsed.doc.goal, /bounded retry policy/);
  assert.equal(parsed.doc.guidance, "Follow the existing jitter helper.");
  assert.deepEqual(parsed.doc.interfaces, ["RetryPolicy.bound: number"]);
});

test("a handoff without a lane, criteria, or report shape is not a handoff", () => {
  const missingLane = parseHandoffDocument(`# Work handoff: a\n\n## Goal\nDo it.\n\n## Acceptance criteria — each must be evidenced in your report\n1. done\n\n## What to report back\nreport\n`);
  assert.equal(missingLane.ok, false);
  assert.match(missingLane.ok ? "" : missingLane.problems.join("; "), /lane section names no files/);

  const missingCriteria = parseHandoffDocument(`# Work handoff: a\n\n## Goal\nDo it.\n\n## Files you own (your lane)\n- \`src/a.ts\`\n\n## What to report back\nreport\n`);
  assert.equal(missingCriteria.ok, false);
  assert.match(missingCriteria.ok ? "" : missingCriteria.problems.join("; "), /names no criteria/);

  const missingShape = parseHandoffDocument(`# Work handoff: a\n\n## Goal\nDo it.\n\n## Files you own (your lane)\n- \`src/a.ts\`\n\n## Acceptance criteria\n1. done\n`);
  assert.equal(missingShape.ok, false);
});

test("an unsupported or duplicated section is refused, not silently merged", () => {
  const duplicated = parseHandoffDocument(
    `# Work handoff: a\n\n## Goal\none\n\n## Goal\ntwo\n\n## Files you own (your lane)\n- \`src/a.ts\`\n\n## Acceptance criteria\n1. done\n\n## What to report back\nr\n`,
  );
  assert.equal(duplicated.ok, false);
  assert.match(duplicated.ok ? "" : duplicated.problems.join("; "), /two "Goal" sections/);
});

test("merging a parsed document back keeps record-only fields", () => {
  const source = { ...record(), dependsOn: ["db-pool"], designRef: undefined };
  const text = renderHandoffForChild(source).replace("Add a bounded retry policy to the client", "Add a bounded retry policy with a 3-attempt cap to the client");
  const parsed = parseHandoffDocument(text);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const merged = mergeHandoffDocument(source, parsed.doc);
  assert.match(merged.goal, /3-attempt cap/);
  assert.deepEqual(merged.dependsOn, ["db-pool"], "a text patch cannot rewrite a record-only field");
  assert.equal(merged.verifyCommand, "npm test");
  assert.equal(renderHandoffForChild(merged).includes("3-attempt cap"), true);
});

test("a prose fix is not structural; a contract fix is", () => {
  const source = record();
  const prose = parseHandoffDocument(renderHandoffForChild(source).replace("Follow the existing jitter helper.", "Follow the jitter helper in src/util/jitter.ts."));
  assert.equal(prose.ok, true);
  if (!prose.ok) return;
  assert.deepEqual(structuralChanges(contractFieldsOfRecord(source), contractFieldsOf(prose.doc)), []);

  const contract = parseHandoffDocument(renderHandoffForChild(source).replace("- `src/net/retry.ts`", "- `src/net/retry.ts`\n- `src/net/client.ts`"));
  assert.equal(contract.ok, true);
  if (!contract.ok) return;
  assert.deepEqual(structuralChanges(contractFieldsOfRecord(source), contractFieldsOf(contract.doc)), ["lane files"]);
});
