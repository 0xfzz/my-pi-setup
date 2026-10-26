import test from "node:test";
import assert from "node:assert/strict";
import { packSummary, SUMMARY_SEPARATOR } from "../lib/vcc/summary-budget.ts";

const NOTE = "Use `vcc_recall` to search for prior work, decisions, and context from before this summary.";

const core = [
  "[Session Goal]",
  "- Fix src/a.ts without changing public API",
  "",
  "[Files And Changes]",
  "- Modified: src/a.ts",
  "",
  "[Observed Evidence]",
  '- bash "bun test" -> 12 passed, 0 failed',
].join("\n");

const brief = [
  "[user] please fix a.ts (#1)",
  "",
  "[assistant]",
  '* read "src/a.ts" (#2)',
  '* bash "bun test" (#3)',
  "",
  "[user] also keep memory low (#4)",
  "",
  "[assistant]",
  '* edit "src/a.ts" (#5)',
].join("\n");

const full = `${core}${SUMMARY_SEPARATOR}${brief}${SUMMARY_SEPARATOR}${NOTE}`;

test("a summary that already fits is preserved exactly", () => {
  const packed = packSummary(full, { budgetTokens: 10_000, recallNote: NOTE });
  assert.equal(packed.fits, true);
  assert.equal(packed.text, full);
  assert.equal(packed.omittedLines, 0);
  assert.equal(packed.briefDropped, false);
});

test("a tight budget trims the oldest transcript and keeps protected state", () => {
  const budget = 120;
  const packed = packSummary(full, { budgetTokens: budget, recallNote: NOTE });
  assert.ok(packed.tokens <= budget, `packed ${packed.tokens} must fit ${budget}`);
  assert.match(packed.text, /\[Session Goal\]/);
  assert.match(packed.text, /\[Observed Evidence\]/);
  assert.match(packed.text, /also keep memory low|transcript lines omitted/);
  assert.equal(packed.text.split(NOTE).length - 1, 1, "recall note appears exactly once");
  assert.ok(packed.omittedLines > 0);
});

test("the kept transcript never starts mid-section", () => {
  const packed = packSummary(full, { budgetTokens: 130, recallNote: NOTE });
  const briefPart = packed.text.split(SUMMARY_SEPARATOR)[1] ?? "";
  const lines = briefPart.split("\n").filter(Boolean);
  if (lines.length > 1) {
    const firstContent = lines.find((line) => !line.startsWith("...("));
    assert.ok(
      firstContent === undefined || firstContent.startsWith("["),
      `kept transcript must start at a section header, got: ${firstContent}`,
    );
  }
});

test("protected content alone can exceed the budget and is reported, not truncated", () => {
  const packed = packSummary(full, { budgetTokens: 20, recallNote: NOTE });
  assert.equal(packed.fits, false);
  assert.match(packed.text, /\[Session Goal\]/, "mandatory state is never dropped to fit");
  assert.match(packed.text, /\[Observed Evidence\]/);
});

test("a summary without a brief keeps only the protected core and note", () => {
  const packed = packSummary(`${core}${SUMMARY_SEPARATOR}${NOTE}`, {
    budgetTokens: 200,
    recallNote: NOTE,
  });
  assert.equal(packed.fits, true);
  assert.equal(packed.keptLines, 0);
  assert.equal(packed.omittedLines, 0);
  assert.ok(packed.text.endsWith(NOTE));
});

test("a very small transcript allowance drops the brief with an explicit marker", () => {
  const packed = packSummary(full, { budgetTokens: 96, recallNote: NOTE, minBriefTokens: 400 });
  assert.equal(packed.briefDropped, true);
  assert.match(packed.text, /transcript lines omitted; use vcc_recall/);
  assert.match(packed.text, /\[Session Goal\]/);
});

test("merging a previous brief does not duplicate the recall note", () => {
  const twice = `${core}${SUMMARY_SEPARATOR}${brief}${SUMMARY_SEPARATOR}${brief}${SUMMARY_SEPARATOR}${NOTE}`;
  const packed = packSummary(twice, { budgetTokens: 10_000, recallNote: NOTE });
  assert.equal(packed.text.split(NOTE).length - 1, 1);
});
