import test from "node:test";
import assert from "node:assert/strict";
import { sessionHasAssistantOutput } from "../../lib/delegation/child-output.ts";

const line = (entry: unknown) => JSON.stringify(entry);

test("a session with only a prompt and an empty aborted turn has produced no output", () => {
  const jsonl = [
    line({ type: "session", id: "s" }),
    line({ type: "message", message: { role: "user", content: [{ type: "text", text: "do it" }] } }),
    line({ type: "message", message: { role: "assistant", content: [], stopReason: "aborted" } }),
  ].join("\n");
  assert.equal(sessionHasAssistantOutput(jsonl), false);
});

test("an assistant text part counts as output", () => {
  const jsonl = line({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Starting." }] } });
  assert.equal(sessionHasAssistantOutput(jsonl), true);
});

test("an assistant tool call counts as output", () => {
  const jsonl = line({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] } });
  assert.equal(sessionHasAssistantOutput(jsonl), true);
});

test("blank or whitespace-only text is not output, and corrupt lines are skipped", () => {
  const jsonl = ["not json", "", line({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "   " }] } })].join("\n");
  assert.equal(sessionHasAssistantOutput(jsonl), false);
});
