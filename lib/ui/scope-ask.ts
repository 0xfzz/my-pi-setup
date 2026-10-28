/**
 * The "access outside the workspace" dialog.
 *
 * Four answers, in the order the user is most likely to want them, and no
 * preselection: Escape denies, it never approves. Option 2 always prints the
 * literal glob it will save, because opencode's `save` patterns turned a single
 * "always" into a standing `$HOME` grant (issue #52715) — the widening must be
 * visible at the moment of consent, not discovered later in a config file.
 */
import {
  Input,
  matchesKey,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { PLAIN_THEME, isPopupCloseKey, type PopupRow, type PopupTheme } from "../popup.ts";
import type { ScopeSuggestion } from "../scope/types.ts";
import { PopupShell, type PopupShellModel } from "./shell.ts";

export interface ScopeAskRequest {
  tool: string;
  /** Target as the user should read it: workspace-relative or absolute. */
  display: string;
  write: boolean;
  /** Why the gate asked, e.g. `outside the workspace`. */
  reason: string;
  suggestion: ScopeSuggestion;
  /** Number of other calls already waiting behind this one. */
  queued?: number;
}

export type ScopeAnswer =
  | { kind: "once" }
  | { kind: "allow"; grant: ScopeSuggestion }
  | { kind: "deny" }
  | { kind: "rule"; text: string };

export interface ScopeAskPopupOptions extends ScopeAskRequest {
  theme?: PopupTheme;
  terminalRows?: () => number;
  onDone: (answer: ScopeAnswer) => void;
}

const OPTION_COUNT = 4;

export class ScopeAskPopup implements Component, Focusable {
  private readonly options: ScopeAskPopupOptions;
  private readonly theme: PopupTheme;
  private readonly shell: PopupShell;
  private readonly input = new Input({ prompt: "Rule: ", placeholder: "action resource allow|ask|deny" });
  private selected = 0;
  private editing = false;
  private finished = false;
  private isFocused = false;

  constructor(options: ScopeAskPopupOptions) {
    this.options = options;
    this.theme = options.theme ?? PLAIN_THEME;
    this.input.onSubmit = (value) => this.submitRule(value);
    this.input.onEscape = () => this.stopEditing();
    this.shell = new PopupShell({
      theme: this.theme,
      title: "Access outside the workspace",
      hint: () => this.hint(),
      terminalRows: options.terminalRows,
      model: (width) => this.model(width),
      onKey: (data) => this.handleKey(data),
      onBodyClick: (index) => this.handleBodyClick(index),
      reveal: () => this.revealRow(),
      onClose: () => this.finish({ kind: "deny" }),
      pad: true,
    });
  }

  get focused(): boolean {
    return this.editing ? this.input.focused : this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.input.focused = value && this.editing;
  }

  /** Esc / abort: deny this call. Never "allow by timeout". */
  cancel(): void {
    this.finish({ kind: "deny" });
  }

  handleInput(data: string): void {
    this.shell.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.shell.handleMouse(event);
  }

  invalidate(): void {
    this.input.invalidate();
    this.shell.invalidate();
  }

  dispose(): void {
    this.finished = true;
    this.input.focused = false;
  }

  render(width: number): string[] {
    return this.shell.render(width);
  }

  private hint(): string {
    if (this.editing) return "Enter save rule · Esc back";
    return "↑↓ select · Enter choose · 1-4 · e rule · Esc deny";
  }

  private rows(width: number): PopupRow[] {
    const theme = this.theme;
    const suggestion = this.options.suggestion;
    const access = suggestion.access === "ro" ? "read-only" : "read-write";
    const option = (index: number, label: string): string => {
      const marker = this.selected === index ? theme.bold("›") : " ";
      return `${marker} ${index + 1}  ${label}`;
    };
    const grantLabel = suggestion.exact
      ? `Allow only this file (${access} · session)`
      : `Allow ${suggestion.path} (${access} · session)`;
    const rows: PopupRow[] = [
      option(0, "Allow once"),
      option(1, grantLabel),
      theme.fg("dim", `      saves ${suggestion.glob}`),
      option(2, "Deny"),
      option(3, "Edit a rule…"),
    ];
    void width;
    return rows;
  }

  private model(width: number): PopupShellModel {
    const theme = this.theme;
    const request = this.options;
    const header: PopupRow[] = [
      `${theme.bold(request.write ? "write" : "read")}  ${request.display}`,
      theme.fg("dim", request.reason),
      "",
    ];
    if (this.editing) {
      return {
        header,
        body: [
          ...this.rows(width).filter((row, index) => index !== 3),
          "",
          ...wrapTextWithAnsi(theme.fg("dim", "Format: <tool|*> <glob> <allow|ask|deny>"), Math.max(8, width - 2)),
          ...this.input.render(width),
        ],
        footer: request.queued ? [theme.fg("warning", `${request.queued} more waiting`)] : undefined,
      };
    }
    return {
      header,
      body: this.rows(width),
      footer: request.queued ? [theme.fg("warning", `${request.queued} more waiting`)] : undefined,
    };
  }

  private handleKey(data: string): boolean | void {
    if (this.editing) {
      // The Input owns keys while a rule is being typed; only Escape returns.
      if (isPopupCloseKey(data)) {
        this.stopEditing();
        return true;
      }
      this.input.handleInput(data);
      return true;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.selected = (this.selected + OPTION_COUNT - 1) % OPTION_COUNT;
      return true;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.selected = (this.selected + 1) % OPTION_COUNT;
      return true;
    }
    if (matchesKey(data, "enter")) {
      this.choose(this.selected);
      return true;
    }
    if (data === "e") {
      this.startEditing();
      return true;
    }
    for (let index = 0; index < OPTION_COUNT; index++) {
      if (data === String(index + 1)) {
        this.choose(index);
        return true;
      }
    }
    return false;
  }

  private handleBodyClick(index: number): boolean {
    // Body rows are: 0..4 option/save lines, so map the visible index back.
    const map = [0, 1, 1, 2, 3];
    const option = map[index];
    if (option === undefined) return false;
    this.choose(option);
    return true;
  }

  private revealRow(): number | undefined {
    return this.selected === 3 ? 4 : this.selected === 2 ? 3 : this.selected;
  }

  private choose(index: number): void {
    const suggestion = this.options.suggestion;
    if (index === 0) return this.finish({ kind: "once" });
    if (index === 1) return this.finish({ kind: "allow", grant: suggestion });
    if (index === 2) return this.finish({ kind: "deny" });
    this.startEditing();
  }

  private startEditing(): void {
    this.editing = true;
    this.input.focused = this.isFocused;
    setValueAtEnd(this.input, `${this.options.tool} ${this.options.suggestion.glob} allow`);
  }

  private stopEditing(): void {
    this.editing = false;
    this.input.focused = false;
  }

  private submitRule(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      this.stopEditing();
      return;
    }
    this.finish({ kind: "rule", text: trimmed });
  }

  private finish(answer: ScopeAnswer): void {
    if (this.finished) return;
    this.finished = true;
    this.input.focused = false;
    this.options.onDone(answer);
  }
}

/**
 * Fill the rule editor and put the cursor at the end.
 *
 * `Input.setValue` clamps the cursor to its current position — 0 for a fresh
 * input — so a user pressing Backspace on the prefilled rule deleted nothing and
 * concluded the editor was broken. The fields are `private` in the published
 * types but plain properties at runtime; the line-end key is the fallback when
 * that ever changes.
 */
export function setValueAtEnd(input: Input, value: string): void {
  input.setValue(value);
  const mutable = input as unknown as { value?: string; cursor?: number };
  if (typeof mutable.value === "string" && typeof mutable.cursor === "number") {
    mutable.cursor = mutable.value.length;
    return;
  }
  input.handleInput("\x05");
}
