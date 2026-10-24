import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  Input, SelectList, matchesKey, truncateToWidth,
  type Component, type Focusable, type SelectListTheme, type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

export type ModelChoice = { id: string; name?: string };
export type ModelSelection = { ids: string[] } | { manual: true } | undefined;
const plain = (text: string) => text;
const plainTheme: SelectListTheme = {
  selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain,
};

/** Search owns text editing; the bounded SelectList owns navigation and scrolling. */
export class ProviderModelPicker implements Component, Focusable {
  readonly models: readonly ModelChoice[];
  #input = new Input({ prompt: "Search: ", placeholder: "model ID or name" });
  #selected = new Set<string>();
  #filtered: readonly ModelChoice[] = [];
  #list!: SelectList;
  #visible = 0;
  #listTop = 3;
  #closed = false;
  #done: (result: ModelSelection) => void;
  #requestRender: () => void;
  #rows: () => number;
  #theme: SelectListTheme;

  constructor(models: readonly ModelChoice[], done: (result: ModelSelection) => void,
    requestRender: () => void, rows = () => 24, theme = plainTheme) {
    this.models = models;
    this.#done = done;
    this.#requestRender = requestRender;
    this.#rows = rows;
    this.#theme = theme;
    this.#rebuild(false);
  }

  get focused(): boolean { return this.#input.focused; }
  set focused(value: boolean) { this.#input.focused = value; }

  #height(): number {
    const rows = this.#rows();
    return Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 24;
  }

  #rebuild(preserve: boolean): void {
    const current = preserve ? this.#list?.getSelectedItem()?.value : undefined;
    const terms = this.#input.getValue().toLowerCase().trim().split(/\s+/).filter(Boolean);
    this.#filtered = this.models.filter(model => terms.every(term =>
      `${model.id} ${model.name ?? ""}`.toLowerCase().includes(term)));
    // This is the overlay's screen budget, not an editor dock's available height.
    this.#visible = Math.max(1, Math.min(12, this.#height() - 8));
    this.#list = new SelectList(this.#filtered.map(model => ({
      value: model.id,
      label: `[${this.#selected.has(model.id) ? "x" : " "}] ${model.id}`,
      description: model.name,
    })), this.#visible, this.#theme);
    if (current) this.#list.setSelectedIndex(this.#filtered.findIndex(model => model.id === current));
    this.#list.onSelect = item => {
      if (this.#selected.has(item.value)) this.#selected.delete(item.value);
      else this.#selected.add(item.value);
      this.#rebuild(true);
    };
  }

  #finish(result: ModelSelection): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#done(result);
  }

  handleInput(data: string): void {
    if (this.#closed) return;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.#finish(undefined);
    else if (matchesKey(data, "ctrl+g")) this.#finish({ manual: true });
    else if (matchesKey(data, "enter")) {
      const current = this.#list.getSelectedItem()?.value;
      if (!this.#selected.size && current) this.#selected.add(current);
      if (this.#selected.size) this.#finish({ ids: this.models.filter(model => this.#selected.has(model.id)).map(model => model.id) });
    } else if (data === " " || matchesKey(data, "ctrl+a")) {
      const ids = matchesKey(data, "ctrl+a") ? this.#filtered.map(model => model.id)
        : [this.#list.getSelectedItem()?.value].filter((id): id is string => id !== undefined);
      const remove = ids.every(id => this.#selected.has(id));
      for (const id of ids) { if (remove) this.#selected.delete(id); else this.#selected.add(id); }
      this.#rebuild(true);
    } else if ((["up", "down", "pageUp", "pageDown"] as const).some(key => matchesKey(data, key))) {
      const page = matchesKey(data, "pageUp") || matchesKey(data, "pageDown");
      const direction = matchesKey(data, "up") || matchesKey(data, "pageUp") ? "\x1b[A" : "\x1b[B";
      for (let i = 0; i < (page ? this.#visible : 1); i++) this.#list.handleInput(direction);
    } else {
      const before = this.#input.getValue();
      this.#input.handleInput(data);
      if (this.#input.getValue() !== before) this.#rebuild(false);
    }
    this.#requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.#closed || event.y < this.#listTop || event.y >= this.#listTop + Math.min(this.#filtered.length, this.#visible)) return undefined;
    const result = this.#list.handleMouse({ ...event, y: event.y - this.#listTop });
    if (result?.handled) {
      this.#requestRender();
      return { ...result, render: true };
    }
    return result;
  }

  render(width: number): string[] {
    const columns = Math.max(0, Math.floor(width));
    if (columns < 4) return [""];
    const height = this.#height();
    if (this.#visible !== Math.max(1, Math.min(12, height - 8))) this.#rebuild(true);
    const list = this.#filtered.length ? this.#list.render(columns)
      : ["No matching models. Edit search or Ctrl+G for manual ID."];
    const count = `${this.#selected.size} selected · ${this.#filtered.length}/${this.models.length} matching`;
    let lines: string[];
    if (height < 7) {
      // Do not rely on overlay maxHeight slicing: that can hide the highlighted
      // row, search cursor, or confirmation hint on short terminals.
      const position = this.#filtered.findIndex(model => model.id === this.#list.getSelectedItem()?.value) + 1;
      this.#listTop = height === 1 ? 0 : height >= 5 ? 2 : 1;
      lines = [
        ...(height > 1 ? this.#input.render(columns) : []),
        ...(height >= 5 ? [count] : []),
        ...list.slice(0, this.#visible),
        ...(height >= 3 ? [`${position}/${this.#filtered.length} · ↑↓ scroll · Space toggle · Enter OK · Esc cancel`] : []),
      ];
    } else {
      this.#listTop = 3;
      lines = [
        "Select provider models", ...this.#input.render(columns), count, ...list,
        "↑/↓: scroll · PgUp/PgDn: page · Space: toggle · Ctrl+A: toggle all matches",
        "Enter: use selection (or highlighted model) · Ctrl+G: manual ID · Esc: cancel",
      ];
    }
    return lines.map(line => truncateToWidth(line, columns, ""));
  }

  invalidate(): void { this.#input.invalidate(); this.#list.invalidate(); }
}

export async function providerModelPicker(ctx: ExtensionCommandContext, models: readonly ModelChoice[]): Promise<ModelSelection> {
  if (ctx.mode === "tui") {
    return ctx.ui.custom<ModelSelection>((tui, theme, _kb, done) => new ProviderModelPicker(
      models, done, () => tui.requestRender(), () => tui.terminal.rows,
      { selectedPrefix: text => theme.fg("accent", text), selectedText: text => theme.fg("accent", text),
        description: text => theme.fg("muted", text), scrollInfo: text => theme.fg("dim", text), noMatch: text => theme.fg("warning", text) },
    ), {
      // Inline custom UI replaces only the editor. Its dock is shorter than the
      // terminal (widgets/footer still consume rows), so a terminal-sized list
      // gets clipped. An overlay owns its viewport and keyboard focus instead.
      overlay: true,
      overlayOptions: { anchor: "center", width: "90%", maxHeight: "100%", margin: 0 },
    });
  }
  // RPC supports standard dialogs, not custom terminal components.
  const selected = new Set<string>();
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
    const id = models[index].id;
    if (selected.has(id)) selected.delete(id); else selected.add(id);
  }
}
