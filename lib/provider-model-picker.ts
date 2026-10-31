import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  visibleWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { PLAIN_THEME, POPUP_FRAME_ROWS, POPUP_MARGIN, type PopupRow, type PopupTheme } from "./popup.ts";
import { PopupShell, type PopupShellModel } from "./ui/shell.ts";
import { popupBodyRows } from "./ui/tokens.ts";

/**
 * One pickable model.
 *
 * `name` is the display name; `detail` is the catalog facts `/models` prints
 * (context, output limit, thinking, images) so a route target is chosen with
 * the same information the model list gives.
 */
export type ModelChoice = { id: string; name?: string; detail?: string };
export type ModelSelection = { ids: string[] } | { manual: true } | undefined;

/** Display name and catalog facts on one line, like `/models` shows them. */
export function describeChoice(model: ModelChoice): string | undefined {
  const parts = [model.name, model.detail].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" · ") : undefined;
}

/** Below this height the frame cannot fit a single row, so the chrome degrades. */
const MIN_FRAMED_ROWS = POPUP_FRAME_ROWS + 2 * POPUP_MARGIN + 2;

/**
 * Multi-select model picker.
 *
 * Renders through the shared `PopupShell` so it has the same frame, title,
 * hint line and scrolling as every other editor in this package; the search
 * field, the selection markers and the keyboard vocabulary are the picker's
 * own. Search owns text editing, the cursor owns navigation.
 */
export class ProviderModelPicker implements Component, Focusable {
  readonly models: readonly ModelChoice[];
  private readonly done: (result: ModelSelection) => void;
  private readonly requestRender: () => void;
  private readonly terminalRows: () => number;
  private readonly theme: PopupTheme;
  private readonly input = new Input({ prompt: "Search: ", placeholder: "model ID or name" });
  private readonly shell: PopupShell;
  private selected: Set<string>;
  private filtered: readonly ModelChoice[] = [];
  private cursor = 0;
  private closed = false;
  private layout: { firstRow: number[]; entryForRow: number[] } = { firstRow: [], entryForRow: [] };
  /** Event type of the mouse event being handled; the shell reports only a row. */
  private mouseType: TuiMouseEvent["type"] = "click";
  private pressedRow?: number;

  constructor(
    models: readonly ModelChoice[],
    done: (result: ModelSelection) => void,
    requestRender: () => void,
    rows = () => 24,
    theme: PopupTheme = PLAIN_THEME,
    /** Ids to start ticked, so reopening a saved selection shows it. */
    preselected: readonly string[] = [],
  ) {
    this.models = models;
    this.done = done;
    this.requestRender = requestRender;
    this.terminalRows = rows;
    this.theme = theme;
    this.selected = new Set(preselected.filter(id => models.some(model => model.id === id)));
    this.filtered = models;
    this.shell = new PopupShell({
      theme,
      title: "Select models",
      hint: () => this.hint(),
      terminalRows: rows,
      model: (width) => this.model(width),
      onKey: (data) => this.handleKey(data),
      onBodyClick: (index) => this.toggleAt(index),
      reveal: () => this.layout.firstRow[this.cursor],
      onClose: () => this.finish(undefined),
      pad: true,
    });
  }

  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) {
    this.input.focused = value;
  }

  handleInput(data: string): void {
    if (this.closed) return;
    this.shell.handleInput(data);
    this.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.closed) return undefined;
    // The wheel moves the highlight rather than scrolling a list the keyboard
    // moves anyway; a wheel that only scrolled would hide the row the user is
    // pointing at and leave the background transcript alone, which is confusing.
    if (event.type === "wheel" && event.wheelDelta) {
      this.move(event.wheelDelta < 0 ? -1 : 1);
      this.requestRender();
      return { handled: true, render: true };
    }
    this.mouseType = event.type;
    const result = this.shell.handleMouse(event);
    if (result?.handled) this.requestRender();
    return result;
  }

  invalidate(): void {
    this.input.invalidate();
    this.shell.invalidate();
  }

  dispose(): void {
    this.closed = true;
    this.input.focused = false;
  }

  render(width: number): string[] {
    const columns = Math.max(0, Math.floor(width));
    if (columns < 4) return [""];
    // At a height where the frame alone fills the screen, the shared chrome
    // cannot help; degrade to the rows themselves instead of overflowing.
    if (this.terminalRows() < MIN_FRAMED_ROWS) return this.compact(columns);
    return this.shell.render(columns).map(line => (visibleWidth(line) > columns ? line.slice(0, columns) : line));
  }

  // ---- view ----------------------------------------------------------------

  private hint(): string {
    const position = this.filtered.length ? `${this.cursor + 1}/${this.filtered.length}` : "0/0";
    // The frame's title row is always exactly one line, so the keys that are
    // nice-to-have live here and the essential ones live in the footer, which
    // is the only other row the chrome can afford on a short terminal.
    return `${position} · Ctrl+A all · Ctrl+G manual`;
  }

  private countLine(): string {
    return `${this.selected.size} selected · ${this.filtered.length}/${this.models.length} matching`;
  }

  private model(width: number): PopupShellModel {
    const theme = this.theme;
    // Two header rows and one footer row fit comfortably; on an 8-row terminal
    // the frame leaves three, so the count line yields rather than the models:
    // the position is already in the frame title, and an empty list is useless.
    const budget = popupBodyRows(this.terminalRows());
    const header: PopupRow[] = [
      ...this.input.render(width),
      ...(budget - 3 >= 1 ? [theme.fg("dim", this.countLine())] : []),
    ];
    const body: PopupRow[] = [];
    const firstRow: number[] = [];
    const entryForRow: number[] = [];
    if (!this.filtered.length) {
      body.push(theme.fg("warning", "No matching models. Edit the search or Ctrl+G for a manual ID."));
    }
    this.filtered.forEach((model, index) => {
      firstRow[index] = body.length;
      const marker = index === this.cursor ? "→ " : "  ";
      const tick = this.selected.has(model.id) ? "x" : " ";
      const id = theme.fg(index === this.cursor ? "accent" : "text", model.id);
      const facts = describeChoice(model);
      body.push(`${marker}[${tick}] ${id}${facts ? `  ${theme.fg("dim", facts)}` : ""}`);
      entryForRow.push(index);
    });
    this.layout = { firstRow, entryForRow };
    // One short line: a hint that wraps costs a model row, and on a short
    // terminal the wrapper can overflow the frame entirely.
    const footer: PopupRow[] = [theme.fg("dim", "PgUp/PgDn page · Space toggle · Enter use · Esc cancel")];
    return { header, body, footer };
  }

  /** Unframed rows for terminals too short to hold the frame plus a row. */
  private compact(width: number): string[] {
    const height = this.terminalRows();
    const theme = this.theme;
    const position = this.filtered.length ? `${this.cursor + 1}/${this.filtered.length}` : "0/0";
    const rows: string[] = [];
    if (height > 1) rows.push(...this.input.render(width));
    if (height >= 5) rows.push(theme.fg("dim", this.countLine()));
    const visible = Math.max(1, height - rows.length - (height >= 3 ? 1 : 0));
    const from = Math.max(0, Math.min(this.cursor, Math.max(0, this.filtered.length - visible)));
    const slice = this.filtered.slice(from, from + visible);
    if (!slice.length) rows.push(theme.fg("warning", "No matching models."));
    this.layout = { firstRow: slice.map((_, index) => rows.length + index), entryForRow: slice.map((_, index) => from + index) };
    for (const [index, model] of slice.entries()) {
      const absolute = from + index;
      const marker = absolute === this.cursor ? "→ " : "  ";
      const tick = this.selected.has(model.id) ? "x" : " ";
      rows.push(`${marker}[${tick}] ${theme.fg("text", model.id)}`);
    }
    if (height >= 3) {
      // Only the two keys that finish the picker survive a 4-row terminal; the
      // arrows are discoverable from the highlight itself.
      rows.push(theme.fg("dim", `${position} · Enter use · Esc cancel`));
    }
    return rows.slice(0, Math.max(1, height)).map(line => (visibleWidth(line) > width ? line.slice(0, width) : line));
  }

  // ---- selection -----------------------------------------------------------

  private page(): number {
    return Math.max(1, this.shell.viewport);
  }

  private refilter(preserveCursor: boolean): void {
    const current = this.filtered[this.cursor]?.id;
    const terms = this.input.getValue().toLowerCase().trim().split(/\s+/).filter(Boolean);
    this.filtered = this.models.filter(model => terms.every(term =>
      `${model.id} ${model.name ?? ""}`.toLowerCase().includes(term)));
    const index = preserveCursor && current ? this.filtered.findIndex(model => model.id === current) : -1;
    this.cursor = index >= 0 ? index : 0;
  }

  private move(delta: number): void {
    const count = this.filtered.length;
    if (!count) return;
    // Wrap like the rest of the package's pickers: one Up from the top reaches
    // the last model instead of doing nothing.
    this.cursor = ((this.cursor + delta) % count + count) % count;
  }

  private toggleAt(row: number): boolean {
    const index = this.layout.entryForRow[row];
    if (index === undefined) return false;
    this.cursor = Math.max(0, Math.min(index, this.filtered.length - 1));
    // A physical click arrives as press then click; toggling on both would undo
    // the selection the press just made. Only the press toggles.
    if (this.mouseType === "click" && this.pressedRow === row) {
      this.pressedRow = undefined;
      this.requestRender();
      return true;
    }
    if (this.mouseType === "press") this.pressedRow = row;
    this.toggle([this.filtered[this.cursor]?.id]);
    this.requestRender();
    return true;
  }

  private toggle(ids: (string | undefined)[]): void {
    const present = ids.filter((id): id is string => id !== undefined);
    if (!present.length) return;
    const remove = present.every(id => this.selected.has(id));
    for (const id of present) {
      if (remove) this.selected.delete(id);
      else this.selected.add(id);
    }
  }

  private accept(): void {
    const current = this.filtered[this.cursor]?.id;
    if (!this.selected.size && current) this.selected.add(current);
    if (this.selected.size) {
      this.finish({ ids: this.models.filter(model => this.selected.has(model.id)).map(model => model.id) });
    }
  }

  private handleKey(data: string): boolean | void {
    if (this.closed) return true;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.finish(undefined);
      return true;
    }
    if (matchesKey(data, "ctrl+g")) {
      this.finish({ manual: true });
      return true;
    }
    if (matchesKey(data, "enter")) {
      this.accept();
      return true;
    }
    if (data === " " || matchesKey(data, "ctrl+a")) {
      const ids = matchesKey(data, "ctrl+a")
        ? this.filtered.map(model => model.id)
        : [this.filtered[this.cursor]?.id];
      this.toggle(ids);
      return true;
    }
    if (matchesKey(data, "up") || data === "k") { this.move(-1); return true; }
    if (matchesKey(data, "down") || data === "j") { this.move(1); return true; }
    if (matchesKey(data, "pageUp")) { this.move(-this.page()); return true; }
    if (matchesKey(data, "pageDown")) { this.move(this.page()); return true; }
    if (matchesKey(data, "home")) { this.cursor = 0; return true; }
    if (matchesKey(data, "end")) { this.cursor = Math.max(0, this.filtered.length - 1); return true; }
    const before = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== before) this.refilter(false);
    return true;
  }

  private finish(result: ModelSelection): void {
    if (this.closed) return;
    this.closed = true;
    this.input.focused = false;
    this.done(result);
  }
}

export async function providerModelPicker(
  ctx: ExtensionCommandContext,
  models: readonly ModelChoice[],
  preselected: readonly string[] = [],
): Promise<ModelSelection> {
  if (ctx.mode === "tui") {
    return ctx.ui.custom<ModelSelection>((tui, theme, _kb, done) => new ProviderModelPicker(
      models, done, () => tui.requestRender(), () => tui.terminal.rows, theme, preselected,
    ), {
      // Inline custom UI replaces only the editor. Its dock is shorter than the
      // terminal (widgets/footer still consume rows), so a terminal-sized list
      // gets clipped. An overlay owns its viewport and keyboard focus instead.
      overlay: true,
      overlayOptions: { anchor: "center", width: "90%", maxHeight: "100%", margin: 0 },
    });
  }
  // RPC supports standard dialogs, not custom terminal components.
  const selected = new Set<string>(preselected.filter(id => models.some(model => model.id === id)));
  const manual = "Enter model ID manually";
  for (;;) {
    const finish = `Use selected models (${selected.size})`;
    const labels = models.map(model => `[${selected.has(model.id) ? "x" : " "}] Model: ${model.id}`);
    const choice = await ctx.ui.select("Select models to add/update", [...labels, ...(selected.size ? [finish] : []), manual]);
    if (choice === undefined) return undefined;
    if (choice === manual) return { manual: true };
    if (selected.size && choice === finish) return { ids: models.filter(model => selected.has(model.id)).map(model => model.id) };
    const index = labels.indexOf(choice);
    if (index < 0) throw new Error("Invalid model selection; nothing was saved.");
    const id = models[index]!.id;
    if (selected.has(id)) selected.delete(id); else selected.add(id);
  }
}
