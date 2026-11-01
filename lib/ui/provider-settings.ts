/**
 * `/provider` as an editor you can walk, instead of a chain of dialogs.
 *
 * The popup owns the draft, which is what makes Back useful: going up a step
 * keeps every answer, because the answers are not in the step that is being
 * left. Closing the popup ends the draft with it — a new `/provider` starts
 * blank — so a half-finished provider never becomes a file.
 *
 * It never writes for the same reason the router editor never writes: every
 * action goes back to the extension, which owns the snapshot, the endpoint
 * trust check, the write and the reload. Model discovery is a separate overlay
 * and cannot live here either, so "add models" ends the popup and the
 * extension reopens it once the picker is done.
 */
import {
  CURSOR_MARKER,
  Input,
  matchesKey,
  renderFakeCursor,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { PLAIN_THEME, isPopupCloseKey, type PopupRow, type PopupTheme } from "../popup/frame.ts";
import type { ProviderConfig } from "../provider/provider-config.ts";
import {
  accountPlan,
  apiLabel,
  describeAuth,
  draftSteps,
  modelRows,
  providerRows,
  providerToDraft,
  stepProblem,
  type DraftStep,
  type ModelRow,
  type ProviderDraft,
  type ProviderRow,
} from "../provider/provider-settings.ts";
import { PopupShell, type PopupShellModel } from "./shell.ts";

export interface ProviderSettingsView {
  /** The models.json this editor writes. */
  path: string;
  providers: Record<string, ProviderConfig>;
  /** Problems with the file as it is now; the editor shows them, it cannot fix them. */
  errors: readonly string[];
  /** Ids Pi already provides, so overriding one is a visible choice. */
  known: readonly string[];
}

/** Everything the popup can ask the extension to do. */
export type ProviderAction =
  | { kind: "save"; draft: ProviderDraft }
  | { kind: "delete"; id: string }
  | { kind: "add-models"; id: string }
  | { kind: "remove-model"; id: string; modelId: string };

export type ProviderPopupResult = ProviderAction | { kind: "close" };

export interface ProviderSettingsPopupOptions {
  /** Re-read on every render: the extension owns config and disk, not the popup. */
  view: () => ProviderSettingsView;
  theme?: PopupTheme;
  terminalRows?: () => number;
  /** One line the extension wants shown once, e.g. what the last action did. */
  notice?: string;
  /** Open straight on this provider, so a save lands where the next step is. */
  startAt?: string;
  onDone: (result: ProviderPopupResult) => void;
}

type Stage =
  /** Page 1: pick what to do, before any list is shown. */
  | { kind: "home" }
  | { kind: "list" }
  | { kind: "provider"; row: ProviderRow }
  | { kind: "models"; row: ProviderRow }
  | { kind: "confirm-delete"; row: ProviderRow }
  | { kind: "confirm-model"; row: ProviderRow; modelId: string }
  | { kind: "wizard"; step: number; locked: boolean };

interface Entry {
  label: string;
  detail?: string;
  run: () => void;
}

interface Layout {
  /** First body line of each selectable entry. */
  firstRow: number[];
  /** Which selectable index a body line belongs to. */
  entryForRow: number[];
}

export class ProviderSettingsPopup implements Component, Focusable {
  private readonly options: ProviderSettingsPopupOptions;
  private readonly theme: PopupTheme;
  private readonly shell: PopupShell;
  /** One input per text step, so a step's editing state survives leaving it. */
  private readonly inputs = new Map<string, Input>();
  private stage: Stage = { kind: "home" };
  private selected = 0;
  private notice?: string;
  /** A step's validation failure; painted separately so it cannot look like a hint. */
  private problem?: string;
  /** Kept while the popup is open; a closed popup discards it with itself. */
  private pending?: { draft: ProviderDraft; locked: boolean };
  private closed = false;
  private isFocused = false;
  private layout: Layout = { firstRow: [], entryForRow: [] };
  private lastWidth = 80;

  constructor(options: ProviderSettingsPopupOptions) {
    this.options = options;
    this.theme = options.theme ?? PLAIN_THEME;
    this.notice = options.notice;
    this.shell = new PopupShell({
      theme: this.theme,
      title: "Providers",
      hint: () => this.hint(),
      terminalRows: options.terminalRows,
      model: (width) => this.model(width),
      onKey: (data) => this.handleKey(data),
      onBodyClick: (index) => this.handleBodyClick(index),
      reveal: () => this.layout.firstRow[this.current()],
      onClose: () => this.finish({ kind: "close" }),
      pad: true,
    });
    if (options.startAt) {
      const row = providerRows(options.view().providers).find((entry) => entry.id === options.startAt);
      if (row) this.stage = { kind: "provider", row };
    }
  }

  get focused(): boolean {
    return this.stage.kind === "wizard" ? this.fieldInput()?.focused ?? this.isFocused : this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    const input = this.fieldInput();
    if (input) input.focused = value;
  }

  cancel(): void {
    this.finish({ kind: "close" });
  }

  handleInput(data: string): void {
    this.shell.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.shell.handleMouse(event);
  }

  invalidate(): void {
    for (const input of this.inputs.values()) input.invalidate();
    this.shell.invalidate();
  }

  dispose(): void {
    this.closed = true;
    for (const input of this.inputs.values()) input.focused = false;
  }

  render(width: number): string[] {
    return this.shell.render(width);
  }

  // ---- view ----------------------------------------------------------------

  private rows(): ProviderRow[] {
    return providerRows(this.options.view().providers);
  }

  private steps(): DraftStep[] {
    return this.stage.kind === "wizard" ? draftSteps(this.currentDraft(), this.stage.locked) : [];
  }

  /** The draft of the open wizard, or the pending one when there is no wizard yet. */
  private currentDraft(): ProviderDraft {
    return this.pending?.draft ?? blankDraft();
  }

  private count(): number {
    switch (this.stage.kind) {
      case "list": return this.rows().length + 1;
      case "wizard": return this.steps()[this.stage.step]?.choices?.length ?? 1;
      default: return this.entries().length;
    }
  }

  private current(): number {
    return Math.min(this.selected, Math.max(0, this.count() - 1));
  }

  private hint(): string {
    switch (this.stage.kind) {
      case "wizard": return "Enter continue · Esc back";
      case "home": return "↑↓ move · Enter open · a add · Esc close";
      case "list": return "↑↓ move · Enter open · a add · Esc back";
      default: return "↑↓ move · Enter apply · Esc back";
    }
  }

  private header(): PopupRow[] {
    const theme = this.theme;
    const view = this.options.view();
    const rows = providerRows(view.providers);
    const models = rows.reduce((total, row) => total + row.models, 0);
    const header: PopupRow[] = [
      `${theme.fg("dim", "file     ")}  ${view.path}`,
      `${theme.fg("dim", "providers")}  ${rows.length} · ${models} configured model${models === 1 ? "" : "s"}`,
    ];
    if (view.errors.length) header.push("", theme.fg("error", view.errors[0]!));
    // A rejected value is an error, not a hint: the two are separate lines so a
    // red line always means "this will not be saved".
    if (this.problem) header.push("", theme.fg("error", this.problem));
    if (this.notice) header.push("", theme.fg("warning", this.notice));
    header.push("");
    return header;
  }

  private model(width: number): PopupShellModel {
    this.lastWidth = width;
    const header = this.header();
    const stage = this.stage;
    switch (stage.kind) {
      case "home":
        return { header, body: this.homeBody() };
      case "list":
        return { header, body: this.listBody() };
      case "provider":
        return { header, body: this.providerBody(stage.row) };
      case "models":
        return { header, body: this.modelsBody(stage.row) };
      case "confirm-delete":
        return { header, body: this.confirmBody(`Delete ${stage.row.id} from models.json?`, this.entries(), "Only this file entry is removed. Built-in and extension providers, and credentials stored through /login, are untouched.") };
      case "confirm-model":
        return { header, body: this.confirmBody(`Remove ${stage.modelId} from ${stage.row.id}?`, this.entries(), "The model entry and its modelOverrides entry are removed together, so it does not come back on reload.") };
      default: {
        const step = this.steps()[stage.step];
        if (!step) return { header, body: ["…"] };
        return { header, body: step.choices ? this.choiceBody(step) : this.fieldBody(step, width) };
      }
    }
  }

  /** Page 1: the two things you can do, nothing else. */
  private homeBody(): PopupRow[] {
    const theme = this.theme;
    return [theme.bold("What would you like to do?"), "", ...this.menuBody(this.entries())];
  }

  private listBody(): PopupRow[] {
    const theme = this.theme;
    const rows = this.rows();
    const body: PopupRow[] = [];
    const firstRow: number[] = [];
    const entryForRow: number[] = [];
    let selectable = 0;

    body.push(theme.bold(theme.fg("accent", "PROVIDERS")));
    if (!rows.length) body.push(theme.fg("dim", "  none yet — press a to add one"));
    for (const row of rows) {
      firstRow[selectable] = body.length;
      const marker = this.current() === selectable ? theme.bold("›") : " ";
      const family = row.accounts > 1 ? `  ${theme.fg("dim", `account ${row.account}/${row.accounts}`)}` : "";
      body.push(`${marker} ${theme.fg("accent", row.id)}  ${row.name}${family}`);
      const api = row.api ? apiLabel(row.api) : "inherited api";
      const count = `${row.models} model${row.models === 1 ? "" : "s"}`;
      body.push(`    ${theme.fg("dim", `${api} · ${count}${row.baseUrl ? ` · ${row.baseUrl}` : ""}`)}`);
      entryForRow.push(selectable, selectable);
      selectable++;
    }
    firstRow[selectable] = body.length;
    body.push(`${this.current() === selectable ? theme.bold("›") : " "} + add a provider…`);
    entryForRow.push(selectable);

    this.layout = { firstRow, entryForRow };
    return body;
  }

  private providerBody(row: ProviderRow): PopupRow[] {
    const theme = this.theme;
    const provider = this.options.view().providers[row.id] ?? {};
    const known = this.options.view().known.includes(row.id);
    const body: PopupRow[] = [
      theme.bold(`${row.id}  ${theme.fg("dim", row.name)}`),
      `${theme.fg("dim", "endpoint")}  ${row.baseUrl || "(inherited)"}`,
      `${theme.fg("dim", "api     ")}  ${row.api ? apiLabel(row.api) : "(inherited)"}`,
      `${theme.fg("dim", "auth    ")}  ${describeAuth(provider)}`,
    ];
    if (known) {
      body.push("", ...wrapTextWithAnsi(
        theme.fg("warning", "Pi also provides this id. Saving here adds an override to models.json; the built-in provider stays."),
        Math.max(8, this.lastWidth - 2),
      ));
    }
    if (row.accounts > 1) {
      body.push(`${theme.fg("dim", "family  ")}  ${row.family} · ${row.accounts} accounts share this connection`);
    }
    body.push("", ...this.menuBody(this.entries()));
    return body;
  }

  private modelsBody(row: ProviderRow): PopupRow[] {
    const theme = this.theme;
    const models = modelRows(this.options.view().providers[row.id] ?? {});
    const body: PopupRow[] = [
      theme.bold(`${row.id} · ${models.length} model${models.length === 1 ? "" : "s"}`),
      "",
    ];
    if (!models.length) body.push(theme.fg("dim", "  none configured — enter add models to fetch or type one"));
    body.push(...this.menuBody(this.entries()));
    return body;
  }

  private choiceBody(step: DraftStep): PopupRow[] {
    return [
      this.theme.bold(step.title),
      "",
      ...this.menuBody(this.entries()),
      "",
      ...wrapTextWithAnsi(this.theme.fg("dim", step.help), Math.max(8, this.lastWidth - 2)),
    ];
  }

  private fieldBody(step: DraftStep, width: number): PopupRow[] {
    // A field has no selectable rows; a stale map would scroll to a line that
    // belongs to the menu this step replaced.
    this.layout = { firstRow: [], entryForRow: [] };
    const input = this.inputFor(step);
    const body: PopupRow[] = [this.theme.bold(step.title), ""];
    if (step.masked) {
      const value = input.getValue();
      const masks = "*".repeat(Math.min(value.length, Math.max(0, width - 2)));
      body.push(masks + (this.focused ? CURSOR_MARKER + renderFakeCursor(" ") : " "));
      body.push(this.theme.fg("dim", "Hidden input, so the key is never echoed on screen."));
    } else {
      body.push(...input.render(width));
    }
    body.push("", ...wrapTextWithAnsi(this.theme.fg("dim", step.help), Math.max(8, width - 2)));
    body.push("", this.theme.fg("dim", this.stepProgress()));
    return body;
  }

  private stepProgress(): string {
    if (this.stage.kind !== "wizard") return "";
    const steps = this.steps();
    const step = steps[this.stage.step]!;
    const position = `Step ${this.stage.step + 1} of ${steps.length}`;
    return this.stage.step === steps.length - 1
      ? `${position} · Enter saves · Esc goes back (nothing is lost)`
      : `${position} · ${step.choices ? "Enter choose" : "Enter continue"} · Esc goes back (nothing is lost)`;
  }

  private confirmBody(title: string, entries: readonly Entry[], note: string): PopupRow[] {
    const theme = this.theme;
    return [
      theme.bold(title),
      "",
      ...this.menuBody(entries),
      "",
      ...wrapTextWithAnsi(theme.fg("dim", note), Math.max(8, this.lastWidth - 2)),
    ];
  }

  private menuBody(entries: readonly Entry[]): PopupRow[] {
    const theme = this.theme;
    const body: PopupRow[] = [];
    const firstRow: number[] = [];
    const entryForRow: number[] = [];
    entries.forEach((entry, index) => {
      firstRow[index] = body.length;
      const marker = this.current() === index ? theme.bold("›") : " ";
      const detail = entry.detail ? `  ${theme.fg("dim", entry.detail)}` : "";
      body.push(`${marker} ${entry.label}${detail}`);
      entryForRow.push(index);
    });
    this.layout = { firstRow, entryForRow };
    return body;
  }

  // ---- menus ---------------------------------------------------------------

  private entries(): Entry[] {
    const stage = this.stage;
    switch (stage.kind) {
      case "home": return this.homeEntries();
      case "provider": return this.providerEntries(stage.row);
      case "models": return this.modelEntries(stage.row);
      case "confirm-delete": return [
        { label: `Delete ${stage.row.id}`, detail: "from models.json", run: () => this.finish({ kind: "delete", id: stage.row.id }) },
        { label: "Keep it", detail: "nothing changes", run: () => this.go({ kind: "provider", row: stage.row }) },
      ];
      case "confirm-model": return [
        { label: `Remove ${stage.modelId}`, detail: `from ${stage.row.id}`, run: () => this.finish({ kind: "remove-model", id: stage.row.id, modelId: stage.modelId }) },
        { label: "Keep it", detail: "nothing changes", run: () => this.go({ kind: "models", row: stage.row }) },
      ];
      case "wizard": {
        const step = this.steps()[stage.step];
        return (step?.choices ?? []).map((choice) => ({
          label: apiLabel(choice),
          detail: choice === step!.value ? "current" : choice,
          run: () => this.chooseValue(step!, choice),
        }));
      }
      default:
        return [];
    }
  }

  private homeEntries(): Entry[] {
    const rows = this.rows();
    return [
      {
        label: "List available providers",
        detail: rows.length ? `${rows.length} configured — open one to edit, clone or delete` : "none configured yet",
        run: () => this.go({ kind: "list" }),
      },
      {
        label: "Add a new provider…",
        detail: "starts the connection wizard",
        run: () => this.startAdd(),
      },
    ];
  }

  private providerEntries(row: ProviderRow): Entry[] {
    const provider = this.options.view().providers[row.id] ?? {};
    const models = modelRows(provider).length;
    const plan = accountPlan(this.options.view().providers, row.family);
    const entries: Entry[] = [
      { label: "Edit connection…", detail: "name, protocol, URL, key", run: () => this.startEdit(row) },
      { label: "Add models…", detail: "fetch the model list, or type an id", run: () => this.finish({ kind: "add-models", id: row.id }) },
      { label: `Models (${models})…`, detail: models ? "review or remove one" : "none yet", run: () => this.go({ kind: "models", row }) },
      {
        label: "Clone with a new key…",
        // A lone provider is renamed to its first slot before the clone lands,
        // so say that here rather than surprising the user afterwards.
        detail: !plan
          ? `next slot in ${row.family}`
          : plan.migration
            ? `renames this to ${plan.migration.to} and creates ${plan.draft.id}`
            : `creates ${plan.draft.id}, keeps this one's models`,
        run: () => this.startAccount(row),
      },
      { label: "Delete this provider", detail: "removes only its models.json entry", run: () => this.go({ kind: "confirm-delete", row }) },
      { label: "← back", run: () => this.toList() },
    ];
    return entries;
  }

  private modelEntries(row: ProviderRow): Entry[] {
    const provider = this.options.view().providers[row.id] ?? {};
    const models = modelRows(provider);
    const entries: Entry[] = models.map((model) => ({
      label: model.id,
      detail: describeModel(model),
      run: () => this.go({ kind: "confirm-model", row, modelId: model.id }),
    }));
    entries.push({ label: "Add models…", detail: "fetch the model list, or type an id", run: () => this.finish({ kind: "add-models", id: row.id }) });
    entries.push({ label: "← back", run: () => this.go({ kind: "provider", row }) });
    return entries;
  }

  // ---- wizard --------------------------------------------------------------

  private startAdd(): void {
    const draft = this.pending?.draft ?? blankDraft();
    this.openWizard(draft, this.pending?.locked ?? false, 0);
  }

  private startEdit(row: ProviderRow): void {
    const provider = this.options.view().providers[row.id];
    if (!provider) {
      this.notice = `${row.id} is no longer in models.json; reload to see the current file.`;
      return;
    }
    // Start at the display name: the id is the entry key and cannot change.
    this.openWizard(providerToDraft(row.id, provider), true, 1);
  }

  private startAccount(row: ProviderRow): void {
    const plan = accountPlan(this.options.view().providers, row.family);
    if (!plan) {
      this.notice = `No provider named ${row.family} to add an account to.`;
      return;
    }
    this.openWizard(plan.draft, true, 1);
  }

  private openWizard(draft: ProviderDraft, locked: boolean, step: number): void {
    this.pending = { draft: structuredClone(draft), locked };
    this.notice = undefined;
    this.stage = { kind: "wizard", step, locked };
    this.selected = 0;
    this.syncInputs();
  }

  private syncInputs(): void {
    if (this.stage.kind !== "wizard") return;
    for (const step of this.steps()) {
      const input = this.inputFor(step);
      if (step.choices) continue;
      if (input.getValue() !== step.value) input.setValue(step.value);
      input.focused = this.isFocused && this.steps()[this.stage.step]?.key === step.key;
    }
  }

  private inputFor(step: DraftStep): Input {
    let input = this.inputs.get(step.key);
    if (!input) {
      input = new Input({ prompt: "", placeholder: step.placeholder });
      input.onSubmit = (value) => this.submit(value);
      input.onEscape = () => this.back();
      input.setValue(step.value);
      this.inputs.set(step.key, input);
    }
    return input;
  }

  private fieldInput(): Input | undefined {
    if (this.stage.kind !== "wizard") return undefined;
    const step = this.steps()[this.stage.step];
    return step && !step.choices ? this.inputFor(step) : undefined;
  }

  /** Every keypress lands in the draft, so Back never loses a character. */
  private captureInput(): void {
    const stage = this.stage;
    const input = this.fieldInput();
    if (stage.kind !== "wizard" || !input || !this.pending) return;
    const step = this.steps()[stage.step];
    if (!step) return;
    this.pending.draft[step.key] = input.getValue();
  }

  private submit(value: string): void {
    const stage = this.stage;
    if (stage.kind !== "wizard" || !this.pending) return;
    const step = this.steps()[stage.step];
    if (!step || step.choices) return;
    this.advance(step, value);
  }

  private chooseValue(step: DraftStep, value: string): void {
    this.advance(step, value);
  }

  private advance(step: DraftStep, value: string): void {
    const stage = this.stage;
    if (stage.kind !== "wizard" || !this.pending) return;
    const problem = stepProblem(step.key, value, this.context(step));
    if (problem) {
      this.problem = problem;
      return;
    }
    this.pending.draft[step.key] = value;
    // A provider named after its id is the common case; typing it twice is not.
    if (step.key === "id" && this.pending.draft.name.trim() === "") this.pending.draft.name = value.trim();
    this.problem = undefined;
    this.notice = undefined;
    const next = stage.step + 1;
    if (next < this.steps().length) {
      this.stage = { kind: "wizard", step: next, locked: stage.locked };
      this.selected = 0;
      this.syncInputs();
      return;
    }
    this.finish({ kind: "save", draft: structuredClone(this.pending.draft) });
  }

  private context(step: DraftStep): { existingIds: readonly string[]; editingId?: string } {
    const ids = Object.keys(this.options.view().providers);
    if (step.key !== "id") return { existingIds: ids };
    // A locked id is the entry being edited; it may collide with itself.
    return { existingIds: ids, ...(this.stage.kind === "wizard" && this.stage.locked ? { editingId: this.currentDraft().id } : {}) };
  }

  // ---- navigation ----------------------------------------------------------

  private go(stage: Stage): void {
    this.stage = stage;
    this.selected = 0;
    this.notice = undefined;
    this.syncInputs();
  }

  private toList(): void {
    // The pending draft survives a trip back to the list: the popup is still
    // open, so "add" resumes where it was. Closing the popup is what clears it.
    this.stage = { kind: "list" };
    this.selected = this.current();
    this.notice = undefined;
  }

  private back(): void {
    const stage = this.stage;
    switch (stage.kind) {
      case "home":
        this.finish({ kind: "close" });
        return;
      case "list":
        this.go({ kind: "home" });
        return;
      case "provider":
        this.toList();
        return;
      case "models":
        this.go({ kind: "provider", row: stage.row });
        return;
      case "confirm-delete":
      case "confirm-model":
        this.go({ kind: "provider", row: stage.row });
        return;
      case "wizard": {
        this.captureInput();
        if (stage.step === 0) {
          this.toList();
          return;
        }
        this.notice = undefined;
        this.stage = { kind: "wizard", step: stage.step - 1, locked: stage.locked };
        this.selected = 0;
        this.syncInputs();
      }
    }
  }

  private handleKey(data: string): boolean | void {
    const stage = this.stage;
    if (isPopupCloseKey(data)) {
      if (stage.kind === "home") return false;
      this.back();
      return true;
    }
    if (stage.kind === "wizard") {
      const step = this.steps()[stage.step];
      if (!step) return true;
      if (step.choices) {
        const count = step.choices.length;
        if (matchesKey(data, "up") || data === "k") this.selected = (this.current() + count - 1) % count;
        else if (matchesKey(data, "down") || data === "j") this.selected = (this.current() + 1) % count;
        else if (matchesKey(data, "enter")) this.chooseValue(step, step.choices[this.current()]!);
        else if (/^[1-9]$/.test(data)) {
          const index = Number(data) - 1;
          if (index < count) this.chooseValue(step, step.choices[index]!);
        } else return true;
        return true;
      }
      const input = this.inputFor(step);
      input.handleInput(data);
      this.captureInput();
      return true;
    }
    const count = this.count();
    if (!count) return false;
    if (matchesKey(data, "up") || data === "k") {
      this.selected = (this.current() + count - 1) % count;
      return true;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.selected = (this.current() + 1) % count;
      return true;
    }
    if ((stage.kind === "home" || stage.kind === "list") && data === "a") {
      this.startAdd();
      return true;
    }
    if (stage.kind === "provider" && data === "c") {
      this.startAccount(stage.row);
      return true;
    }
    if (stage.kind === "provider" && data === "e") {
      this.startEdit(stage.row);
      return true;
    }
    if (stage.kind === "provider" && data === "d") {
      this.go({ kind: "confirm-delete", row: stage.row });
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
    this.selected = target;
    this.choose(target);
    return true;
  }

  private choose(index: number): void {
    const stage = this.stage;
    if (stage.kind === "wizard") {
      const step = this.steps()[stage.step];
      const entry = this.entries()[index];
      if (step && entry) this.selected = index;
      entry?.run();
      return;
    }
    if (stage.kind === "list") {
      const rows = this.rows();
      if (index >= rows.length) {
        this.startAdd();
        return;
      }
      const row = rows[index];
      if (row) this.go({ kind: "provider", row });
      return;
    }
    this.entries()[index]?.run();
  }

  private finish(result: ProviderPopupResult): void {
    if (this.closed) return;
    this.closed = true;
    this.pending = undefined;
    for (const input of this.inputs.values()) input.focused = false;
    this.options.onDone(result);
  }
}

/** A new provider starts from the defaults, not from the last one. */
function blankDraft(): ProviderDraft {
  return { id: "", name: "", api: "openai-completions", baseUrl: "", apiKey: "" };
}

/** Kept local so the popup does not import the whole config entry point twice. */
function describeModel(model: ModelRow): string {
  const bits: string[] = [];
  if (model.contextWindow) bits.push(`ctx ${formatTokens(model.contextWindow)}`);
  if (model.maxTokens) bits.push(`out ${formatTokens(model.maxTokens)}`);
  if (model.reasoning) bits.push("reasoning");
  if (model.name !== model.id) bits.push(model.name);
  if (model.overridden) bits.push("native override");
  return bits.join(" · ") || "no limits recorded";
}

function formatTokens(value: number): string {
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
}
