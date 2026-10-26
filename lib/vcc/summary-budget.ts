/**
 * Summary packing under a token budget.
 *
 * The stock VCC summary is capped by line count (120 transcript lines) and by
 * segmented word counts, not by model tokens. That is not a budget: one line can
 * be arbitrarily expensive, and the result is fine on a 1M-token model while
 * eating a quarter of an 8K model's window. This module enforces a real budget.
 *
 * Structured header sections (goal, files, signals, evidence, recall note) are
 * *protected*: they are what stops the agent from re-deriving state. Only the
 * transcript tail is elastic, and it is trimmed oldest-first because the most
 * recent lines are the ones the next turn continues from.
 */

import { DEFAULT_CHARS_PER_TOKEN, estimateTextTokens } from "./estimate.ts";

export const SUMMARY_SEPARATOR = "\n\n---\n\n";

const BRIEF_PART_RE = /^(?:\[(?:user|assistant|tool_error)\]|\.\.\.\()/;
// A section starts with a bracketed label: `[user]`, `[tool_error] bash (#5)`,
// `[Session Goal]`, `[Observed Evidence]`. Body lines rarely begin that way, and
// treating inline refs as part of the header keeps whole sections intact.
const SECTION_HEADER_RE = /^\[[A-Za-z][^\]]*\]/;

export interface PackSummaryOptions {
  budgetTokens: number;
  /** Recall note appended by the compiler. Kept verbatim when it is a suffix. */
  recallNote?: string;
  charsPerToken?: number;
  /** Below this, the transcript is dropped entirely instead of kept as a stub. */
  minBriefTokens?: number;
}

export interface PackedSummary {
  text: string;
  tokens: number;
  /** True when the packed text fits the budget. */
  fits: boolean;
  /** Tokens of the non-elastic part (headers, evidence, recall note). */
  protectedTokens: number;
  keptLines: number;
  omittedLines: number;
  briefDropped: boolean;
}

const DEFAULT_MIN_BRIEF_TOKENS = 48;

function splitRecallNote(
  text: string,
  recallNote: string | undefined,
): { body: string; note: string } {
  if (!recallNote) return { body: text, note: "" };
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(recallNote)) return { body: trimmed, note: "" };
  const body = trimmed
    .slice(0, trimmed.length - recallNote.length)
    .replace(/\s*(?:\n\n---\n\n)?\s*$/, "")
    .trimEnd();
  return { body, note: recallNote };
}

function splitCoreAndBrief(body: string): { core: string; brief: string } {
  const parts = body.split(SUMMARY_SEPARATOR);
  const index = parts.findIndex((part) => BRIEF_PART_RE.test(part.trimStart()));
  if (index < 0) return { core: body.trim(), brief: "" };
  return {
    core: parts.slice(0, index).join(SUMMARY_SEPARATOR).trim(),
    brief: parts.slice(index).join(SUMMARY_SEPARATOR).trim(),
  };
}

/**
 * Trim the transcript tail to fit `budget`.
 * Drops whole leading sections so the kept text never starts mid-section.
 */
function packBrief(
  brief: string,
  budget: number,
  charsPerToken: number,
): { text: string; keptLines: number; omittedLines: number } {
  const lines = brief.split("\n");
  const total = lines.length;
  if (budget <= 0) return { text: "", keptLines: 0, omittedLines: total };

  let used = 0;
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = estimateTextTokens(lines[i], charsPerToken) + 1;
    if (used + cost > budget) break;
    used += cost;
    start = i;
  }

  // Never begin mid-section: advance to the next section header.
  while (start < lines.length && !SECTION_HEADER_RE.test(lines[start].trim())) start++;

  if (start >= lines.length) return { text: "", keptLines: 0, omittedLines: total };

  const kept = lines.slice(start);
  const omitted = start;
  const marker =
    omitted > 0 ? `...(${omitted} earlier transcript lines omitted; use vcc_recall)` : "";
  const text = marker ? `${marker}\n${kept.join("\n")}` : kept.join("\n");
  return { text, keptLines: kept.length, omittedLines: omitted };
}

/**
 * Enforce a token budget on a compiled summary.
 * Returns `fits: false` when the protected sections alone exceed the budget;
 * callers must treat that as "compaction would not reduce context" rather than
 * silently dropping mandatory state.
 */
export function packSummary(summary: string, options: PackSummaryOptions): PackedSummary {
  const charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const budget = Math.floor(options.budgetTokens);
  const minBrief = options.minBriefTokens ?? DEFAULT_MIN_BRIEF_TOKENS;

  const { body, note } = splitRecallNote(summary, options.recallNote);
  const { core, brief } = splitCoreAndBrief(body);

  // Always re-append the recall hint: it may arrive already present, or the
  // compiler may have produced a summary without it. Exactly one is kept.
  const finalNote = options.recallNote ?? note;

  const noteBlock = finalNote ? `${SUMMARY_SEPARATOR}${finalNote}` : "";
  const coreTokens = estimateTextTokens(core, charsPerToken);
  const noteTokens = estimateTextTokens(noteBlock, charsPerToken);
  const protectedTokens = coreTokens + noteTokens;

  if (!brief) {
    const text = `${core}${noteBlock}`;
    const tokens = estimateTextTokens(text, charsPerToken);
    return {
      text,
      tokens,
      fits: tokens <= budget,
      protectedTokens,
      keptLines: 0,
      omittedLines: 0,
      briefDropped: false,
    };
  }

  const available = budget - protectedTokens - estimateTextTokens(SUMMARY_SEPARATOR, charsPerToken);
  if (available < minBrief) {
    const marker = `...(${brief.split("\n").length} transcript lines omitted; use vcc_recall)`;
    const text = `${core}${SUMMARY_SEPARATOR}${marker}${noteBlock}`;
    const tokens = estimateTextTokens(text, charsPerToken);
    return {
      text,
      tokens,
      fits: tokens <= budget,
      protectedTokens,
      keptLines: 0,
      omittedLines: brief.split("\n").length,
      briefDropped: true,
    };
  }

  const packed = packBrief(brief, available, charsPerToken);
  if (!packed.text) {
    const marker = `...(${brief.split("\n").length} transcript lines omitted; use vcc_recall)`;
    const text = `${core}${SUMMARY_SEPARATOR}${marker}${noteBlock}`;
    const tokens = estimateTextTokens(text, charsPerToken);
    return {
      text,
      tokens,
      fits: tokens <= budget,
      protectedTokens,
      keptLines: 0,
      omittedLines: brief.split("\n").length,
      briefDropped: true,
    };
  }

  const text = `${core}${SUMMARY_SEPARATOR}${packed.text}${noteBlock}`;
  const tokens = estimateTextTokens(text, charsPerToken);
  return {
    text,
    tokens,
    fits: tokens <= budget,
    protectedTokens,
    keptLines: packed.keptLines,
    omittedLines: packed.omittedLines,
    briefDropped: false,
  };
}
