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
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { PLAIN_THEME, isPopupCloseKey, wrapRowWithHangingIndent, type PopupRow, type PopupTheme } from "../popup.ts";
import { PopupShell, type PopupShellModel } from "./shell.ts";
import { KEY_HINT } from "./tokens.ts";

export type AskAnswer =
  | { kind: "option"; value: string }
  | { kind: "text"; value: string };

export interface AskUserPopupOptions {
  question: string;
  context?: string;
  options?: readonly string[];
  /** 1-based option number to mark as the recommended answer. */
  recommended?: number;
  theme?: PopupTheme;
  terminalRows?: () => number;
  onDone: (answer: AskAnswer | undefined) => void;
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
  private validationError?: string;
  private starts: number[] = [];
  private inputLineIndex = 0;

  constructor(options: AskUserPopupOptions) {
    this.options = options;
    this.theme = options.theme ?? PLAIN_THEME;
    this.typing = !options.options?.length;
    this.input.onSubmit = (value) => this.submit(value, false);
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
    const header: PopupRow[] = [];
    for (const line of wrapTextWithAnsi(theme.bold(this.options.question), width)) {
      header.push(line);
    }
    if (this.options.context) {
      header.push("");
      const contextLines = wrapTextWithAnsi(this.options.context, width);
      const maxContextLines = 6;
      if (contextLines.length > maxContextLines) {
        for (let i = 0; i < maxContextLines; i++) {
          header.push(theme.fg("dim", contextLines[i]!));
        }
        header.push(theme.fg("dim", "… (context truncated; Esc to cancel)"));
      } else {
        for (const line of contextLines) {
          header.push(theme.fg("dim", line));
        }
      }
    }
    header.push("");

    if (this.typing && !this.options.options?.length) {
      const body: PopupRow[] = [...this.input.render(width)];
      this.inputLineIndex = 0;
      if (this.validationError) {
        body.push(theme.fg("warning", this.validationError));
      }
      return { header, body };
    }

    if (this.typing) {
      const optRows = this.optionRows(width);
      const body: PopupRow[] = [
        ...optRows,
        "",
        ...this.input.render(width),
      ];
      this.inputLineIndex = optRows.length + 1;
      if (this.validationError) {
        body.push(theme.fg("warning", this.validationError));
      } else {
        body.push(theme.fg("dim", "Enter submit · Esc back"));
      }
      return { header, body };
    }

    return { header, body: this.optionRows(width) };
  }

  private optionRows(width: number): PopupRow[] {
    const theme = this.theme;
    const options = this.options.options ?? [];
    const rows: PopupRow[] = [];
    this.starts = [];
    for (let index = 0; index < options.length; index++) {
      this.starts[index] = rows.length;
      const selected = !this.typing && index === this.selected;
      const marker = selected ? theme.fg("accent", "→ ") : "  ";
      const number = `${index + 1}. `;
      const recommended = this.options.recommended === index + 1
        ? "  " + theme.fg("accent", "(recommended answer)")
        : "";
      const rawLine = marker + number + options[index] + recommended;
      const wrapped = wrapRowWithHangingIndent(rawLine, width);
      for (const line of wrapped) {
        rows.push(line);
      }
    }
    const ownIndex = options.length;
    this.starts[ownIndex] = rows.length;
    const ownSelected = !this.typing && this.selected === ownIndex;
    const ownMarker = ownSelected ? theme.fg("accent", "→ ") : "  ";
    const ownLine = ownMarker + "✎ " + OWN_ANSWER;
    for (const line of wrapRowWithHangingIndent(ownLine, width)) {
      rows.push(line);
    }
    return rows;
  }

  private revealRow(): number {
    if (this.typing) {
      return this.inputLineIndex;
    }
    const target = this.starts[this.selected];
    return target !== undefined ? target : 0;
  }

  private handleKey(data: string): boolean {
    if (this.finished) return true;

    if (this.typing) {
      if (isPopupCloseKey(data)) {
        this.escapeFromInput();
        return true;
      }
      if (this.validationError) {
        this.validationError = undefined;
        this.shell.invalidate();
      }
      try {
        this.input.handleInput(data);
      } catch (err) {
        this.validationError = `Input error: ${err instanceof Error ? err.message : String(err)}`;
        this.shell.invalidate();
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
        this.submit(options[index]!, true);
      }
      return true;
    }
    if (matchesKey(data, "enter")) {
      if (this.selected >= options.length) {
        this.startTyping();
      } else {
        this.submit(options[this.selected]!, true);
      }
      return true;
    }
    return true;
  }

  private startTyping(): void {
    this.typing = true;
    this.input.focused = this.isFocused;
    this.validationError = undefined;
    this.shell.invalidate();
  }

  private escapeFromInput(): void {
    // Escape always means unanswered, including from the free-text row. Do not
    // make the user press it twice to leave a popup they wanted to cancel.
    this.finish(undefined);
  }

  private handleBodyClick(lineIndex: number): boolean {
    const options = this.options.options ?? [];
    if (!options.length || this.typing) return false;
    for (let i = this.starts.length - 1; i >= 0; i--) {
      if (lineIndex >= this.starts[i]!) {
        this.selected = i;
        if (i < options.length) {
          this.submit(options[i]!, true);
        } else {
          this.startTyping();
        }
        return true;
      }
    }
    return false;
  }

  private submit(value: string, fromOption = false): void {
    const answer = value.trim();
    if (!answer) {
      // Keep the popup open; empty input is not consent.
      this.validationError = "An answer is required. Esc leaves it unanswered.";
      this.shell.invalidate();
      return;
    }
    this.finish({ kind: fromOption ? "option" : "text", value: answer });
  }

  private finish(answer: AskAnswer | undefined): void {
    if (this.finished) return;
    this.finished = true;
    this.input.focused = false;
    this.options.onDone(answer);
  }
}
