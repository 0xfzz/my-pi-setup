/**
 * Conservative token estimation for context budgeting.
 *
 * Pi's own estimator uses `chars / 4`, which under-counts CJK text, source code
 * with long identifiers, and dense JSON. Budgets decide whether a compacted
 * request still fits, so an under-count is the dangerous direction: it produces
 * an "ok" verdict that overflows on the next request. This module therefore
 * counts wide (CJK/emoji) code points as one token each and divides the
 * remaining characters by 3.5 instead of 4.
 *
 * This is still an estimate. Calibration telemetry (estimated vs. provider
 * usage) is the only way to know how far off it is for a given model.
 */

/** Conservative default. Pi core uses 4. */
export const DEFAULT_CHARS_PER_TOKEN = 3.5;

/** Mirrors Pi's ESTIMATED_IMAGE_CHARS (4800) divided by 4. */
export const IMAGE_TOKENS_ESTIMATE = 1200;

const isWideCodePoint = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
  (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, punctuation
  (cp >= 0x3041 && cp <= 0x33ff) || // Kana, CJK compatibility
  (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
  (cp >= 0x4e00 && cp <= 0xa4cf) || // CJK unified, Yi
  (cp >= 0xa960 && cp <= 0xa97f) ||
  (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
  (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
  (cp >= 0xfe30 && cp <= 0xfe6f) ||
  (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f300 && cp <= 0x1faff) || // Emoji
  (cp >= 0x20000 && cp <= 0x3ffff); // CJK ext B+

/** Anything below U+1100 is never wide, so a string without these is all narrow. */
const NON_NARROW = /[\u1100-\uffff\ud800-\udfff]/;

/**
 * Estimate tokens for plain text.
 * Wide code points cost one token each; everything else is chars / charsPerToken.
 */
export function estimateTextTokens(
  text: string | undefined | null,
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): number {
  if (!text) return 0;
  // Most text (code, logs, JSON) has nothing above U+10FF, so one regex scan
  // replaces a per-code-point iterator over what can be megabytes of output.
  if (!NON_NARROW.test(text)) return Math.ceil(text.length / charsPerToken);
  let wide = 0;
  let narrow = 0;
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp !== undefined && isWideCodePoint(cp)) wide++;
    else narrow++;
  }
  if (narrow === 0) return wide;
  return wide + Math.ceil(narrow / charsPerToken);
}

type Block = Record<string, unknown>;

const textOf = (block: Block): string => {
  if (typeof block.text === "string") return block.text;
  if (typeof block.thinking === "string") return block.thinking;
  return "";
};

/**
 * Estimate tokens for message content: a string, a content-block array, or
 * a single block object.
 */
export function estimateContentTokens(
  content: unknown,
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): number {
  if (content == null) return 0;
  if (typeof content === "string") return estimateTextTokens(content, charsPerToken);
  if (Array.isArray(content)) {
    let total = 0;
    for (const item of content) total += estimateContentTokens(item, charsPerToken);
    return total;
  }
  if (typeof content !== "object") return 0;
  const block = content as Block;
  if (block.type === "image") return IMAGE_TOKENS_ESTIMATE;
  const text = textOf(block);
  if (text) return estimateTextTokens(text, charsPerToken);
  return 0;
}

/**
 * Estimate tokens for a single model-visible message.
 * Structurally typed so tests and callers can pass plain objects.
 */
export function estimateMessageTokens(
  message: unknown,
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): number {
  if (message == null || typeof message !== "object") return 0;
  const msg = message as Record<string, unknown>;
  const role = msg.role;

  if (role === "compactionSummary" || role === "branchSummary") {
    return estimateTextTokens(typeof msg.summary === "string" ? msg.summary : "", charsPerToken);
  }
  if (role === "bashExecution") {
    const command = typeof msg.command === "string" ? msg.command : "";
    const output = typeof msg.output === "string" ? msg.output : "";
    return estimateTextTokens(command, charsPerToken) + estimateTextTokens(output, charsPerToken);
  }
  if (role === "system") {
    let total = estimateContentTokens(msg.content, charsPerToken);
    const sections = msg.sections;
    if (sections && typeof sections === "object" && !Array.isArray(sections)) {
      for (const value of Object.values(sections as Record<string, unknown>)) {
        if (typeof value === "string") total += estimateTextTokens(value, charsPerToken);
      }
    }
    if (msg.toolsAdded != null) {
      total += estimateTextTokens(safeStringify(msg.toolsAdded), charsPerToken);
    }
    return total;
  }
  if (role === "assistant") {
    let total = 0;
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        const block = item as Block;
        if (block?.type === "toolCall") {
          const name = typeof block.name === "string" ? block.name : "";
          total += estimateTextTokens(name, charsPerToken);
          total += estimateTextTokens(safeStringify(block.arguments), charsPerToken);
        } else {
          total += estimateContentTokens(block, charsPerToken);
        }
      }
      return total;
    }
    return estimateContentTokens(content, charsPerToken);
  }
  return estimateContentTokens(msg.content, charsPerToken);
}

function safeStringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
