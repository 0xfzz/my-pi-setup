/**
 * Paint Pi's paste markers so they read as chips instead of literal text.
 *
 * The editor collapses a large paste into `[paste #1 +340 lines]` and keeps the
 * text out of the buffer until submit. That marker is the only sign the paste
 * happened, so it should look like an object, not like something the model was
 * asked to read. The same treatment applies to pi-paster's `[#image 1]`.
 *
 * The editor renders plain text with a cursor and selection applied, so the
 * marker is located in the *visible* line and re-sliced by column: painting the
 * raw string would corrupt the ANSI codes around it.
 */
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

/** `[paste #2 +12 lines]`, `[paste #3 1234 chars]`, `[#image 1]`. */
export const PASTE_MARKER_PATTERN = /\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\]|\[#image \d+\]/g;

export interface MarkerSpan {
  /** Visible column where the marker starts (0-based, after the editor padding). */
  start: number;
  end: number;
}

/** Marker spans in one rendered line. Markers are ASCII, so columns == characters. */
export function pasteMarkerSpans(line: string): MarkerSpan[] {
  const plain = stripTerminalSequences(line);
  return [...plain.matchAll(PASTE_MARKER_PATTERN)].map(match => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

/**
 * Wrap every marker in `paint`, leaving the rest of the line byte-identical.
 * Backgrounds do not change the visible width, so layout is unaffected.
 */
export function paintPasteMarkers(lines: readonly string[], paint: (text: string) => string): string[] {
  return lines.map(line => {
    const spans = pasteMarkerSpans(line);
    if (!spans.length) return line;
    const width = visibleWidth(stripTerminalSequences(line));
    let out = "";
    let column = 0;
    for (const span of spans) {
      if (span.start > column) out += sliceByColumn(line, column, span.start - column);
      out += paint(sliceByColumn(line, span.start, span.end - span.start));
      column = span.end;
    }
    if (column < width) out += sliceByColumn(line, column, width - column);
    return out;
  });
}
