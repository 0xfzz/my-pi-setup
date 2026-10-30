/**
 * The "access outside the workspace" dialog.
 *
 * Four answers, in the order the user is most likely to want them, and no
 * preselection: Escape denies, it never approves. Option 2 always prints the
 * literal glob it will save, because opencode's `save` patterns turned a single
 * "always" into a standing `$HOME` grant (issue #52715) — the widening must be
 * visible at the moment of consent, not discovered later in a config file.
 *
 * The fifth answer is opencode's reject-with-a-message: a denial that carries
 * what to do instead. It is a separate stage, not a second dialog, so backing
 * out returns to the options rather than discarding the question.
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
  /**
   * Present when the call is an opaque shell construct. There is no directory to
   * grant, so the standing answer is a rule scoped to the command's leading word
   * and the grant row offers that rule instead of a folder.
   */
  commandRule?: { action: string; resource: string };
  /** Number of other calls already waiting behind this one. */
  queued?: number;
}

export type ScopeAnswer =
  | { kind: "once" }
  | { kind: "allow"; grant: ScopeSuggestion }
  /** `feedback` turns a denial into an instruction the model can act on. */
  | { kind: "deny"; feedback?: string }
  | { kind: "rule"; text: string };

export interface ScopeAskPopupOptions extends ScopeAskRequest {
  theme?: PopupTheme;
  terminalRows?: () => number;
  onDone: (answer: ScopeAnswer) => void;
}

/** Where the popup is: choosing, typing a rule, or typing a denial note. */
type Stage = "permission" | "rule" | "reject";

const OPTION_COUNT = 5;
/** Body row for each option: the saved-glob line sits under "Allow …". */
const ROW_FOR_OPTION: readonly number[] = [0, 1, 3, 4, 5];
/** Which option a body row answers; the saved-glob line belongs to option 1. */
const OPTION_FOR_ROW: readonly number[] = [0, 1, 1, 2, 3, 4];

export class ScopeAskPopup implements Component, Focusable {
  private readonly options: ScopeAskPopupOptions;
  private readonly theme: PopupTheme;
  private readonly shell: PopupShell;
  private readonly ruleInput = new Input({ prompt: "Rule: ", placeholder: "action resource allow|ask|deny" });
  private readonly rejectInput = new Input({ prompt: "Deny: ", placeholder: "what to do instead" });
  private selected = 0;
  private stage: Stage = "permission";
  private finished = false;
  private isFocused = false;

  constructor(options: ScopeAskPopupOptions) {
    this.options = options;
    this.theme = options.theme ?? PLAIN_THEME;
    this.ruleInput.onSubmit = (value) => this.submitRule(value);
    this.ruleInput.onEscape = () => this.stopInput();
    this.rejectInput.onSubmit = (value) => this.submitReject(value);
    this.rejectInput.onEscape = () => this.stopInput();
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
    return this.stage === "permission" ? this.isFocused : this.activeInput().focused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.ruleInput.focused = value && this.stage === "rule";
    this.rejectInput.focused = value && this.stage === "reject";
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
    this.ruleInput.invalidate();
    this.rejectInput.invalidate();
    this.shell.invalidate();
  }

  dispose(): void {
    this.finished = true;
    this.ruleInput.focused = false;
    this.rejectInput.focused = false;
  }

  render(width: number): string[] {
    return this.shell.render(width);
  }

  private hint(): string {
    if (this.stage === "rule") return "Enter save rule · Esc back";
    if (this.stage === "reject") return "Enter deny with note · empty = plain deny · Esc back";
    return "↑↓ select · Enter choose · 1-5 · e rule · Esc deny";
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
    const rule = this.options.commandRule;
    const rows: PopupRow[] = [
      option(0, "Allow once"),
      rule ? option(1, `Allow ${rule.resource} commands (session)`) : option(1, grantLabel),
      theme.fg("dim", `      saves ${rule ? `${rule.action} ${rule.resource}` : suggestion.glob}`),
      option(2, "Deny"),
      option(3, "Deny with instructions…"),
      option(4, "Edit a rule…"),
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
    if (this.stage === "reject") {
      return {
        header,
        body: [
          ...wrapTextWithAnsi(theme.fg("dim", "Tell the model what to do instead:"), Math.max(8, width - 2)),
          ...this.rejectInput.render(width),
        ],
        footer: request.queued ? [theme.fg("warning", `${request.queued} more waiting`)] : undefined,
      };
    }
    if (this.stage === "rule") {
      return {
        header,
        body: [
          ...this.rows(width).filter((_row, index) => index !== ROW_FOR_OPTION[4]),
          "",
          ...wrapTextWithAnsi(theme.fg("dim", "Format: <tool|*> <glob> <allow|ask|deny>"), Math.max(8, width - 2)),
          ...this.ruleInput.render(width),
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
    if (this.stage !== "permission") {
      // The active Input owns keys while it is open; only Escape returns.
      if (isPopupCloseKey(data)) {
        this.stopInput();
        return true;
      }
      this.activeInput().handleInput(data);
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
    const option = OPTION_FOR_ROW[index];
    if (option === undefined) return false;
    this.choose(option);
    return true;
  }

  private revealRow(): number | undefined {
    return ROW_FOR_OPTION[this.selected];
  }

  private choose(index: number): void {
    const suggestion = this.options.suggestion;
    const rule = this.options.commandRule;
    if (index === 0) return this.finish({ kind: "once" });
    if (index === 1) {
      return this.finish(rule
        ? { kind: "rule", text: `${rule.action} ${rule.resource} allow` }
        : { kind: "allow", grant: suggestion });
    }
    if (index === 2) return this.finish({ kind: "deny" });
    if (index === 3) return this.startReject();
    this.startEditing();
  }

  private startEditing(): void {
    this.stage = "rule";
    this.ruleInput.focused = this.isFocused;
    this.rejectInput.focused = false;
    const rule = this.options.commandRule;
    setValueAtEnd(
      this.ruleInput,
      rule ? `${rule.action} ${rule.resource} allow` : `${this.options.tool} ${this.options.suggestion.glob} allow`,
    );
  }

  /** opencode's reject stage: empty means a plain deny, a note becomes guidance. */
  private startReject(): void {
    this.stage = "reject";
    this.ruleInput.focused = false;
    this.rejectInput.focused = this.isFocused;
    this.rejectInput.setValue("");
  }

  private stopInput(): void {
    this.stage = "permission";
    this.ruleInput.focused = false;
    this.rejectInput.focused = false;
  }

  private activeInput(): Input {
    return this.stage === "reject" ? this.rejectInput : this.ruleInput;
  }

  private submitRule(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      this.stopInput();
      return;
    }
    this.finish({ kind: "rule", text: trimmed });
  }

  private submitReject(text: string): void {
    const feedback = text.trim();
    this.finish(feedback ? { kind: "deny", feedback } : { kind: "deny" });
  }

  private finish(answer: ScopeAnswer): void {
    if (this.finished) return;
    this.finished = true;
    this.ruleInput.focused = false;
    this.rejectInput.focused = false;
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
