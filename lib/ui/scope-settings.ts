/**
 * `/scope` settings: what the scope currently is, and the keys that change it.
 *
 * The point is not to replace `/scope allow …`; it is to stop a config change
 * requiring the user to remember whether it was `--ro` or `--rw`, `--project` or
 * `--global`, and where the result was written. Every row states the value it
 * holds and the file it lives in, every action says where it will be saved, and
 * the effect is applied through the same code the slash command uses.
 *
 * Two levels, never more: a row opens its own short menu, so a mis-keypress
 * cannot widen a grant without the user seeing the verb first.
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
import {
  DEFAULT_LABELS,
  SETTINGS_SECTIONS,
  accessLabel,
  canKeepGrant,
  canKeepRule,
  sectionOf,
  type GrantRow,
  type RuleRow,
  type SettingsAction,
  type SettingsRow,
  type SettingsTarget,
} from "../scope/settings.ts";
import type { ScopeAccess, ScopeEffect } from "../scope/types.ts";
import { PopupShell, type PopupShellModel } from "./shell.ts";

export interface ScopeSettingsView {
  cwd: string;
  /** Config files that contributed, in precedence order. */
  sources: readonly string[];
  rows: readonly SettingsRow[];
}

export interface ScopeSettingsPopupOptions {
  /** Re-read on every render: the extension owns the state, not the popup. */
  view: () => ScopeSettingsView;
  /** Apply one change; return the confirmation line, or throw to report a failure. */
  apply: (action: SettingsAction) => string;
  theme?: PopupTheme;
  terminalRows?: () => number;
  onDone: () => void;
}

type Purpose = "grant" | "rule";

type Stage =
  | { kind: "list" }
  | { kind: "actions"; row: SettingsRow }
  | { kind: "add" }
  | { kind: "input"; purpose: Purpose }
  | { kind: "target"; purpose: Purpose; text: string };

interface Entry {
  label: string;
  detail?: string;
  run: () => void;
}

interface Layout {
  /** First body line of each selectable row/menu entry. */
  firstRow: number[];
  /** Which selectable index a body line belongs to. */
  entryForRow: number[];
}

const WORKSPACE_CONFIG = ".pi/scope.json";
const GLOBAL_CONFIG = "~/.pi/agent/scope.json";

const EFFECTS: readonly ScopeEffect[] = ["allow", "ask", "deny"];

export class ScopeSettingsPopup implements Component, Focusable {
  private readonly options: ScopeSettingsPopupOptions;
  private readonly theme: PopupTheme;
  private readonly shell: PopupShell;
  private readonly inputs: Record<Purpose, Input>;
  private stage: Stage = { kind: "list" };
  private selected = 0;
  private notice?: string;
  private closed = false;
  private isFocused = false;
  private layout: Layout = { firstRow: [], entryForRow: [] };

  constructor(options: ScopeSettingsPopupOptions) {
    this.options = options;
    this.theme = options.theme ?? PLAIN_THEME;
    const make = (prompt: string, placeholder: string) => {
      const input = new Input({ prompt, placeholder });
      input.onSubmit = (value) => this.submitInput(value);
      input.onEscape = () => this.back();
      return input;
    };
    this.inputs = {
      grant: make("Path: ", "/srv/data, ~/projects/lib or ../reference"),
      rule: make("Rule: ", "<tool|*> <glob> <allow|ask|deny>"),
    };
    this.shell = new PopupShell({
      theme: this.theme,
      title: "Scope settings",
      hint: () => this.hint(),
      terminalRows: options.terminalRows,
      model: (width) => this.model(width),
      onKey: (data) => this.handleKey(data),
      onBodyClick: (index) => this.handleBodyClick(index),
      reveal: () => this.layout.firstRow[this.current()],
      onClose: () => this.finish(),
      pad: true,
    });
  }

  get focused(): boolean {
    return this.stage.kind === "input" ? this.inputs[this.stage.purpose].focused : this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.inputs.grant.focused = value && this.stage.kind === "input" && this.stage.purpose === "grant";
    this.inputs.rule.focused = value && this.stage.kind === "input" && this.stage.purpose === "rule";
  }

  cancel(): void {
    this.finish();
  }

  handleInput(data: string): void {
    this.shell.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.shell.handleMouse(event);
  }

  invalidate(): void {
    this.inputs.grant.invalidate();
    this.inputs.rule.invalidate();
    this.shell.invalidate();
  }

  dispose(): void {
    this.closed = true;
    this.inputs.grant.focused = false;
    this.inputs.rule.focused = false;
  }

  render(width: number): string[] {
    return this.shell.render(width);
  }

  // ---- view ----------------------------------------------------------------

  private rows(): SettingsRow[] {
    const all = this.options.view().rows;
    // Group by section so the popup's order is its own, not the model's.
    return SETTINGS_SECTIONS.flatMap(section => all.filter(row => sectionOf(row) === section));
  }

  private current(): number {
    const count = this.stage.kind === "list" ? this.rows().length : this.entries().length;
    return Math.min(this.selected, Math.max(0, count - 1));
  }

  private hint(): string {
    if (this.stage.kind === "input") return "Enter continue · Esc back";
    if (this.stage.kind === "list") return "↑↓ move · Enter change · a add · Esc close";
    return "↑↓ move · Enter apply · Esc back";
  }

  private labelOf(row: SettingsRow): string {
    if (row.kind === "grant") return row.label;
    if (row.kind === "rule") return row.label;
    if (row.kind === "default") return `${row.label}  ${row.effect}`;
    if (row.kind === "sandbox") return `sandbox  ${row.label}`;
    return `yolo  ${row.label}`;
  }

  private badgeOf(row: SettingsRow): string | undefined {
    if (row.kind === "grant") return row.badge;
    if (row.kind === "rule") return row.badge;
    return undefined;
  }

  private contextLine(): PopupRow {
    const stage = this.stage;
    if (stage.kind === "actions") return this.theme.bold(`Change: ${this.labelOf(stage.row)}`);
    if (stage.kind === "target") return this.theme.bold(`Where should ${stage.text} be saved?`);
    return this.theme.bold("What do you want to add?");
  }

  // ---- rendering -----------------------------------------------------------

  private model(width: number): PopupShellModel {
    const theme = this.theme;
    const view = this.options.view();
    const header: PopupRow[] = [
      `${theme.fg("dim", "workspace")}  ${view.cwd}`,
      `${theme.fg("dim", "config   ")}  ${view.sources.length ? view.sources.join(", ") : "(none yet)"}`,
    ];
    if (this.notice) header.push("", theme.fg("warning", this.notice));
    header.push("");

    if (this.stage.kind === "input") {
      const input = this.inputs[this.stage.purpose];
      return {
        header,
        body: [
          this.contextLine(),
          ...input.render(width),
          "",
          ...wrapTextWithAnsi(
            theme.fg(
              "dim",
              this.stage.purpose === "grant"
                ? "A path, absolute or relative to the workspace. `~` expands."
                : "Format: <tool|*> <glob> <allow|ask|deny> — e.g. read /secrets/* deny",
            ),
            Math.max(8, width - 2),
          ),
        ],
      };
    }
    if (this.stage.kind === "list") return { header, body: this.listBody() };
    return { header, body: [this.contextLine(), "", ...this.menuBody(this.entries())] };
  }

  private listBody(): PopupRow[] {
    const theme = this.theme;
    const rows: PopupRow[] = [];
    const firstRow: number[] = [];
    const entryForRow: number[] = [];
    const all = this.rows();
    let selectable = 0;
    let first = true;
    for (const section of SETTINGS_SECTIONS) {
      const inSection = all.filter(row => sectionOf(row) === section);
      if (!first) rows.push("");
      first = false;
      rows.push(theme.bold(theme.fg("accent", section.toUpperCase())));
      if (!inSection.length) {
        rows.push(theme.fg("dim", section === "Rules" ? "  none — press a to add" : "  none"));
        continue;
      }
      for (const row of inSection) {
        firstRow[selectable] = rows.length;
        const marker = this.current() === selectable ? theme.bold("›") : " ";
        const badge = this.badgeOf(row);
        rows.push(badge ? `${marker} ${this.labelOf(row)}  ${theme.fg("dim", badge)}` : `${marker} ${this.labelOf(row)}`);
        entryForRow.push(selectable);
        selectable++;
      }
    }
    this.layout = { firstRow, entryForRow };
    return rows;
  }

  private menuBody(entries: readonly Entry[]): PopupRow[] {
    const theme = this.theme;
    const rows: PopupRow[] = [];
    const firstRow: number[] = [];
    const entryForRow: number[] = [];
    entries.forEach((entry, index) => {
      firstRow[index] = rows.length;
      const marker = this.current() === index ? theme.bold("›") : " ";
      const detail = entry.detail ? `  ${theme.fg("dim", entry.detail)}` : "";
      rows.push(`${marker} ${entry.label}${detail}`);
      entryForRow.push(index);
    });
    this.layout = { firstRow, entryForRow };
    return rows;
  }

  // ---- menus ---------------------------------------------------------------

  private entries(): Entry[] {
    const stage = this.stage;
    switch (stage.kind) {
      case "list":
      case "input":
        return [];
      case "add":
        return [
          { label: "Add a grant…", detail: "a folder or file the tools may reach", run: () => this.startInput("grant") },
          { label: "Add a rule…", detail: "<tool|*> <glob> <allow|ask|deny>", run: () => this.startInput("rule") },
        ];
      case "target":
        return stage.purpose === "grant" ? this.grantTargets(stage.text) : this.ruleTargets(stage.text);
      case "actions":
        return this.rowActions(stage.row);
    }
  }

  private rowActions(row: SettingsRow): Entry[] {
    if (row.kind === "grant") return this.grantActions(row);
    if (row.kind === "rule") return this.ruleActions(row);
    if (row.kind === "default") {
      return EFFECTS.map(effect => ({
        label: `Set ${row.key === "external" ? DEFAULT_LABELS.external : DEFAULT_LABELS.readExternal} to ${effect}`,
        detail: row.effect === effect ? "current · saved to .pi/scope.json" : `saves it in ${WORKSPACE_CONFIG}`,
        run: () => this.applyAction({ kind: "default", key: row.key, effect }),
      }));
    }
    if (row.kind === "sandbox") {
      return [
        { label: "Off", detail: row.label === "off" ? "current" : "bash writes rely on parsing again", run: () => this.applyAction({ kind: "sandbox-mode", mode: "off" }) },
        { label: "Workspace", detail: "workspace + rw roots writable, rest read-only", run: () => this.applyAction({ kind: "sandbox-mode", mode: "workspace" }) },
        { label: "Read-only", detail: "nothing writable except scratch and devices", run: () => this.applyAction({ kind: "sandbox-mode", mode: "readonly" }) },
      ];
    }
    return [
      { label: "Off", detail: row.strength === undefined ? "current" : "outside paths ask again", run: () => this.applyAction({ kind: "yolo", strength: undefined }) },
      { label: "Reads only (ro)", detail: "reads outside the workspace stop asking", run: () => this.applyAction({ kind: "yolo", strength: "ro" }) },
      { label: "Reads and writes (rw)", detail: "writes too — deny rules still win", run: () => this.applyAction({ kind: "yolo", strength: "rw" }) },
    ];
  }

  private grantActions(row: GrantRow): Entry[] {
    const other: ScopeAccess = row.root.access === "ro" ? "rw" : "ro";
    const entries: Entry[] = [{
      label: `Make it ${accessLabel(other)}`,
      detail: row.inConfig ? `rewrites ${row.badge.split(" · ")[1] ?? "the config"}` : "for this session",
      run: () => this.applyAction({ kind: "grant-access", root: row.root, access: other }),
    }];
    if (!row.builtin && canKeepGrant(row.root)) {
      entries.push({
        label: "Keep for this workspace",
        detail: `saves it in ${WORKSPACE_CONFIG}`,
        run: () => this.applyAction({ kind: "grant-keep", root: row.root }),
      });
    }
    if (!row.builtin) {
      entries.push({
        label: "Remove this grant",
        detail: row.inConfig ? "deletes the entry from the config file" : "for this session",
        run: () => this.applyAction({ kind: "grant-remove", root: row.root }),
      });
    }
    return entries;
  }

  private ruleActions(row: RuleRow): Entry[] {
    const entries: Entry[] = EFFECTS
      .filter(effect => effect !== row.rule.effect)
      .map(effect => ({
        label: `Make it ${effect}`,
        detail: row.inConfig ? "rewrites the config file" : "for this session",
        run: () => this.applyAction({ kind: "rule-effect", rule: row.rule, effect }),
      }));
    if (canKeepRule(row.rule)) {
      entries.push({
        label: "Keep for this workspace",
        detail: `saves it in ${WORKSPACE_CONFIG}`,
        run: () => this.applyAction({ kind: "rule-keep", rule: row.rule }),
      });
    }
    entries.push({
      label: "Remove this rule",
      detail: row.inConfig ? "deletes it from the config file" : "for this session",
      run: () => this.applyAction({ kind: "rule-remove", rule: row.rule }),
    });
    return entries;
  }

  private grantTargets(text: string): Entry[] {
    const targets: Array<[SettingsTarget, string, string]> = [
      ["session", "this session", "until this session ends"],
      ["project", "this workspace", `saves it in ${WORKSPACE_CONFIG}`],
      ["global", "every workspace", `saves it in ${GLOBAL_CONFIG}`],
    ];
    const entries: Entry[] = [];
    for (const [target, where, detail] of targets) {
      for (const access of ["ro", "rw"] as const) {
        const label = accessLabel(access);
        entries.push({
          label: `${label.charAt(0).toUpperCase()}${label.slice(1)} · ${where}`,
          detail,
          run: () => this.applyAction({ kind: "add-grant", path: text, access, target }),
        });
      }
    }
    return entries;
  }

  private ruleTargets(text: string): Entry[] {
    const targets: Array<[SettingsTarget, string, string]> = [
      ["session", "This session", "until this session ends"],
      ["project", "This workspace", `saves it in ${WORKSPACE_CONFIG}`],
      ["global", "Every workspace", `saves it in ${GLOBAL_CONFIG}`],
    ];
    return targets.map(([target, label, detail]) => ({
      label,
      detail,
      run: () => this.applyAction({ kind: "add-rule", text, target }),
    }));
  }

  // ---- input ---------------------------------------------------------------

  private startInput(purpose: Purpose): void {
    this.stage = { kind: "input", purpose };
    const input = this.inputs[purpose];
    input.setValue("");
    input.focused = this.isFocused;
    this.selected = 0;
  }

  private submitInput(value: string): void {
    const stage = this.stage;
    if (stage.kind !== "input") return;
    const text = value.trim();
    // An empty path or rule is not a change; stay in the field rather than
    // offering to save nothing.
    if (!text) return;
    this.stage = { kind: "target", purpose: stage.purpose, text };
    this.inputs[stage.purpose].focused = false;
    this.selected = 0;
  }

  private back(): void {
    const stage = this.stage;
    if (stage.kind === "target") {
      // Return to the editor with the text intact, so a wrong chooser is one
      // Escape away instead of a retype.
      this.stage = { kind: "input", purpose: stage.purpose };
      const input = this.inputs[stage.purpose];
      input.setValue(stage.text);
      input.focused = this.isFocused;
      return;
    }
    this.toList();
  }

  private toList(): void {
    this.stage = { kind: "list" };
    this.inputs.grant.focused = false;
    this.inputs.rule.focused = false;
    this.selected = this.current();
  }

  // ---- keys ----------------------------------------------------------------

  private handleKey(data: string): boolean | void {
    const stage = this.stage;
    if (stage.kind === "input") {
      if (isPopupCloseKey(data)) {
        this.back();
        return true;
      }
      this.inputs[stage.purpose].handleInput(data);
      return true;
    }
    if (isPopupCloseKey(data)) {
      // In the list the shell closes the popup; inside a menu Escape is "back".
      if (stage.kind === "list") return false;
      this.back();
      return true;
    }
    const count = stage.kind === "list" ? this.rows().length : this.entries().length;
    if (!count) return false;
    if (matchesKey(data, "up") || data === "k") {
      this.selected = (this.current() + count - 1) % count;
      return true;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.selected = (this.current() + 1) % count;
      return true;
    }
    if (stage.kind === "list" && data === "a") {
      this.stage = { kind: "add" };
      this.selected = 0;
      return true;
    }
    if (matchesKey(data, "enter")) {
      this.choose(this.current());
      return true;
    }
    if (/^[1-9]$/.test(data)) {
      const index = Number(data) - 1;
      if (index < count) {
        this.selected = index;
        this.choose(index);
      }
      return true;
    }
    return false;
  }

  private handleBodyClick(index: number): boolean {
    const target = this.layout.entryForRow[index];
    if (target === undefined) return false;
    this.choose(target);
    return true;
  }

  private choose(index: number): void {
    const stage = this.stage;
    if (stage.kind === "list") {
      const row = this.rows()[index];
      if (!row) return;
      this.stage = { kind: "actions", row };
      // The built-in workspace row has one action: say it is fixed. Opening a
      // menu is still better than a silent no-op.
      this.selected = 0;
      return;
    }
    this.entries()[index]?.run();
  }

  private applyAction(action: SettingsAction): void {
    try {
      this.notice = this.options.apply(action);
    } catch (error) {
      this.notice = `Scope: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.toList();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.inputs.grant.focused = false;
    this.inputs.rule.focused = false;
    this.options.onDone();
  }
}
