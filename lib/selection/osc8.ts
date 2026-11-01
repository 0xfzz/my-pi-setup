/**
 * OSC 8 hyperlink helpers.
 *
 * Pi renders markdown links as a single OSC 8 span. When the terminal (or the
 * popup renderer) wraps that line, the continuation line contains text without
 * the opening escape sequence, so the terminal and Pi's own `getOsc8LinkAtColumn`
 * cannot resolve the URL there. These helpers carry the active URL across
 * wrapped lines and can re-open it on each visual fragment.
 */
import { visibleWidth } from "@earendil-works/pi-tui";

// Deliberate terminal control sequences: this module exists to parse ANSI/OSC 8.
// oxlint-disable-next-line no-control-regex
const OSC8 = /\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// oxlint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

const OPEN = (url: string) => `\x1b]8;;${url}\x1b\\`;
const CLOSE = "\x1b]8;;\x1b\\";

export interface Osc8Span {
  url: string;
  start: number;
  end: number;
}

export interface Osc8Scan {
  /** Visible text, ANSI and OSC 8 stripped. */
  text: string;
  spans: Osc8Span[];
  /** URL still open when the line ended. */
  openUrl?: string;
}

/** Scan one rendered line for OSC 8 spans in visible columns. */
export function scanOsc8(line: string): Osc8Scan {
  const spans: Osc8Span[] = [];
  let active: string | undefined;
  let spanStart = 0;
  let column = 0;
  let text = "";
  let last = 0;

  const closeSpan = () => {
    if (active !== undefined && column > spanStart) {
      spans.push({ url: active, start: spanStart, end: column });
    }
  };
  const appendText = (value: string) => {
    text += value;
    for (const part of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)) {
      column += visibleWidth(part.segment);
    }
  };

  for (const match of line.matchAll(ANSI)) {
    appendText(line.slice(last, match.index));
    // oxlint-disable-next-line no-control-regex -- OSC 8 terminator is ESC \\
    const osc = /^\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)$/.exec(match[0]);
    if (osc) {
      closeSpan();
      active = osc[1] || undefined;
      spanStart = column;
    }
    last = match.index + match[0].length;
  }
  appendText(line.slice(last));
  closeSpan();
  return { text, spans, ...(active ? { openUrl: active } : {}) };
}

/**
 * Resolve the URL covering `column` on `row`, carrying an open link across
 * wrapped visual lines exactly like the terminal does.
 */
export function resolveHyperlinkAt(
  lines: readonly string[],
  row: number,
  column: number,
): string | undefined {
  let carried: string | undefined;
  const last = Math.max(0, Math.min(lines.length - 1, row));
  for (let index = 0; index <= last; index++) {
    const scan = scanOsc8(lines[index] ?? "");
    const lineStart = carried;
    if (index === last) {
      for (const span of scan.spans) {
        if (column >= span.start && column < span.end) return span.url;
      }
      if (lineStart && column >= 0 && column < visibleWidth(scan.text)) return lineStart;
      return undefined;
    }
    carried = scan.openUrl ?? (scan.spans.length ? scan.spans[scan.spans.length - 1].url : undefined);
    // A line that closed its link must not leak the URL into the next line.
    if (scan.text.length > 0 && !scan.openUrl && !lineStart) carried = undefined;
  }
  return carried;
}

/**
 * Re-open a link that wrapped onto a continuation line, and close it again at
 * the end of that line. This keeps terminals that require a per-line sequence
 * clickable without changing the visible text.
 */
export function repairOsc8Wrapping(lines: readonly string[]): string[] {
  const out: string[] = [];
  let carried: string | undefined;

  for (const line of lines) {
    const scan = scanOsc8(line);
    let repaired = line;

    if (carried && scan.spans[0]?.start !== 0) {
      // The line begins with plain text that belongs to the carried link.
      repaired = OPEN(carried) + repaired;
    }

    const next = scanOsc8(repaired);
    if (next.openUrl) {
      repaired += CLOSE;
      carried = next.openUrl;
    } else {
      carried = undefined;
    }
    out.push(repaired);
  }

  return out;
}

/** Strip every ANSI/OSC sequence for text comparisons. */
export function plainText(line: string): string {
  return line.replace(ANSI, "").replace(OSC8, "");
}
