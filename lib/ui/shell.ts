/**
 * Shared popup shell: frame + sticky header + scrollable body + sticky footer.
 *
 * `PopupPanel` remains the low-level "rows" component for tiny menus. New
 * pickers and detail views use this shell so scrolling, resize handling, mouse
 * wheel, paging and key hints cannot drift between dialogs.
 */
import {
  matchesKey,
  visibleWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  PLAIN_THEME,
  flattenPopupRows,
  isPopupCloseKey,
  popupFrame,
  type PopupRow,
  type PopupTheme,
} from "../popup/frame.ts";
import { popupBodyRows } from "./tokens.ts";

export interface PopupShellModel {
  header?: readonly PopupRow[];
  body: readonly PopupRow[];
  footer?: readonly PopupRow[];
}

export interface PopupShellOptions {
  theme?: PopupTheme;
  title?: string;
  /** Static hint or a supplier evaluated on every render (search state, counts). */
  hint?: string | (() => string);
  /** Terminal height supplier; defaults to the overlay's 24-row fallback. */
  terminalRows?: () => number;
  /** Desired total content rows (header + window + footer). */
  rows?: number;
  model: (width: number) => PopupShellModel;
  /** Called before the shell's scroll keys; return true to consume the key. */
  onKey?: (data: string) => boolean | void;
  onMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
  /** Body line click; return true when it was handled. */
  onBodyClick?: (index: number) => boolean | void;
  /** Body line that must stay visible (selection or active search match). */
  reveal?: () => number | undefined;
  /** Keep the popup height stable when the body is shorter than the viewport. */
  pad?: boolean;
  onClose?: () => void;
}

export class PopupShell implements Component {
  readonly options: PopupShellOptions;
  private scrollTop = 0;
  private lastWidth = 0;
  private lastHeader = 0;
  private lastViewport = 0;
  private lastBodyLength = 0;

  constructor(options: PopupShellOptions) {
    this.options = options;
  }

  get renderedWidth(): number {
    return this.lastWidth;
  }

  get top(): number {
    return this.scrollTop;
  }

  /** Body rows visible in the last render; callers page by exactly this. */
  get viewport(): number {
    return this.lastViewport;
  }

  scrollBy(delta: number): void {
    this.scrollTop += delta;
    this.clamp();
  }

  /** Reveal one body line, keeping the current viewport when already visible. */
  revealBodyLine(index: number): void {
    this.scrollTop = revealIndex(this.scrollTop, this.lastViewport, index);
    this.clamp();
  }

  private clamp(): void {
    const max = Math.max(0, this.lastBodyLength - this.lastViewport);
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, max));
  }

  handleInput(data: string): void {
    if (this.options.onKey?.(data)) return;
    if (isPopupCloseKey(data)) {
      this.options.onClose?.();
      return;
    }
    const page = Math.max(1, this.lastViewport - 2);
    if (matchesKey(data, "up") || data === "k") this.scrollBy(-1);
    else if (matchesKey(data, "down") || data === "j") this.scrollBy(1);
    else if (matchesKey(data, "pageUp")) this.scrollBy(-page);
    else if (matchesKey(data, "pageDown")) this.scrollBy(page);
    else if (matchesKey(data, "home") || data === "g") {
      this.scrollTop = 0;
      this.clamp();
    } else if (matchesKey(data, "end") || data === "G") {
      this.scrollTop = Number.MAX_SAFE_INTEGER;
      this.clamp();
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const handled = this.options.onMouse?.(event);
    if (handled) return handled;

    if (event.type === "wheel" && event.wheelDelta) {
      this.scrollBy(-Math.sign(event.wheelDelta) * Math.max(1, this.lastViewport - 2));
      return { handled: true, render: true };
    }

    if (event.type === "click" || event.type === "press") {
      const bodyIndex = this.scrollTop + (event.y - 2 - this.lastHeader);
      const localY = event.y - 2 - this.lastHeader;
      const inBody = localY >= 0 && localY < this.lastViewport;
      if (inBody && this.options.onBodyClick?.(bodyIndex)) {
        return { handled: true, render: true };
      }
      if (inBody && !this.options.onBodyClick) {
        // Detail views still page by thirds on click, matching MarkdownPopup.
        if (localY < this.lastViewport / 3) this.scrollBy(-Math.max(1, this.lastViewport - 2));
        else if (localY >= (this.lastViewport * 2) / 3) this.scrollBy(Math.max(1, this.lastViewport - 2));
        else return { handled: true, render: true };
        return { handled: true, render: true };
      }
      return undefined;
    }
    return undefined;
  }

  invalidate(): void {
    /* model() is the source of truth; nothing is cached across renders */
  }

  render(width: number): string[] {
    this.lastWidth = width;
    const theme = this.options.theme ?? PLAIN_THEME;
    const hint = typeof this.options.hint === "function" ? this.options.hint() : this.options.hint;
    const chrome = popupFrame(theme, width, { title: this.options.title, hint });
    const contentWidth = chrome?.contentWidth ?? Math.max(1, width);
    const model = this.options.model(contentWidth);
    const header = flattenPopupRows(model.header ?? [], contentWidth);
    const body = flattenPopupRows(model.body, contentWidth);
    const footer = flattenPopupRows(model.footer ?? [], contentWidth);

    const available = popupBodyRows(this.options.terminalRows?.() ?? 24, this.options.rows);
    // Chrome can exceed the budget on a short, narrow terminal: a hint line that
    // wraps costs two rows. The frame must never overflow the screen (the
    // overlay would be clipped mid-row), so the footer — hint text — yields
    // first, then the body may shrink to nothing.
    const visibleFooter = header.length + footer.length > available
      ? footer.slice(0, Math.max(0, available - header.length))
      : footer;
    const visibleHeader = header.slice(0, available);
    const rawViewport = Math.max(0, available - visibleHeader.length - visibleFooter.length);
    const viewport = Math.max(0, Math.min(rawViewport, Math.max(1, body.length)));

    this.lastHeader = visibleHeader.length;
    this.lastViewport = viewport;
    this.lastBodyLength = body.length;

    const reveal = this.options.reveal?.();
    if (reveal !== undefined && Number.isFinite(reveal)) {
      this.scrollTop = revealIndex(this.scrollTop, viewport, Math.max(0, Math.floor(reveal)));
    }
    this.clamp();

    const window = body.slice(this.scrollTop, this.scrollTop + viewport);
    if (this.options.pad) {
      while (window.length < viewport) window.push("");
    }
    const rows = [...visibleHeader, ...window, ...visibleFooter];

    if (!chrome) {
      const rule = theme.fg("border", "─".repeat(Math.max(1, width)));
      const painted = theme.bg
        ? rows.map((row) => {
            const fitted = visibleWidth(row) >= width ? row : row + " ".repeat(width - visibleWidth(row));
            return theme.bg!("userMessageBg", fitted);
          })
        : rows;
      return [rule, ...painted, rule];
    }

    return [
      chrome.topHintedRow,
      chrome.blankRow,
      ...chrome.body(rows),
      chrome.blankRow,
      chrome.bottomRow,
    ];
  }
}

function revealIndex(current: number, viewport: number, index: number): number {
  if (index < current) return index;
  if (index >= current + viewport) return index - viewport + 1;
  return current;
}

export interface PopupListContext {
  selected: boolean;
  index: number;
  width: number;
}

export interface PopupListOptions<T> {
  theme?: PopupTheme;
  title?: string;
  hint?: string | (() => string);
  items: readonly T[];
  renderItem: (item: T, context: PopupListContext) => PopupRow;
  onSelect: (item: T, index: number) => void;
  onCancel: () => void;
  initialIndex?: number;
  header?: readonly PopupRow[];
  emptyText?: string;
  numbered?: boolean;
  terminalRows?: () => number;
  /** Single click activates the row instead of only moving the cursor. */
  clickActivates?: boolean;
  /** Optional live filter. The caller applies it before constructing items. */
  onSearch?: (query: string) => void;
}

/** Virtualized, scrollable picker with the shared frame and key vocabulary. */
export class PopupList<T> implements Component, Focusable {
  readonly options: PopupListOptions<T>;
  private shell: PopupShell;
  private selected: number;
  private starts: number[] = [];
  private isFocused = false;

  constructor(options: PopupListOptions<T>) {
    this.options = options;
    this.selected = Math.max(0, Math.min(options.items.length - 1, options.initialIndex ?? 0));
    this.shell = new PopupShell({
      theme: options.theme,
      title: options.title,
      hint: options.hint ?? "↑↓ move · Enter select · Esc close",
      terminalRows: options.terminalRows,
      model: (width) => this.model(width),
      onKey: (data) => this.handleListKey(data),
      onBodyClick: (index) => this.handleBodyClick(index),
      reveal: () => this.starts[this.selected],
      onClose: options.onCancel,
    });
  }

  get selectedIndex(): number {
    return this.selected;
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
  }

  get renderedWidth(): number {
    return this.shell.renderedWidth;
  }

  setSelected(index: number): void {
    if (!this.options.items.length) return;
    this.selected = Math.max(0, Math.min(this.options.items.length - 1, index));
  }

  handleInput(data: string): void {
    this.shell.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.shell.handleMouse(event);
  }

  invalidate(): void {
    this.shell.invalidate();
  }

  render(width: number): string[] {
    return this.shell.render(width);
  }

  private model(width: number): PopupShellModel {
    const items = this.options.items;
    const header = [...(this.options.header ?? [])];
    if (items.length === 0) {
      return { header, body: [this.options.emptyText ?? "Nothing to show."] };
    }

    const body: PopupRow[] = [];
    this.starts = [];
    for (let index = 0; index < items.length; index++) {
      this.starts[index] = body.length;
      const row = this.options.renderItem(items[index]!, {
        selected: index === this.selected,
        index,
        width,
      });
      const lines = flattenPopupRows([row], width);
      const number = this.options.numbered && index < 9 ? `${index + 1}. ` : "";
      if (number && lines.length) {
        lines[0] = number + lines[0];
      }
      body.push(...lines);
    }
    return { header, body };
  }

  private handleBodyClick(bodyIndex: number): boolean {
    let index = 0;
    for (let i = 0; i < this.starts.length; i++) {
      if (bodyIndex >= this.starts[i]!) index = i;
    }
    if (index === this.selected && this.options.clickActivates) {
      this.options.onSelect(this.options.items[index]!, index);
      return true;
    }
    this.selected = index;
    if (this.options.clickActivates) {
      this.options.onSelect(this.options.items[index]!, index);
    }
    return true;
  }

  private handleListKey(data: string): boolean {
    const count = this.options.items.length;
    if (!count) {
      if (isPopupCloseKey(data)) this.options.onCancel();
      return true;
    }
    const page = 8;
    if (isPopupCloseKey(data) || data === "escape" || data === "\x1b") {
      this.options.onCancel();
      return true;
    }
    if (matchesKey(data, "enter") || data === "enter" || data === "\r") {
      this.options.onSelect(this.options.items[this.selected]!, this.selected);
      return true;
    }
    if (matchesKey(data, "up") || data === "k") this.setSelected(this.selected - 1);
    else if (matchesKey(data, "down") || data === "j") this.setSelected(this.selected + 1);
    else if (matchesKey(data, "pageUp")) this.setSelected(this.selected - page);
    else if (matchesKey(data, "pageDown")) this.setSelected(this.selected + page);
    else if (matchesKey(data, "home") || data === "g") this.setSelected(0);
    else if (matchesKey(data, "end") || data === "G") this.setSelected(count - 1);
    else if (/^[1-9]$/.test(data)) {
      const index = Number(data) - 1;
      if (index < count) {
        this.setSelected(index);
        this.options.onSelect(this.options.items[index]!, index);
      }
    } else {
      return false;
    }
    return true;
  }
}
