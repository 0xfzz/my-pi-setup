import test from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_HEADER,
  extractEvidence,
  findBriefStart,
  insertEvidence,
  summarizeObservation,
} from "../lib/vcc/evidence.ts";

const SEP = "\n\n---\n\n";

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp: 0 };
}

function toolResult(id: string, name: string, text: string, isError = false) {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    isError,
    content: [{ type: "text", text }],
    timestamp: 0,
  };
}

test("successful observations are retained, not only errors", () => {
  const messages = [
    toolCall("t1", "read", { path: "src/a.ts" }),
    toolResult("t1", "read", "export function foo() {\n  return 1;\n}"),
    toolCall("t2", "bash", { command: "bun test tests/a.test.ts" }),
    toolResult("t2", "bash", "12 passed, 0 failed"),
    toolCall("t3", "read", { path: "missing.ts" }),
    toolResult("t3", "read", "ENOENT: no such file or directory", true),
  ];
  const evidence = extractEvidence(messages, { maxTokens: 400 });
  assert.ok(evidence.section.startsWith(EVIDENCE_HEADER), evidence.section);
  assert.match(evidence.section, /read "src\/a\.ts"/);
  assert.match(evidence.section, /12 passed, 0 failed/);
  assert.match(evidence.section, /FAILED: ENOENT/);
  assert.equal(evidence.items, 3);
  assert.ok(evidence.tokens <= 400);
});

test("identical observations are de-duplicated", () => {
  const messages = [
    toolCall("t1", "bash", { command: "git status" }),
    toolResult("t1", "bash", "nothing to commit"),
    toolCall("t2", "bash", { command: "git status" }),
    toolResult("t2", "bash", "nothing to commit"),
  ];
  const evidence = extractEvidence(messages, { maxTokens: 400 });
  assert.equal(evidence.items, 1);
  assert.equal(evidence.candidates, 1);
});

test("empty and placeholder output is skipped entirely", () => {
  const messages = [
    toolCall("t1", "bash", { command: "true" }),
    toolResult("t1", "bash", "(no output)"),
    toolCall("t2", "bash", { command: "sleep 1" }),
    toolResult("t2", "bash", ""),
  ];
  const evidence = extractEvidence(messages, { maxTokens: 400 });
  assert.equal(evidence.section, "");
  assert.equal(evidence.items, 0);
});

test("a tight budget keeps recent observations and reports omissions", () => {
  const messages: unknown[] = [];
  for (let i = 0; i < 12; i++) {
    messages.push(toolCall(`t${i}`, "bash", { command: `step ${i}` }));
    messages.push(toolResult(`t${i}`, "bash", `distinct result number ${i} with detail`));
  }
  const evidence = extractEvidence(messages, { maxTokens: 120, maxItems: 20 });
  assert.ok(evidence.tokens <= 120, `section ${evidence.tokens} must stay within budget`);
  assert.ok(evidence.items > 0 && evidence.items < 12, "some observations are dropped");
  assert.match(evidence.section, /earlier observations omitted/);
  assert.match(evidence.section, /result number 11/, "newest observation survives");
});

test("maxItems caps retention even with a large budget", () => {
  const messages: unknown[] = [];
  for (let i = 0; i < 20; i++) {
    messages.push(toolCall(`t${i}`, "read", { path: `f${i}.ts` }));
    messages.push(toolResult(`t${i}`, "read", `contents ${i}`));
  }
  const evidence = extractEvidence(messages, { maxTokens: 10_000, maxItems: 3 });
  assert.equal(evidence.items, 3);
});

test("observation summaries prefer the first meaningful line", () => {
  assert.equal(summarizeObservation("\n\n<thinking>\nfound it", false), "found it");
  assert.equal(summarizeObservation("a\nb\nc\nd\ne", false), "a (+4 lines)");
  assert.equal(summarizeObservation("boom", true), "FAILED: boom");
  assert.equal(summarizeObservation("   \n\n", false), undefined);
});

test("evidence is inserted ahead of the brief transcript", () => {
  const summary = `[Session Goal]\n- fix a.ts${SEP}[user] do it (#1)\n[assistant]\n* read "a.ts" (#2)`;
  const merged = insertEvidence(summary, `[Observed Evidence]\n- bash "test" -> ok`, SEP);
  assert.ok(merged.indexOf("[Observed Evidence]") < merged.indexOf("[user]"));
  assert.equal(findBriefStart(merged, SEP), merged.indexOf("[user]"));
  assert.equal(insertEvidence(summary, "", SEP), summary, "empty evidence is a no-op");
  assert.equal(insertEvidence("[Session Goal]\n- x", "[Observed Evidence]\n- y", SEP),
    "[Session Goal]\n- x\n\n[Observed Evidence]\n- y");
});
