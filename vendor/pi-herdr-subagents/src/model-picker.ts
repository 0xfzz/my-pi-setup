import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { Component, Focusable, SelectItem, SelectListTheme } from "@mariozechner/pi-tui";
import { Input, SelectList, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export interface ModelPickerItem {
  value: string;
  label: string;
  description?: string;
}

export interface ModelPickerTheme {
  selectedPrefix?: (text: string) => string;
  selectedText?: (text: string) => string;
  description?: (text: string) => string;
  scrollInfo?: (text: string) => string;
  noMatch?: (text: string) => string;
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

export class SubagentModelPicker implements Component, Focusable {
  readonly items: readonly ModelPickerItem[];
  readonly current: string;
  #done: (result: string | undefined) => void;
  #requestRender: () => void;
  #getRows: () => number;
  #theme: ModelPickerTheme;

  #input: Input;
  #list!: SelectList;
  #filtered: ModelPickerItem[] = [];
  #visible = 10;
  #closed = false;

  constructor(
    items: readonly ModelPickerItem[],
    current: string,
    done: (result: string | undefined) => void,
    requestRender: () => void,
    getRows: () => number = () => 24,
    theme: ModelPickerTheme = {},
  ) {
    this.items = items;
    this.current = current;
    this.#done = done;
    this.#requestRender = requestRender;
    this.#getRows = getRows;
    this.#theme = theme;

    this.#input = new Input();
    this.#input.focused = true;

    this.#rebuild(false);
  }

  get focused(): boolean {
    return this.#input.focused;
  }

  set focused(value: boolean) {
    this.#input.focused = value;
  }

  get selectedIndex(): number {
    return (this.#list as any).selectedIndex ?? 0;
  }

  get filteredCount(): number {
    return this.#filtered.length;
  }

  #height(): number {
    const rows = this.#getRows();
    return Number.isFinite(rows) ? Math.max(10, Math.floor(rows)) : 24;
  }

  #rebuild(preserveSelection: boolean): void {
    const previous = preserveSelection ? this.#list?.getSelectedItem()?.value : undefined;
    const query = this.#input.getValue().trim().toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);

    this.#filtered = this.items.filter((item) => {
      if (terms.length === 0) return true;
      const haystack = `${item.value} ${item.label} ${item.description ?? ""}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });

    const height = this.#height();
    // Bounded visible rows so picker never overflows the terminal window
    this.#visible = Math.max(3, Math.min(12, height - 9));

    const fg = (color: string, text: string) => {
      try {
        return this.#theme.fg ? this.#theme.fg(color, text) : text;
      } catch {
        return text;
      }
    };

    const selectTheme: SelectListTheme = {
      selectedPrefix: this.#theme.selectedPrefix ?? ((s) => s),
      selectedText: this.#theme.selectedText ?? ((s) => fg("accent", s)),
      description: this.#theme.description ?? ((s) => fg("muted", s)),
      scrollInfo: this.#theme.scrollInfo ?? ((s) => fg("dim", s)),
      noMatch: this.#theme.noMatch ?? ((s) => fg("warning", s)),
    };

    this.#list = new SelectList(this.#filtered, this.#visible, selectTheme);

    if (previous) {
      const idx = this.#filtered.findIndex((item) => item.value === previous);
      if (idx >= 0) {
        this.#list.setSelectedIndex(idx);
      } else {
        this.#list.setSelectedIndex(0);
      }
    } else {
      this.#list.setSelectedIndex(0);
    }

    this.#list.onSelect = (item) => this.#finish(item.value);
    this.#list.onCancel = () => this.#finish(undefined);
  }

  #finish(result: string | undefined): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#done(result);
  }

  handleInput(data: string): void {
    if (this.#closed) return;

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.#finish(undefined);
      return;
    }

    if (matchesKey(data, "enter")) {
      const selected = this.#list.getSelectedItem();
      if (selected) {
        this.#finish(selected.value);
      } else {
        this.#finish(undefined);
      }
      return;
    }

    if (matchesKey(data, "up")) {
      this.#list.handleInput("\x1b[A");
      this.#requestRender();
      return;
    }

    if (matchesKey(data, "down")) {
      this.#list.handleInput("\x1b[B");
      this.#requestRender();
      return;
    }

    if (matchesKey(data, "pageUp")) {
      for (let i = 0; i < this.#visible; i++) {
        this.#list.handleInput("\x1b[A");
      }
      this.#requestRender();
      return;
    }

    if (matchesKey(data, "pageDown")) {
      for (let i = 0; i < this.#visible; i++) {
        this.#list.handleInput("\x1b[B");
      }
      this.#requestRender();
      return;
    }

    if (matchesKey(data, "home")) {
      this.#list.setSelectedIndex(0);
      this.#requestRender();
      return;
    }

    if (matchesKey(data, "end")) {
      this.#list.setSelectedIndex(Math.max(0, this.#filtered.length - 1));
      this.#requestRender();
      return;
    }

    // Characters / backspace / typing routed to the search box
    const before = this.#input.getValue();
    this.#input.handleInput(data);
    if (this.#input.getValue() !== before) {
      this.#rebuild(false);
    }
    this.#requestRender();
  }

  invalidate(): void {
    this.#input.invalidate();
    this.#list.invalidate();
  }

  render(width: number): string[] {
    const columns = Math.max(20, Math.floor(width));
    const innerWidth = Math.max(10, columns - 4);

    const fg = (color: string, text: string) => {
      try {
        return this.#theme.fg ? this.#theme.fg(color, text) : text;
      } catch {
        return text;
      }
    };
    const bold = (text: string) => {
      try {
        return this.#theme.bold ? this.#theme.bold(text) : text;
      } catch {
        return text;
      }
    };

    const borderStyle = (s: string) => fg("accent", s);
    const titleText = bold("Select Subagent Default Model");
    const currentText = `Current default: ${fg("accent", this.current)}`;
    const hintText = fg("dim", "↑/↓: scroll · PgUp/PgDn: page · Enter: select · Esc: cancel");

    const pad = (s: string) => {
      const truncated = truncateToWidth(s, innerWidth, "");
      const gap = Math.max(0, innerWidth - visibleWidth(truncated));
      return `${borderStyle("│")} ${truncated}${" ".repeat(gap)} ${borderStyle("│")}`;
    };

    const topTitle = `─ ${titleText} `;
    const topFill = "─".repeat(Math.max(0, innerWidth + 2 - visibleWidth(topTitle)));
    const top = `${borderStyle("╭")}${borderStyle(topTitle)}${borderStyle(topFill)}${borderStyle("╮")}`;
    const mid = `${borderStyle("├")}${borderStyle("─".repeat(innerWidth + 2))}${borderStyle("┤")}`;
    const bot = `${borderStyle("╰")}${borderStyle("─".repeat(innerWidth + 2))}${borderStyle("╯")}`;

    const searchPrompt = fg("muted", "Search: ");
    const inputLines = this.#input.render(Math.max(10, innerWidth - visibleWidth(searchPrompt)));
    const renderedInput = `${searchPrompt}${inputLines[0] ?? ""}`;

    const listLines =
      this.#filtered.length > 0
        ? this.#list.render(innerWidth)
        : [fg("warning", "  No matching models found")];

    const lines = [
      top,
      pad(currentText),
      pad(renderedInput),
      mid,
      ...listLines.map((line) => pad(line)),
      mid,
      pad(hintText),
      bot,
    ];

    return lines.map((line) => truncateToWidth(line, columns, ""));
  }
}

/**
 * Show an interactive, searchable, scrollable model picker dialog.
 * Uses ctx.ui.custom with overlay when available in TUI mode, or falls back to ctx.ui.select.
 */
export async function selectSubagentModel(
  ctx: ExtensionCommandContext,
  items: ModelPickerItem[],
  current: string,
): Promise<string | undefined> {
  const ui = ctx.ui as any;

  if (typeof ui?.custom === "function") {
    return ui.custom(
      (tui: any, theme: any, _kb: any, done: (result: string | undefined) => void) =>
        new SubagentModelPicker(
          items,
          current,
          done,
          () => tui.requestRender?.(),
          () => tui.terminal?.rows ?? 24,
          theme,
        ),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "85%", maxHeight: "90%", margin: 0 },
      },
    );
  }

  // Fallback for non-TUI environments or mocks without custom UI
  if (typeof ui?.select === "function") {
    const labels = items.map((item) => item.value);
    return ui.select(`Select subagent default model (current: ${current}):`, labels);
  }

  return undefined;
}
