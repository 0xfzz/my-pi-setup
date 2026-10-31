/**
 * The "access outside the workspace" dialog.
 *
 * Six answers, and no preselection: Escape denies, it never approves. The four
 * grants are the two axes the question actually has:
 *
 *   the target  — this one file, or everything in its folder (`dir/*`)
 *   the lifetime — this call / this session, or this workspace (a config write)
 *
 * Every persisting answer prints the literal value it stores and the file it
 * stores it in, because opencode's invisible `save` patterns turned a single
 * "always" into a standing `$HOME` grant (issue #52715) — the widening must be
 * visible at the moment of consent, not discovered later in a config file.
 *
 * "Deny with reason" is opencode's reject-with-a-message: a denial that carries
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
import { toResourceSlash } from "../scope/paths.ts";
import type { ScopeSuggestion } from "../scope/types.ts";
import { PopupShell, type PopupShellModel } from "./shell.ts";

export interface ScopeAskRequest {
  tool: string;
  /** Target as the user should read it: workspace-relative or absolute. */
  display: string;
  /** Canonical target, so a single-file grant never stores its folder. */
  absolute: string;
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
  /** `persist: "workspace"` means the grant is also written to `.pi/scope.json`. */
  | { kind: "allow"; grant: ScopeSuggestion; persist?: "workspace" }
  /** `feedback` turns a denial into an instruction the model can act on. */
  | { kind: "deny"; feedback?: string }
  | { kind: "rule"; text: string };

export interface ScopeChoice {
  label: string;
  /** Dim line under the label: the literal value stored, and where. */
  detail?: string;
  /** The answer this row gives, or the stage it opens. */
  action: { kind: "answer"; answer: ScopeAnswer } | { kind: "reject" };
}

/** The file a "for this workspace" answer is written to. */
const WORKSPACE_CONFIG = ".pi/scope.json";

/**
 * The answers, in one place.
 *
 * The TUI popup and the plain `select` fallback render the same list, so the two
 * surfaces cannot drift into offering different grants under the same wording.
 */
export function scopeChoices(request: ScopeAskRequest): ScopeChoice[] {
  const { suggestion } = request;
  const rule = request.commandRule;
  if (rule) {
    return [
      { label: "Allow once", action: { kind: "answer", answer: { kind: "once" } } },
      {
        label: `Allow ${rule.resource} commands for this session`,
        detail: `saves ${rule.action} ${rule.resource}`,
        action: { kind: "answer", answer: { kind: "rule", text: `${rule.action} ${rule.resource} allow` } },
      },
      { label: "Deny with reason", action: { kind: "reject" } },
      { label: "Deny", action: { kind: "answer", answer: { kind: "deny" } } },
    ];
  }
  // The exact-file target. For a degraded suggestion `path` already is the file;
  // otherwise it is the directory, so the claim's own absolute path is the file.
  const file = suggestion.exact ? suggestion.path : request.absolute;
  const fileGlob = toResourceSlash(file);
  const choices: ScopeChoice[] = [
    { label: `Allow ${request.display} for once`, action: { kind: "answer", answer: { kind: "once" } } },
    {
      label: `Always allow ${request.display} for this workspace`,
      detail: `saves ${fileGlob} in ${WORKSPACE_CONFIG}`,
      action: {
        kind: "answer",
        answer: {
          kind: "allow",
          grant: { path: file, access: suggestion.access, glob: fileGlob, exact: true },
          persist: "workspace",
        },
      },
    },
  ];
  // A directory that would re-expose `$HOME`, a system tree, or the workspace is
  // never offered: the only standing grant is the file itself.
  if (!suggestion.exact) {
    choices.push(
      {
        label: `Allow all ${suggestion.glob} for once`,
        detail: "session only, not saved",
        action: { kind: "answer", answer: { kind: "allow", grant: suggestion } },
      },
      {
        label: `Always allow ${suggestion.glob} for this workspace`,
        detail: `saves ${suggestion.glob} in ${WORKSPACE_CONFIG}`,
        action: { kind: "answer", answer: { kind: "allow", grant: suggestion, persist: "workspace" } },
      },
    );
  }
  choices.push(
    { label: "Deny with reason", action: { kind: "reject" } },
    { label: "Deny", action: { kind: "answer", answer: { kind: "deny" } } },
  );
  return choices;
}

export interface ScopeAskPopupOptions extends ScopeAskRequest {
  theme?: PopupTheme;
  terminalRows?: () => number;
  onDone: (answer: ScopeAnswer) => void;
}

/** Where the popup is: choosing, typing a rule, or typing a denial note. */
type Stage = "permission" | "rule" | "reject";

/** Rows for one render, plus the body-line → choice mapping a click needs. */
interface Layout {
  /** First body line of each choice, for `reveal`. */
  firstRow: number[];
  /** Which choice a body line belongs to (labels and their detail line). */
  choiceForRow: number[];
}

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
  private layout: Layout = { firstRow: [], choiceForRow: [] };

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

  private choices(): ScopeChoice[] {
    return scopeChoices(this.options);
  }

  private hint(): string {
    if (this.stage === "rule") return "Enter save rule · Esc back";
    if (this.stage === "reject") return "Enter deny with note · empty = plain deny · Esc back";
    return `↑↓ select · Enter choose · 1-${this.choices().length} · e rule · Esc deny`;
  }

  /** The option rows, recording which body line answers which choice. */
  private rows(): PopupRow[] {
    const theme = this.theme;
    const rows: PopupRow[] = [];
    const firstRow: number[] = [];
    const choiceForRow: number[] = [];
    this.choices().forEach((choice, index) => {
      firstRow[index] = rows.length;
      const marker = this.selected === index ? theme.bold("›") : " ";
      rows.push(`${marker} ${index + 1}  ${choice.label}`);
      choiceForRow.push(index);
      if (choice.detail) {
        rows.push(theme.fg("dim", `      ${choice.detail}`));
        choiceForRow.push(index);
      }
    });
    this.layout = { firstRow, choiceForRow };
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
          ...this.rows(),
          "",
          ...wrapTextWithAnsi(theme.fg("dim", "Format: <tool|*> <glob> <allow|ask|deny>"), Math.max(8, width - 2)),
          ...this.ruleInput.render(width),
        ],
        footer: request.queued ? [theme.fg("warning", `${request.queued} more waiting`)] : undefined,
      };
    }
    return {
      header,
      body: this.rows(),
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
    const count = this.choices().length;
    if (matchesKey(data, "up") || data === "k") {
      this.selected = (this.selected + count - 1) % count;
      return true;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.selected = (this.selected + 1) % count;
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
    for (let index = 0; index < count; index++) {
      if (data === String(index + 1)) {
        this.choose(index);
        return true;
      }
    }
    return false;
  }

  private handleBodyClick(index: number): boolean {
    const choice = this.layout.choiceForRow[index];
    if (choice === undefined) return false;
    this.choose(choice);
    return true;
  }

  private revealRow(): number | undefined {
    return this.layout.firstRow[this.selected];
  }

  private choose(index: number): void {
    const action = this.choices()[index]?.action;
    if (!action) return;
    if (action.kind === "answer") return this.finish(action.answer);
    this.startReject();
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
