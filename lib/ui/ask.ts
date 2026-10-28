/**
 * ask_user popup: recommended answer, always-available free text, scrolling and
 * terminal-aware layout.
 *
 * A recommendation is a label, never a preselection: the user still has to act,
 * and Escape remains unanswered.
 */
import {
  Input,
  matchesKey,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { PLAIN_THEME, isPopupCloseKey, type PopupRow, type PopupTheme } from "../popup.ts";
import { PopupShell, type PopupShellModel } from "./shell.ts";
import { KEY_HINT } from "./tokens.ts";

export interface AskUserPopupOptions {
  question: string;
  context?: string;
  options?: readonly string[];
  /** 1-based option number to mark as the recommended answer. */
  recommended?: number;
  theme?: PopupTheme;
  terminalRows?: () => number;
  onDone: (answer: string | undefined) => void;
}

const OWN_ANSWER = "Type your own answer…";

export class AskUserPopup implements Component, Focusable {
  private readonly options: AskUserPopupOptions;
  private readonly theme: PopupTheme;
  private readonly shell: PopupShell;
  private readonly input = new Input({ prompt: "Answer: ", placeholder: "type your own answer" });
  private selected = 0;
  private typing: boolean;
  private finished = false;
  private isFocused = false;
  private renderTick = 0;

  constructor(options: AskUserPopupOptions) {
    this.options = options;
    this.theme = options.theme ?? PLAIN_THEME;
    this.typing = !options.options?.length;
    this.input.onSubmit = (value) => this.submit(value);
    this.input.onEscape = () => this.escapeFromInput();
    this.shell = new PopupShell({
      theme: this.theme,
      title: "Ask user",
      hint: () => this.hint(),
      terminalRows: options.terminalRows,
      model: (width) => this.model(width),
      onKey: (data) => this.handleKey(data),
      onBodyClick: (index) => this.handleBodyClick(index),
      reveal: () => this.revealRow(),
      onClose: () => this.finish(undefined),
    });
    this.input.focused = this.typing;
  }

  get focused(): boolean {
    return this.typing ? this.input.focused : this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.input.focused = value && this.typing;
  }

  /** Close from an AbortSignal without inventing an answer. */
  cancel(): void {
    this.finish(undefined);
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
    this.renderTick++;
    return this.shell.render(width);
  }

  private hint(): string {
    if (this.typing) return `${KEY_HINT.select} · Esc cancel`;
    const total = this.options.options?.length ?? 0;
    const recommended = this.options.recommended;
    const marker = recommended ? ` · ★ ${recommended}/${total}` : "";
    return `↑↓ select · ${KEY_HINT.select}${marker} · Esc cancel`;
  }

  private model(width: number): PopupShellModel {
    const theme = this.theme;
    const header: PopupRow[] = [theme.bold(this.options.question)];
    if (this.options.context) {
      header.push("");
      for (const line of wrapPlain(this.options.context, width)) {
        header.push(theme.fg("dim", line));
      }
    }
    header.push("");

    if (this.typing && !this.options.options?.length) {
      return { header, body: this.input.render(width) };
    }

    if (this.typing) {
      return {
        header,
        body: [
          ...this.optionRows(),
          "",
          ...this.input.render(width),
          theme.fg("dim", "Enter submit · Esc back"),
        ],
      };
    }

    return { header, body: this.optionRows() };
  }

  private optionRows(): PopupRow[] {
    const theme = this.theme;
    const options = this.options.options ?? [];
    const rows: PopupRow[] = [];
    for (let index = 0; index < options.length; index++) {
      const selected = index === this.selected;
      const marker = selected ? theme.fg("accent", "→ ") : "  ";
      const number = `${index + 1}. `;
      const recommended = this.options.recommended === index + 1
        ? "  " + theme.fg("accent", "(recommended answer)")
        : "";
      rows.push(marker + number + options[index] + recommended);
    }
    const ownSelected = this.selected === options.length;
    rows.push(
      (ownSelected ? theme.fg("accent", "→ ") : "  ") + "✎ " + OWN_ANSWER,
    );
    return rows;
  }

  private revealRow(): number {
    const options = this.options.options ?? [];
    if (!options.length) return 0;
    return Math.min(this.selected, options.length);
  }

  private handleKey(data: string): boolean {
    if (this.finished) return true;

    if (this.typing) {
      if (isPopupCloseKey(data)) {
        this.escapeFromInput();
        return true;
      }
      try {
        this.input.handleInput(data);
      } catch {
        this.finish(undefined);
      }
      return true;
    }

    const options = this.options.options ?? [];
    if (isPopupCloseKey(data)) {
      this.finish(undefined);
      return true;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.selected = Math.max(0, this.selected - 1);
      return true;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.selected = Math.min(options.length, this.selected + 1);
      return true;
    }
    if (/^[1-9]$/.test(data)) {
      const index = Number(data) - 1;
      if (index < options.length) {
        this.selected = index;
        this.submit(options[index]!);
      }
      return true;
    }
    if (matchesKey(data, "enter")) {
      if (this.selected >= options.length) {
        this.startTyping();
      } else {
        this.submit(options[this.selected]!);
      }
      return true;
    }
    return true;
  }

  private startTyping(): void {
    this.typing = true;
    this.input.focused = this.isFocused;
  }

  private escapeFromInput(): void {
    // Escape always means unanswered, including from the free-text row. Do not
    // make the user press it twice to leave a popup they wanted to cancel.
    this.finish(undefined);
  }

  private handleBodyClick(index: number): boolean {
    const options = this.options.options ?? [];
    if (!options.length || this.typing) return false;
    if (index < options.length) {
      this.selected = index;
      this.submit(options[index]!);
      return true;
    }
    if (index === options.length) {
      this.selected = index;
      this.startTyping();
      return true;
    }
    return false;
  }

  private submit(value: string): void {
    const answer = value.trim();
    if (!answer) {
      // Keep the popup open; empty input is not consent.
      return;
    }
    this.finish(answer);
  }

  private finish(answer: string | undefined): void {
    if (this.finished) return;
    this.finished = true;
    this.input.focused = false;
    this.options.onDone(answer);
  }
}

/** Small word wrapper for dim context lines, preserving explicit newlines. */
function wrapPlain(text: string, width: number): string[] {
  const safe = Math.max(1, width);
  const out: string[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    if (raw.length <= safe) {
      out.push(raw);
      continue;
    }
    let line = "";
    for (const word of raw.split(/\s+/)) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= safe) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [""];
}

/** Render tick used by tests to assert resize/reflow recomputes the body. */
export function askPopupRenderTick(popup: AskUserPopup): number {
  return (popup as unknown as { renderTick: number }).renderTick;
}
