/**
 * Screen-level semantic selection for rendered markdown.
 *
 * Pi's fullscreen renderer only knows word and physical-line selection. A table
 * row is one visual line, so triple-click selects every column, and a wrapped
 * cell has no "cell" concept. This module classifies the already-rendered lines
 * (box drawing, quote borders, fences, list markers) and returns a column-aware
 * range that the selection controller can install.
 *
 * The input is the terminal screen, not markdown source, so the heuristics are
 * deliberately conservative: when a line is not clearly part of a block, the
 * caller falls back to Pi's line selection.
 */
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { hyperlinkSpans, resolveHyperlinkAt } from "./osc8.ts";

export type BlockKind =
  | "table-cell"
  | "table-row"
  | "quote"
  | "code-block"
  | "list-item"
  | "heading"
  | "paragraph"
  | "link"
  | "line";

export interface SelectionPoint {
  row: number;
  col: number;
  boundary?: boolean;
}

export interface SelectionRange {
  start: SelectionPoint;
  end: SelectionPoint;
}

export interface BlockSelection {
  kind: BlockKind;
  range: SelectionRange;
  /**
   * Fixed visible columns for every row in the range. Table cells use this so
   * wrapped rows never include a neighbouring column; quotes/code use it to
   * exclude their border/marker.
   */
  columns?: { start: number; end: number };
  /** URL when the selection started inside an OSC 8 hyperlink. */
  linkUrl?: string;
}

interface Cell {
  char: string;
  start: number;
  end: number;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function plain(line: string): string {
  return stripTerminalSequences(line);
}

function cells(line: string): Cell[] {
  const out: Cell[] = [];
  let col = 0;
  for (const part of graphemes.segment(line)) {
    const width = visibleWidth(part.segment);
    out.push({ char: part.segment, start: col, end: col + width });
    col += width;
  }
  return out;
}

function widthOf(line: string): number {
  return visibleWidth(plain(line));
}

function trimmedStart(text: string): string {
  return text.replace(/^\s+/, "");
}

function isTableTop(line: string): boolean {
  const value = trimmedStart(plain(line));
  return value.startsWith("┌") && value.includes("─");
}

function isTableMiddle(line: string): boolean {
  const value = trimmedStart(plain(line));
  return value.startsWith("├") && value.includes("─");
}

function isTableBottom(line: string): boolean {
  const value = trimmedStart(plain(line));
  return value.startsWith("└") && value.includes("─");
}

function isTableRow(line: string): boolean {
  const value = trimmedStart(plain(line));
  return value.startsWith("│") && value.trimEnd().endsWith("│");
}

function isTableBorders(line: string): boolean {
  return isTableTop(line) || isTableMiddle(line) || isTableBottom(line);
}

function isFence(line: string): boolean {
  return /^\s*```/.test(plain(line));
}

function isQuote(line: string): boolean {
  const value = trimmedStart(plain(line));
  return value.startsWith("│ ") || value.startsWith("> ");
}

function isListStart(line: string): boolean {
  return /^\s*(?:[-*+]|\d{1,9}[.)])\s+/.test(plain(line));
}

function isBlank(line: string): boolean {
  return plain(line).trim().length === 0;
}

function isSpecial(line: string): boolean {
  return isFence(line) || isQuote(line) || isTableBorders(line) || isTableRow(line);
}

/** Clip a row range to real screen rows. */
function clampRange(lines: readonly string[], range: SelectionRange): SelectionRange {
  const last = Math.max(0, lines.length - 1);
  return {
    start: { ...range.start, row: Math.max(0, Math.min(last, range.start.row)) },
    end: { ...range.end, row: Math.max(0, Math.min(last, range.end.row)) },
  };
}

/** Visible column boundary positions of `│` on one table line. */
function tableBoundaries(line: string): number[] {
  return cells(plain(line))
    .filter(cell => cell.char === "│")
    .map(cell => cell.start);
}

function tableBounds(lines: readonly string[], row: number): { top: number; bottom: number } | undefined {
  let top = row;
  while (top >= 0 && !isTableTop(lines[top] ?? "") && (isTableRow(lines[top] ?? "") || isTableBorders(lines[top] ?? ""))) {
    top--;
  }
  if (top < 0 || !isTableTop(lines[top] ?? "")) return undefined;
  let bottom = row;
  while (bottom < lines.length && !isTableBottom(lines[bottom] ?? "") && (isTableRow(lines[bottom] ?? "") || isTableBorders(lines[bottom] ?? ""))) {
    bottom++;
  }
  if (bottom >= lines.length || !isTableBottom(lines[bottom] ?? "")) return undefined;
  return { top, bottom };
}

/** Rows of the logical table row containing `row` (wrapped cells share them). */
function logicalRowBounds(lines: readonly string[], row: number, table: { top: number; bottom: number }): { first: number; last: number } {
  let first = row;
  while (first > table.top && isTableRow(lines[first - 1] ?? "")) first--;
  let last = row;
  while (last < table.bottom - 1 && isTableRow(lines[last + 1] ?? "")) last++;
  return { first, last };
}

function cellSelection(lines: readonly string[], row: number, col: number, table: { top: number; bottom: number }): BlockSelection | undefined {
  const line = lines[row] ?? "";
  if (isTableBorders(line)) {
    // A border click targets the nearest content row: below the top border,
    // above a separator/bottom border (the row that border closes).
    const target = isTableTop(line)
      ? (isTableRow(lines[row + 1] ?? "") ? row + 1 : row)
      : isTableRow(lines[row - 1] ?? "")
        ? row - 1
        : isTableRow(lines[row + 1] ?? "")
          ? row + 1
          : row;
    const group = logicalRowBounds(lines, target, table);
    return {
      kind: "table-row",
      range: clampRange(lines, {
        start: { row: group.first, col: 0 },
        end: { row: group.last, col: widthOf(lines[group.last] ?? ""), boundary: true },
      }),
    };
  }

  const boundaries = tableBoundaries(line);
  if (boundaries.length < 2) return undefined;

  const onBorderChar = cells(plain(line)).some(cell => cell.char === "│" && col >= cell.start && col < cell.end);
  const group = logicalRowBounds(lines, row, table);

  if (onBorderChar) {
    // A click on a vertical border is a row request: keep every column.
    return {
      kind: "table-row",
      range: clampRange(lines, {
        start: { row: group.first, col: 0 },
        end: { row: group.last, col: widthOf(lines[group.last] ?? ""), boundary: true },
      }),
    };
  }

  let index = 0;
  for (let i = 0; i < boundaries.length - 1; i++) {
    if (col >= boundaries[i]! && col < boundaries[i + 1]!) {
      index = i;
      break;
    }
  }
  const contentStart = boundaries[index]! + 1;
  const contentEnd = boundaries[index + 1]!;

  // Trim the cell's padding without touching wide characters. Use every line
  // of the logical row so a wrapped cell keeps the widest span its text needs.
  let start = -1;
  let end = -1;
  for (let rowIndex = group.first; rowIndex <= group.last; rowIndex++) {
    for (const cell of cells(plain(lines[rowIndex] ?? ""))) {
      if (cell.start < contentStart || cell.end > contentEnd) continue;
      if (cell.char.trim().length === 0) continue;
      if (start < 0) start = cell.start;
      end = Math.max(end, cell.end);
    }
  }
  if (start < 0 || end <= start) {
    start = contentStart;
    end = contentEnd;
  }

  return {
    kind: "table-cell",
    columns: { start, end },
    range: clampRange(lines, {
      start: { row: group.first, col: start },
      end: { row: group.last, col: end, boundary: true },
    }),
  };
}

function quoteSelection(lines: readonly string[], row: number): BlockSelection | undefined {
  if (!isQuote(lines[row] ?? "")) return undefined;
  let first = row;
  while (first > 0 && isQuote(lines[first - 1] ?? "")) first--;
  let last = row;
  while (last < lines.length - 1 && isQuote(lines[last + 1] ?? "")) last++;

  const value = plain(lines[row] ?? "");
  const marker = value.indexOf("│ ");
  const start = marker >= 0 ? marker + 2 : value.indexOf("> ") + 2;
  const end = Math.max(start, widthOf(lines[last] ?? ""));
  return {
    kind: "quote",
    columns: { start: Math.max(0, start), end },
    range: clampRange(lines, {
      start: { row: first, col: Math.max(0, start) },
      end: { row: last, col: end, boundary: true },
    }),
  };
}

function codeSelection(lines: readonly string[], row: number): BlockSelection | undefined {
  if (!isFence(lines[row] ?? "")) return undefined;
  let top = row;
  while (top > 0 && !isFence(lines[top] ?? "")) top--;
  if (!isFence(lines[top] ?? "")) return undefined;
  let bottom = top + 1;
  while (bottom < lines.length && !isFence(lines[bottom] ?? "")) bottom++;
  if (bottom >= lines.length) return undefined;
  if (bottom === top + 1) return undefined;
  const first = top + 1;
  const last = bottom - 1;
  return {
    kind: "code-block",
    range: clampRange(lines, {
      start: { row: first, col: 0 },
      end: { row: last, col: widthOf(lines[last] ?? ""), boundary: true },
    }),
  };
}

function listSelection(lines: readonly string[], row: number): BlockSelection | undefined {
  let first = row;
  while (first > 0 && !isListStart(lines[first] ?? "") && !isBlank(lines[first] ?? "") && !isSpecial(lines[first] ?? "")) first--;
  if (!isListStart(lines[first] ?? "")) return undefined;

  const base = plain(lines[first] ?? "");
  const indent = base.length - base.trimStart().length;
  let last = first;
  while (last < lines.length - 1) {
    const next = lines[last + 1] ?? "";
    if (isBlank(next) || isSpecial(next)) break;
    const nextPlain = plain(next);
    const nextIndent = nextPlain.length - nextPlain.trimStart().length;
    if (isListStart(next) && nextIndent <= indent) break;
    last++;
  }

  return {
    kind: "list-item",
    range: clampRange(lines, {
      start: { row: first, col: 0 },
      end: { row: last, col: widthOf(lines[last] ?? ""), boundary: true },
    }),
  };
}

function paragraphSelection(lines: readonly string[], row: number): BlockSelection | undefined {
  if (isBlank(lines[row] ?? "") || isSpecial(lines[row] ?? "")) return undefined;
  let first = row;
  while (first > 0 && !isBlank(lines[first - 1] ?? "") && !isSpecial(lines[first - 1] ?? "")) first--;
  let last = row;
  while (last < lines.length - 1 && !isBlank(lines[last + 1] ?? "") && !isSpecial(lines[last + 1] ?? "")) last++;
  return {
    kind: "paragraph",
    range: clampRange(lines, {
      start: { row: first, col: 0 },
      end: { row: last, col: widthOf(lines[last] ?? ""), boundary: true },
    }),
  };
}

function lineSelection(lines: readonly string[], row: number): BlockSelection {
  return {
    kind: "line",
    range: clampRange(lines, {
      start: { row, col: 0 },
      end: { row, col: widthOf(lines[row] ?? ""), boundary: true },
    }),
  };
}

/**
 * Expand a triple-click at `row`/`col` to the semantic block under the pointer.
 * `clickCount` 2 handles links; 3+ handles blocks.
 */
export function blockSelectionAt(
  lines: readonly string[],
  row: number,
  col: number,
  clickCount = 3,
): BlockSelection | undefined {
  if (!lines.length || row < 0 || row >= lines.length) return undefined;
  const clampedCol = Math.max(0, col);

  if (clickCount <= 2) {
    const url = resolveHyperlinkAt(lines, row, clampedCol);
    if (!url) return undefined;
    let first = row;
    while (first > 0 && resolveHyperlinkAt(lines, first - 1, clampedCol)) first--;
    let last = row;
    while (last < lines.length - 1 && resolveHyperlinkAt(lines, last + 1, clampedCol)) last++;
    return {
      kind: "link",
      linkUrl: url,
      range: clampRange(lines, {
        start: { row: first, col: 0 },
        end: { row: last, col: widthOf(lines[last] ?? ""), boundary: true },
      }),
    };
  }

  const table = tableBounds(lines, row);
  if (table) {
    const selected = cellSelection(lines, row, clampedCol, table);
    if (selected) return selected;
  }

  if (isQuote(lines[row] ?? "")) return quoteSelection(lines, row);
  if (isFence(lines[row] ?? "")) return codeSelection(lines, row);
  const list = listSelection(lines, row);
  if (list) return list;
  if (!isBlank(lines[row] ?? "") && !isSpecial(lines[row] ?? "")) {
    return paragraphSelection(lines, row) ?? lineSelection(lines, row);
  }

  return lineSelection(lines, row);
}

/** Extract the selected text with the block's fixed columns where present. */
export function extractBlockText(lines: readonly string[], selection: BlockSelection): string {
  const { range, columns } = selection;
  const first = Math.max(0, Math.min(range.start.row, range.end.row));
  const last = Math.max(range.start.row, range.end.row);
  const out: string[] = [];

  for (let row = first; row <= last; row++) {
    const line = lines[row] ?? "";
    let start = 0;
    let end = widthOf(line);
    if (columns) {
      start = columns.start;
      end = columns.end;
    } else if (row === first) {
      start = range.start.col;
    } else if (row === last) {
      end = range.end.col;
    }
    out.push(stripTerminalSequences(sliceByColumn(line, start, Math.max(0, end - start), true)).trimEnd());
  }

  while (out.length && out[0]!.trim().length === 0) out.shift();
  while (out.length && out[out.length - 1]!.trim().length === 0) out.pop();
  return out.join("\n");
}

/** True when the hyperlink at a point spans more than one visual line. */
export function wrappedLinkAt(lines: readonly string[], row: number, col: number): boolean {
  const url = resolveHyperlinkAt(lines, row, col);
  if (!url) return false;
  const spans = hyperlinkSpans(lines[row] ?? "");
  return spans.length > 0 && (row > 0 || row < lines.length - 1) && !spans.some(span => span.start === 0 && span.end === widthOf(lines[row] ?? ""));
}
