/**
 * Evidence retention.
 *
 * The stock VCC brief keeps tool-call names and error bodies but drops the text
 * of successful tool results. For a research or debugging session that is
 * exactly the information the next turns need ("what did the page say", "which
 * tests passed", "what did the query return"). This module extracts a bounded,
 * de-duplicated set of observations from the messages being summarized so the
 * compacted request still carries findings, not just activity.
 */

import { DEFAULT_CHARS_PER_TOKEN, estimateTextTokens } from "./estimate.ts";

const MAX_DETAIL_CHARS = 160;
const MAX_TARGET_CHARS = 60;

export interface EvidenceLine {
  tool: string;
  target?: string;
  detail: string;
  isError: boolean;
}

export interface EvidenceOptions {
  maxTokens: number;
  charsPerToken?: number;
  /** Hard cap on retained observations. */
  maxItems?: number;
}

export interface EvidenceExtraction {
  /** Empty string when nothing useful was found. */
  section: string;
  tokens: number;
  items: number;
  candidates: number;
  omitted: number;
}

export const EVIDENCE_HEADER = "[Observed Evidence]";
const EMPTY_SECTION: EvidenceExtraction = {
  section: "",
  tokens: 0,
  items: 0,
  candidates: 0,
  omitted: 0,
};

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

/** Flatten tool-result content into plain text. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record && typeof record.text === "string") parts.push(record.text);
  }
  return parts.join("\n");
}

const STRUCTURAL_NOISE_RE =
  /^(?:\(no output\)|<[^>]*>|[-=_*~#]{3,}|```.*|\{|\}|\[|\])$/;

const meaningfulLines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !STRUCTURAL_NOISE_RE.test(line));

/**
 * Pick the line that best represents a tool result.
 * Errors keep their message; successful output keeps its first meaningful line
 * plus a size hint, which is enough to know what is retrievable.
 */
export function summarizeObservation(text: string, isError: boolean): string | undefined {
  const lines = meaningfulLines(text);
  if (lines.length === 0) return undefined;
  const first = clip(lines[0], MAX_DETAIL_CHARS);
  const suffix = lines.length > 3 ? ` (+${lines.length - 1} lines)` : "";
  return isError ? `FAILED: ${first}${suffix}` : `${first}${suffix}`;
}

const TARGET_FIELDS = [
  "path",
  "file_path",
  "filePath",
  "command",
  "pattern",
  "query",
  "url",
  "name",
  "description",
];

function targetOf(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) return undefined;
  for (const field of TARGET_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) return clip(value, MAX_TARGET_CHARS);
  }
  return undefined;
}

interface ToolCallInfo {
  name: string;
  target?: string;
}

function collectToolCalls(messages: readonly unknown[]): Map<string, ToolCallInfo> {
  const calls = new Map<string, ToolCallInfo>();
  for (const message of messages) {
    const record = asRecord(message);
    if (!record || record.role !== "assistant" || !Array.isArray(record.content)) continue;
    for (const block of record.content) {
      const item = asRecord(block);
      if (!item || item.type !== "toolCall") continue;
      const id = typeof item.id === "string" ? item.id : undefined;
      if (!id) continue;
      const name = typeof item.name === "string" ? item.name : "tool";
      calls.set(id, { name, target: targetOf(item.arguments) });
    }
  }
  return calls;
}

function formatLine(line: EvidenceLine): string {
  const target = line.target ? ` "${line.target}"` : "";
  return `- ${line.tool}${target} -> ${line.detail}`;
}

/**
 * Extract a bounded evidence section from the messages being summarized.
 * Selection is recency-biased: when the budget is tight the most recent
 * observations survive, because those are the ones the next turn builds on.
 */
export function extractEvidence(
  messages: readonly unknown[],
  options: EvidenceOptions,
): EvidenceExtraction {
  const maxTokens = Math.floor(options.maxTokens);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return EMPTY_SECTION;
  const charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const maxItems = Math.max(1, options.maxItems ?? 16);

  const calls = collectToolCalls(messages);
  const candidates: EvidenceLine[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    const record = asRecord(message);
    if (!record || record.role !== "toolResult") continue;
    const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : undefined;
    const call = toolCallId ? calls.get(toolCallId) : undefined;
    const tool =
      call?.name ?? (typeof record.toolName === "string" && record.toolName ? record.toolName : "tool");
    const isError = record.isError === true;
    const detail = summarizeObservation(toolResultText(record.content), isError);
    if (!detail) continue;
    const key = `${tool}\u0000${call?.target ?? ""}\u0000${detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ tool, target: call?.target, detail, isError });
  }

  if (candidates.length === 0) return EMPTY_SECTION;

  const headerTokens = estimateTextTokens(EVIDENCE_HEADER, charsPerToken);
  const selected: EvidenceLine[] = [];
  let used = headerTokens;
  let omitted = 0;

  for (let i = candidates.length - 1; i >= 0; i--) {
    if (selected.length >= maxItems) {
      omitted++;
      continue;
    }
    const line = candidates[i];
    const lineTokens = estimateTextTokens(formatLine(line), charsPerToken) + 1;
    if (used + lineTokens > maxTokens) {
      omitted++;
      continue;
    }
    used += lineTokens;
    selected.push(line);
  }

  if (selected.length === 0) return EMPTY_SECTION;
  selected.reverse();

  const lines = selected.map(formatLine);
  if (omitted > 0) {
    lines.push(`- (${omitted} earlier observations omitted; use vcc_recall)`);
  }
  const section = [EVIDENCE_HEADER, ...lines].join("\n");

  return {
    section,
    tokens: estimateTextTokens(section, charsPerToken),
    items: selected.length,
    candidates: candidates.length,
    omitted,
  };
}

/**
 * Insert the evidence section after the structured summary headers and before
 * the brief transcript, so it is protected by the summary packer and stays
 * near the top of the compacted context.
 */
export function insertEvidence(summary: string, section: string, separator: string): string {
  if (!section.trim()) return summary;
  const index = findBriefStart(summary, separator);
  if (index < 0) {
    const trimmed = summary.trimEnd();
    return trimmed ? `${trimmed}\n\n${section}` : section;
  }
  const core = summary.slice(0, index).trimEnd();
  const tail = summary.slice(index);
  return core ? `${core}\n\n${section}${separator}${tail}` : `${section}${separator}${tail}`;
}

const BRIEF_START_PART_RE = /^(?:\[(?:user|assistant|tool_error)\]|\.\.\.\()/;

/** Index of the first brief transcript part, or -1 when the text has none. */
export function findBriefStart(text: string, separator: string): number {
  let offset = 0;
  for (const part of text.split(separator)) {
    if (BRIEF_START_PART_RE.test(part.trimStart())) return offset;
    offset += part.length + separator.length;
  }
  return -1;
}
