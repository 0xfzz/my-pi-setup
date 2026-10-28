/**
 * Handoff receipts.
 *
 * The ticket asks a child to recall its spec; until this module, nothing verified
 * that it did. These tests pin the two shapes a transcript can arrive in (Pi's
 * message entries and the harness's flat parts), and the rule that an error or a
 * different artifact's recall cannot satisfy the receipt.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  UNREAD_RECEIPT,
  handoffReceiptFromFile,
  handoffReceiptProblem,
  parseHandoffReceipt,
} from "../../lib/orchestrator/handoff-receipt.ts";

const ID = "handoff-core-0d45f5fd";

const call = (callId: string, id: string, at = "2026-01-01T00:00:01.000Z") =>
  JSON.stringify({
    type: "message",
    timestamp: at,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "artifact_recall", arguments: { id } }],
    },
  });

const result = (callId: string, text: string, isError = false) =>
  JSON.stringify({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "artifact_recall",
      isError,
      content: [{ type: "text", text }],
    },
  });

const header = (id = ID, version = 2) => `=== Artifact: [${id}] "Handoff: core — build it" (v${version}, spec, 8.5 KB) ===`;
const body = "=== End of artifact ===\n# Work handoff: core\n## Goal\nBuild it.";

test("a successful recall of the handoff id is a receipt, with the version read", () => {
  const receipt = parseHandoffReceipt([call("c1", ID), result("c1", `${header()}\n${body}`)].join("\n"), ID);
  assert.equal(receipt.read, true);
  assert.equal(receipt.version, 2);
  assert.equal(receipt.calls, 1);
  assert.equal(receipt.inspected, true);
  assert.equal(receipt.firstReadAt, "2026-01-01T00:00:01.000Z");
});

test("a transcript with no recall at all is inspected but not read", () => {
  const receipt = parseHandoffReceipt(result("c1", "unrelated"), ID);
  assert.equal(receipt.read, false);
  assert.equal(receipt.inspected, true);
});

test("a recall of a different artifact does not satisfy the receipt", () => {
  const other = "handoff-list-a330395c";
  const receipt = parseHandoffReceipt([call("c1", other), result("c1", `${header(other)}\n${body}`)].join("\n"), ID);
  assert.equal(receipt.read, false);
  assert.equal(receipt.calls, 0);
});

test("a failed recall does not satisfy the receipt, even with the right id", () => {
  const receipt = parseHandoffReceipt(
    [call("c1", ID), result("c1", `artifact_recall failed: no artifact [${ID}]`, true)].join("\n"),
    ID,
  );
  assert.equal(receipt.read, false);
  assert.equal(receipt.calls, 1, "the attempt is visible, but it is not a read");
});

test("a result must belong to the matching call, not just mention the id", () => {
  // The child recalls artifact A, and the transcript separately mentions the
  // handoff id in prose. The prose must not become a receipt.
  const receipt = parseHandoffReceipt(
    [call("c1", "some-other-artifact"), result("c1", `I did not read ${ID} but here is its name`)].join("\n"),
    ID,
  );
  assert.equal(receipt.read, false);
});

test("the flat harness shape is understood too", () => {
  const transcript = [
    JSON.stringify({ type: "toolCall", id: "h1", name: "artifact_recall", arguments: { id: ID } }),
    JSON.stringify({ type: "toolResult", toolCallId: "h1", toolName: "artifact_recall", isError: false, content: [{ type: "text", text: `${header(ID, 1)}\n${body}` }] }),
  ].join("\n");
  const receipt = parseHandoffReceipt(transcript, ID);
  assert.equal(receipt.read, true);
  assert.equal(receipt.version, 1);
});

test("a missing transcript is unverifiable, which is not the same as 'did not read'", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handoff-receipt-"));
  try {
    assert.equal(handoffReceiptFromFile(join(dir, "absent.jsonl"), ID), UNREAD_RECEIPT);
    assert.equal(handoffReceiptFromFile(undefined, ID), UNREAD_RECEIPT);
    assert.equal(handoffReceiptFromFile(join(dir, "absent.jsonl"), ID).inspected, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the refusal names the artifact and distinguishes unverifiable from unread", () => {
  const unread = handoffReceiptProblem({
    scope: "core",
    artifactId: ID,
    receipt: { read: false, version: null, calls: 0, inspected: true },
    action: "check",
  });
  assert.match(unread!, /never recalled the handoff spec/);
  assert.match(unread!, new RegExp(ID));
  assert.match(unread!, /gate is closed/);

  const unverifiable = handoffReceiptProblem({
    scope: "core",
    artifactId: ID,
    receipt: UNREAD_RECEIPT,
    action: "approve",
  });
  assert.match(unverifiable!, /transcript is not on disk/);

  assert.equal(
    handoffReceiptProblem({ scope: "core", artifactId: ID, receipt: { read: true, version: 1, calls: 1, inspected: true }, action: "approve" }),
    undefined,
  );
});

test("a partial read (offset/limit) still counts: the header proves the artifact was opened", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handoff-receipt-"));
  const file = join(dir, "child.jsonl");
  try {
    await writeFile(file, [
      call("c1", ID),
      result("c1", `${header()}\n   1│ # Work handoff: core\n   2│ ## Goal`),
    ].join("\n"));
    const receipt = handoffReceiptFromFile(file, ID);
    assert.equal(receipt.read, true);
    assert.equal(receipt.version, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
