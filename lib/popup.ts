/**
 * Shared popup chrome for extension dialogs.
 *
 * Every popup gets the same visual language so a popup is always distinguishable
 * from inline/streamed content:
 *
 *   ╭ Artifact title ────────── Esc close ─╮   ← highlighted frame with inline
 *   │                                      │     title and key hint
 *   │   (content rows: 1-col side padding, │   ← 1 blank row top/bottom inside
 *   │    1-row top/bottom margin)          │     the frame
 *   │                                      │
 *   ╰──────────────────────────────────────╯
 *
 * Pi overlays composite on top of the transcript without a background of their
 * own, so the chrome paints a themed background under every row; without it,
 * transcript text would bleed through the popup frame.
 *
 * Below the minimum framed size the chrome falls back to horizontal rules
 * instead of drawing a corrupt box.
 */
import { createRequire } from "node:module";
import type { ThemeBg, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  matchesKey,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type MarkdownTheme,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { repairOsc8Wrapping } from "./selection/osc8.ts";

export const POPUP_MIN_FRAMED_WIDTH = 26;
export const POPUP_PADDING_X = 1;
export const POPUP_KEY_HINT = "Esc close";
/** Frame chrome height around the content window (top + 2 blanks + bottom). */
export const POPUP_FRAME_ROWS = 4;
/** Overlay margin (all sides) so the popup never touches the terminal edges. */
export const POPUP_MARGIN = 1;

/** Content row: a ready (styled) line, or `{ wrap }` text word-wrapped to fit. */
export type PopupRow = string | { wrap: string };

export interface PopupTheme {
  // Typed as Pi's tokens, not `string`: an unknown name is a compile error here
  // instead of "Unknown theme color" at render time, in the middle of a session.
  fg(color: ThemeColor, text: string): string;
  bold(text: string): string;
  /** Background painter; popups use it to paint over the transcript beneath. */
  bg?(color: ThemeBg, text: string): string;
}

export const PLAIN_THEME: PopupTheme = { fg: (_c, text) => text, bold: (text) => text };

/** Standard centered overlay geometry for extension popups. */
export function popupOverlayOptions(
  width: string | number = "84%",
  minWidth = 46,
  maxHeight: string | number = "94%",
) {
  return { anchor: "center" as const, width, minWidth, maxHeight, margin: POPUP_MARGIN };
}

/** Overlay options sized so a popup of `contentRows` rows fits the terminal. */
export function popupHeight(rows: number): number {
  return Math.max(8, rows + POPUP_FRAME_ROWS + 2 * POPUP_MARGIN);
}

/** True when the key data means "close/cancel this popup". */
export function isPopupCloseKey(data: string): boolean {
  return matchesKey(data, "escape") || matchesKey(data, "ctrl+c");
}

export function wrapRowWithHangingIndent(line: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  if (visibleWidth(line) <= safeWidth) return [line];

  if (safeWidth < 12) {
    return wrapTextWithAnsi(line, safeWidth).map((l) =>
      visibleWidth(l) > safeWidth ? truncateToWidth(l, safeWidth) : l,
    );
  }

  // Detect leading marker/number prefix: e.g. "→ ☑ 1. [done] " or "  ☑ 1. [done] " or "  1. "
  // oxlint-disable-next-line no-control-regex
  const plain = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  const match = plain.match(/^(\s*(?:→\s*|\s{2})?(?:[☑☐●◔↻■]\s+|\d+\.\s+|\[\w+\]\s*)*)/);
  const prefixText = match ? match[1] : "";
  const maxIndent = Math.floor(safeWidth / 3);
  const indentLen = Math.min(Math.max(2, visibleWidth(prefixText)), Math.max(0, maxIndent));
  const indent = " ".repeat(indentLen);
  const contWidth = Math.max(1, safeWidth - indentLen);

  const initial = wrapTextWithAnsi(line, safeWidth);
  if (initial.length <= 1) {
    return initial.map((l) => (visibleWidth(l) > safeWidth ? truncateToWidth(l, safeWidth) : l));
  }

  const out = [visibleWidth(initial[0]) > safeWidth ? truncateToWidth(initial[0], safeWidth) : initial[0]];
  for (let i = 1; i < initial.length; i++) {
    const subWrapped = wrapTextWithAnsi(initial[i], contWidth);
    for (const sub of subWrapped) {
      const full = indent + sub;
      out.push(visibleWidth(full) > safeWidth ? truncateToWidth(full, safeWidth) : full);
    }
  }
  return out;
}

/** Wrap rows into `width`. Long content wraps with clean continuation indent. */
export function flattenPopupRows(rows: readonly PopupRow[], width: number): string[] {
  const out: string[] = [];
  const safeWidth = Math.max(1, width);
  for (const row of rows) {
    if (typeof row === "string") {
      for (const rawLine of row.split("\n")) {
        if (visibleWidth(rawLine) <= safeWidth) {
          out.push(rawLine);
        } else {
          for (const wrapped of wrapRowWithHangingIndent(rawLine, safeWidth)) {
            out.push(visibleWidth(wrapped) > safeWidth ? truncateToWidth(wrapped, safeWidth) : wrapped);
          }
        }
      }
    } else {
      for (const wrapped of wrapTextWithAnsi(row.wrap, safeWidth)) {
        out.push(visibleWidth(wrapped) > safeWidth ? truncateToWidth(wrapped, safeWidth) : wrapped);
      }
    }
  }
  return out;
}

export interface PopupFrame {
  inner: number;
  contentWidth: number;
  pad: number;
  /** Top border row (inline title, no key hint). */
  topRow: string;
  /** Top border row with right-aligned key hint. */
  topHintedRow: string;
  /** Closing border row. */
  bottomRow: string;
  /** Blank inner row (background-painted). */
  blankRow: string;
  /** Wrap content rows in side borders at content width. */
  body(rows: readonly PopupRow[]): string[];
}

/**
 * Build popup chrome at the given total width. Returns `undefined` when the
 * terminal is too narrow for a frame (callers then render horizontal rules).
 */
export function popupFrame(
  theme: PopupTheme,
  width: number,
  options: { title?: string; hint?: string } = {},
): PopupFrame | undefined {
  if (width < POPUP_MIN_FRAMED_WIDTH) return undefined;
  const inner = width - 2;
  const pad = Math.min(POPUP_PADDING_X, Math.max(1, Math.floor((inner - 2) / 3)));
  const contentWidth = Math.max(1, inner - 2 * pad);
  const paint = (text: string): string => (theme.bg ? theme.bg("userMessageBg", text) : text);
  const border = (text: string): string => theme.fg("borderAccent", text);

  const borderedRow = (content: string): string => {
    const fitted = visibleWidth(content) > inner ? truncateToWidth(content, inner) : content;
    const padded = visibleWidth(fitted) >= inner ? fitted : fitted + " ".repeat(inner - visibleWidth(fitted));
    return border("│") + paint(padded) + border("│");
  };
  const topRow = (hint: string): string =>
    border("╭") + topLine(theme, options.title ?? "", hint, inner) + border("╮");

  return {
    inner,
    contentWidth,
    pad,
    topRow: topRow(""),
    topHintedRow: topRow(options.hint ?? POPUP_KEY_HINT),
    bottomRow: border("╰" + "─".repeat(inner) + "╯"),
    blankRow: borderedRow(""),
    body: (rows) =>
      flattenPopupRows(rows, contentWidth).map((row) =>
        borderedRow(row.length > 0 ? " ".repeat(pad) + row : ""),
      ),
  };
}

function topLine(theme: PopupTheme, title: string, hint: string, inner: number): string {
  const cleanTitle = title.replace(/\s+/g, " ").trim();
  const cleanHint = hint.replace(/\s+/g, " ").trim();
  const hintSeg = cleanHint ? ` ${cleanHint} ` : "";
  const hintBudget = Math.min(hintSeg ? visibleWidth(hintSeg) : 0, Math.max(0, inner - 6));
  const fittedHint = hintSeg ? truncateToWidth(hintSeg, hintBudget) : "";
  const titleBudget = Math.max(0, inner - visibleWidth(fittedHint));
  const titleSeg = cleanTitle ? ` ${cleanTitle} ` : "";
  const fittedTitle = titleSeg ? truncateToWidth(titleSeg, titleBudget) : "";
  const fill = Math.max(0, inner - visibleWidth(fittedTitle) - visibleWidth(fittedHint));
  const parts: string[] = [];
  if (fittedTitle) parts.push(theme.bold(theme.fg("accent", fittedTitle)));
  parts.push(theme.fg("border", "─".repeat(fill)));
  if (fittedHint) parts.push(theme.fg("dim", fittedHint));
  const line = parts.join("");
  const width = visibleWidth(line);
  if (width >= inner) return line;
  return line + theme.fg("border", "─".repeat(inner - width));
}

/**
 * Rows-based popup panel used by menus and detail dialogs.
 * Assign content with `setContent()` / `setRows()` before each render.
 */
export class PopupPanel implements Component {
  private rows: PopupRow[] = [];
  private readonly options: {
    theme?: PopupTheme;
    title?: string;
    hint?: string;
    onKey?: (data: string) => void;
    onMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
    onRender?: (width: number) => void;
  };
  private isFocused = false;
  private lastWidth = 0;

  constructor(options: PopupPanel["options"] = {}) {
    this.options = options;
  }

  setContent(rows: readonly PopupRow[]): void {
    this.rows = [...rows];
  }

  /** Alias kept for call sites that think in terms of list rows. */
  setRows(rows: readonly PopupRow[]): void {
    this.setContent(rows);
  }

  get focused(): boolean {
    return this.isFocused;
  }
  set focused(value: boolean) {
    this.isFocused = value;
  }

  get renderedWidth(): number {
    return this.lastWidth;
  }

  handleInput(data: string): void {
    this.options.onKey?.(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const handled = this.options.onMouse?.(event);
    if (handled) return { handled: true, render: true };
    return undefined;
  }

  invalidate(): void {
    /* rows are rebuilt on setContent; nothing to discard */
  }

  render(width: number): string[] {
    this.lastWidth = width;
    this.options.onRender?.(width);
    const theme = this.options.theme ?? PLAIN_THEME;
    const chrome = popupFrame(theme, width, { title: this.options.title, hint: this.options.hint });
    if (!chrome) {
      const rule = theme.fg("border", "─".repeat(Math.max(1, width)));
      const rows = flattenPopupRows(this.rows, width);
      const painted = theme.bg
        ? rows.map((row) =>
            theme.bg!("userMessageBg", row.length >= width ? row : row + " ".repeat(width - visibleWidth(row))),
          )
        : rows;
      return [rule, ...painted, rule];
    }
    return [
      chrome.topHintedRow,
      chrome.blankRow,
      ...chrome.body(this.rows),
      chrome.blankRow,
      chrome.bottomRow,
    ];
  }
}

export interface MarkdownPopupOptions {
  /** Markdown source to render. */
  markdown: string;
  theme?: PopupTheme;
  title?: string;
  /** Key hint in the top border (default "Esc close"). */
  hint?: string;
  /** Visible content rows; the popup height derives from it. */
  rows: number;
  /** Terminal height supplier; the visible rows shrink to fit short terminals. */
  terminalRows?: () => number;
  /** Enable `/` search (default true). */
  search?: boolean;
  /** Called when the user closes the popup; `action` describes how. */
  onClose?: (action?: string) => void;
  /** External-open handler for `o`/`v`; return true when handled. */
  onOpenExternal?: (text: string) => boolean | undefined;
  /** Per-key handler; return true to consume the key. */
  onKey?: (data: string) => boolean;
}

/**
 * Framed, scrollable, markdown-rendered popup — the shared detail viewer.
 * ↑↓/jk, PgUp/PgDn, Home/End/G and mouse wheel scroll; Enter/Esc close;
 * `o`/`v` open externally when a handler is registered.
 */
interface SearchMatch {
  row: number;
  col: number;
  length: number;
}

export class MarkdownPopup implements Component {
  private readonly options: MarkdownPopupOptions;
  private cacheWidth = -1;
  private cacheLines: string[] = [];
  private cacheText = "";
  private scrollTop = 0;
  private viewport: number;
  private isFocused = false;
  private searchMode = false;
  private query = "";
  private matches: SearchMatch[] = [];
  private activeMatch = 0;
  private matchesWidth = -1;
  private lastContentWidth = 1;

  constructor(options: MarkdownPopupOptions) {
    this.options = options;
    this.cacheText = options.markdown;
    this.viewport = this.effectiveViewport();
  }

  get focused(): boolean {
    return this.isFocused;
  }
  set focused(value: boolean) {
    this.isFocused = value;
  }

  setMarkdown(text: string): void {
    this.cacheText = text;
    this.cacheWidth = -1;
    this.resetMatches();
  }

  invalidate(): void {
    this.cacheWidth = -1;
    this.matchesWidth = -1;
  }

  private effectiveViewport(): number {
    const terminal = this.options.terminalRows?.() ?? 24;
    const available = Math.max(3, terminal - 6);
    this.viewport = Math.max(3, Math.min(this.options.rows, available));
    return this.viewport;
  }

  private lines(width: number): string[] {
    if (this.cacheWidth !== width) {
      this.cacheLines = renderMarkdown(this.cacheText, width);
      this.cacheWidth = width;
    }
    return this.cacheLines;
  }

  private clamp(viewport = this.viewport): void {
    const max = Math.max(0, this.cacheLines.length - viewport);
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, max));
  }

  private scrollBy(delta: number): void {
    this.scrollTop += delta;
    this.clamp();
  }

  private resetMatches(): void {
    this.matches = [];
    this.matchesWidth = -1;
    this.activeMatch = 0;
  }

  private refreshMatches(width: number): void {
    if (this.matchesWidth === width && this.matchesQuery === this.query) return;
    this.matches = [];
    this.matchesWidth = width;
    this.matchesQuery = this.query;
    if (!this.query) return;
    const needle = this.query.toLowerCase();
    const lines = this.lines(width);
    for (let row = 0; row < lines.length; row++) {
      const plain = stripTerminalSequences(lines[row] ?? "");
      const haystack = plain.toLowerCase();
      let offset = 0;
      while (offset < haystack.length) {
        const hit = haystack.indexOf(needle, offset);
        if (hit < 0) break;
        this.matches.push({
          row,
          col: visibleWidth(plain.slice(0, hit)),
          length: Math.max(1, visibleWidth(plain.slice(hit, hit + needle.length))),
        });
        offset = hit + Math.max(1, needle.length);
      }
    }
    if (this.activeMatch >= this.matches.length) this.activeMatch = Math.max(0, this.matches.length - 1);
  }

  private matchesQuery = "";

  private startSearch(): void {
    this.searchMode = true;
    this.query = "";
    this.resetMatches();
  }

  private handleSearchInput(data: string): void {
    if (isPopupCloseKey(data)) {
      this.searchMode = false;
      this.query = "";
      this.resetMatches();
      return;
    }
    if (matchesKey(data, "enter")) {
      this.nextMatch(1);
      return;
    }
    if (matchesKey(data, "up")) {
      this.nextMatch(-1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.nextMatch(1);
      return;
    }
    if (data === "\x7f" || data === "\b") {
      this.query = this.query.slice(0, -1);
      this.resetMatches();
      return;
    }
    // Accept printable input and pastes; control sequences are ignored.
    // oxlint-disable-next-line no-control-regex -- stripping terminal controls is deliberate
    const printable = data.replace(/[\x00-\x1f\x7f]/g, "");
    if (printable) {
      this.query += printable;
      this.resetMatches();
    }
  }

  private nextMatch(delta: number): void {
    this.refreshMatches(this.lastContentWidth);
    if (!this.matches.length) return;
    this.activeMatch = (this.activeMatch + delta + this.matches.length) % this.matches.length;
  }

  private revealActive(viewport: number): void {
    const match = this.matches[this.activeMatch];
    if (!match) return;
    if (match.row < this.scrollTop) this.scrollTop = match.row;
    else if (match.row >= this.scrollTop + viewport) this.scrollTop = match.row - viewport + 1;
    this.clamp(viewport);
  }

  private displayLines(width: number): string[] {
    const lines = this.lines(width);
    this.refreshMatches(width);
    if (!this.query || !this.matches.length) return lines;
    const active = this.matches[this.activeMatch];
    const byRow = new Map<number, SearchMatch[]>();
    for (const match of this.matches) {
      const bucket = byRow.get(match.row);
      if (bucket) bucket.push(match);
      else byRow.set(match.row, [match]);
    }
    return lines.map((line, row) => highlightLine(line, byRow.get(row), active));
  }

  private hintText(): string {
    if (this.searchMode || this.query) {
      const count = this.matches.length ? `${this.activeMatch + 1}/${this.matches.length}` : "0/0";
      return `search: ${this.query || "…"} ${count} · Enter next · Esc close search`;
    }
    return this.options.hint ?? POPUP_KEY_HINT;
  }

  handleInput(data: string): void {
    if (this.searchMode) {
      this.handleSearchInput(data);
      return;
    }
    if (this.options.onKey?.(data)) return;
    if (this.options.search !== false && data === "/") {
      this.startSearch();
      return;
    }
    if (this.query && data === "n") {
      this.nextMatch(1);
      return;
    }
    if (this.query && data === "N") {
      this.nextMatch(-1);
      return;
    }
    if (isPopupCloseKey(data)) return this.options.onClose?.();
    if (matchesKey(data, "enter")) return this.options.onClose?.();
    if (matchesKey(data, "up") || matchesKey(data, "k")) return this.scrollBy(-1);
    if (matchesKey(data, "down") || matchesKey(data, "j")) return this.scrollBy(1);
    if (matchesKey(data, "pageUp")) return this.scrollBy(-sidePage(this.viewport));
    if (matchesKey(data, "pageDown")) return this.scrollBy(sidePage(this.viewport));
    if (matchesKey(data, "home") || data === "g") {
      this.scrollTop = 0;
      this.clamp();
      return;
    }
    if (matchesKey(data, "end") || data === "G") {
      this.scrollTop = Number.MAX_SAFE_INTEGER;
      this.clamp();
      return;
    }
    if (data === "o" || data === "v") {
      if (this.options.onOpenExternal?.(this.cacheText)) this.options.onClose?.("external");
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel" && event.wheelDelta) {
      this.scrollBy(-Math.sign(event.wheelDelta) * sidePage(this.viewport));
      return { handled: true, render: true };
    }
    if (event.type === "click" || event.type === "press") {
      const localY = event.y - 2;
      if (localY >= 0 && localY < this.viewport) {
        if (localY < this.viewport / 3) this.scrollBy(-sidePage(this.viewport));
        else if (localY >= (this.viewport * 2) / 3) this.scrollBy(sidePage(this.viewport));
        return { handled: true, render: true };
      }
    }
    return undefined;
  }

  render(width: number): string[] {
    const theme = this.options.theme ?? PLAIN_THEME;
    const probe = popupFrame(theme, width, { title: this.options.title });
    const contentWidth = probe?.contentWidth ?? Math.max(1, width);
    this.lastContentWidth = contentWidth;
    const all = this.displayLines(contentWidth);
    const viewport = this.effectiveViewport();
    this.clamp(viewport);
    this.revealActive(viewport);
    const chrome = popupFrame(theme, width, { title: this.options.title, hint: this.hintText() });

    if (!chrome) {
      const rule = theme.fg("border", "─".repeat(Math.max(1, width)));
      const start = Math.max(0, Math.min(this.scrollTop, Math.max(0, all.length - viewport)));
      return [rule, ...all.slice(start, start + viewport), rule];
    }

    const window = all.slice(this.scrollTop, this.scrollTop + viewport);
    while (window.length < viewport) window.push("");
    return [
      chrome.topHintedRow,
      chrome.blankRow,
      ...chrome.body(window),
      chrome.blankRow,
      chrome.bottomRow,
    ];
  }
}

function sidePage(viewport: number): number {
  return Math.max(1, viewport - 2);
}

/** Reverse-video every match on a rendered line, with a stronger active match. */
function highlightLine(
  line: string,
  matches: SearchMatch[] | undefined,
  active: SearchMatch | undefined,
): string {
  if (!matches?.length) return line;
  const total = visibleWidth(stripTerminalSequences(line));
  let out = "";
  let cursor = 0;
  for (const match of matches) {
    if (match.col > cursor) {
      out += sliceByColumn(line, cursor, Math.max(0, match.col - cursor), true);
    }
    const isActive = active !== undefined
      && active.row === match.row
      && active.col === match.col
      && active.length === match.length;
    const styled = sliceByColumn(line, match.col, Math.max(1, match.length), true);
    out += (isActive ? "\x1b[7;1m" : "\x1b[7m") + styled + "\x1b[27m";
    cursor = match.col + Math.max(1, match.length);
  }
  if (cursor < total) {
    out += sliceByColumn(line, cursor, Math.max(0, total - cursor), true);
  }
  return out;
}

/** Render markdown to styled lines at the given width (falls back to raw text). */
export function renderMarkdown(markdown: string, width: number): string[] {
  try {
    const lines = new Markdown(markdown, 0, 0, markdownTheme()).render(Math.max(1, width));
    // A wrapped OSC 8 link loses its opener on continuation lines; reopen it so
    // every visual fragment remains clickable in the terminal and in Pi.
    return repairOsc8Wrapping(lines);
  } catch {
    return wrapTextWithAnsi(markdown, Math.max(1, width));
  }
}

type PiMarkdownTheme = MarkdownTheme;
let cachedMarkdownTheme: MarkdownTheme | undefined;

function markdownTheme(): MarkdownTheme {
  if (cachedMarkdownTheme) return cachedMarkdownTheme;
  try {
    // Resolved through the same package the extension host loads.
    const req = createRequire(import.meta.url);
    const mod = req("@earendil-works/pi-coding-agent") as { getMarkdownTheme?: () => PiMarkdownTheme };
    if (typeof mod.getMarkdownTheme === "function") {
      cachedMarkdownTheme = mod.getMarkdownTheme();
      return cachedMarkdownTheme;
    }
  } catch {
    /* fall through to plain theme */
  }
  cachedMarkdownTheme = plainMarkdownTheme;
  return cachedMarkdownTheme;
}

const plainMarkdownTheme: MarkdownTheme = {
  heading: (t) => t,
  link: (t) => t,
  linkUrl: (t) => t,
  code: (t) => t,
  codeBlock: (t) => t,
  codeBlockBorder: (t) => t,
  quote: (t) => t,
  quoteBorder: (t) => t,
  hr: (t) => t,
  listBullet: (t) => t,
  bold: (t) => t,
  italic: (t) => t,
  strikethrough: (t) => t,
  underline: (t) => t,
};

/** Test seam: forget the resolved markdown theme. */
export function resetMarkdownTheme(): void {
  cachedMarkdownTheme = undefined;
}

/** Exported for callers that only need the frame at a width (status bars, etc.). */
export type { Component };