/**
 * `/router` as something you can edit, instead of a JSON file you have to
 * remember the shape of.
 *
 * The popup never writes: it reports an action and the extension applies it
 * through the same writer the command uses, then the next render re-reads the
 * view. Adding models is the one thing it cannot do alone — the picker is its
 * own overlay — so that action ends the popup and the extension reopens it
 * after the picker returns. A cancelled picker therefore leaves the config
 * untouched, rather than saving a route with no targets.
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
  METHOD_HINTS, METHOD_LABELS, WHEN_HINTS, WHEN_LABELS, ROUTE_METHODS, ROUTE_WHENS,
  type RouteMethod, type RouteTarget, type RouteWhen,
} from "../provider/model-routes.ts";
import {
  TARGET_THINKING, cycleValue, describeTarget, fileChoiceOf, methodOf, moveTarget, replaceTarget,
  routeNameProblem, suggestRouteName, whenOf, withPolicy,
  type RouterAction, type RouterDraft, type RouterPopupResult, type RouterRow,
  type RouterSettingsView,
} from "../provider/router-settings.ts";
import { PopupShell, type PopupShellModel } from "./shell.ts";

export interface RouterSettingsPopupOptions {
  /** Re-read on every render: the extension owns the routes, not the popup. */
  view: () => RouterSettingsView;
  /** Apply one change; return the confirmation line, or throw to report a failure. */
  apply: (action: RouterAction) => string;
  theme?: PopupTheme;
  terminalRows?: () => number;
  onDone: (result: RouterPopupResult) => void;
}

type Stage =
  | { kind: "list" }
  | { kind: "route"; row: RouterRow }
  | { kind: "targets"; row: RouterRow }
  | { kind: "target"; row: RouterRow; index: number }
  | { kind: "method"; row: RouterRow }
  | { kind: "when"; row: RouterRow }
  | { kind: "thinking"; row: RouterRow; index: number }
  | { kind: "pool"; row: RouterRow; index: number }
  | { kind: "rename"; row: RouterRow }
  | { kind: "create" }
  | { kind: "where"; name: string }
  | { kind: "confirm"; row: RouterRow };

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

export class RouterSettingsPopup implements Component, Focusable {
  private readonly options: RouterSettingsPopupOptions;
  private readonly theme: PopupTheme;
  private readonly shell: PopupShell;
  private readonly inputs: { create: Input; rename: Input };
  private stage: Stage = { kind: "list" };
  private selected = 0;
  private notice?: string;
  private closed = false;
  private isFocused = false;
  private layout: Layout = { firstRow: [], entryForRow: [] };

  constructor(options: RouterSettingsPopupOptions) {
    this.options = options;
    this.theme = options.theme ?? PLAIN_THEME;
    const make = (prompt: string, placeholder: string, submit: (value: string) => void) => {
      const input = new Input({ prompt, placeholder });
      input.onSubmit = submit;
      input.onEscape = () => this.back();
      return input;
    };
    this.inputs = {
      create: make("Name: ", "auto, cheap, fast", (value) => this.submitName(value)),
      rename: make("Name: ", "auto", (value) => this.submitRename(value)),
    };
    this.shell = new PopupShell({
      theme: this.theme,
      title: "Router routes",
      hint: () => this.hint(),
      terminalRows: options.terminalRows,
      model: (width) => this.model(width),
      onKey: (data) => this.handleKey(data),
      onBodyClick: (index) => this.handleBodyClick(index),
      reveal: () => this.layout.firstRow[this.current()],
      onClose: () => this.finish(undefined),
      pad: true,
    });
  }

  get focused(): boolean {
    if (this.stage.kind === "create") return this.inputs.create.focused;
    if (this.stage.kind === "rename") return this.inputs.rename.focused;
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.inputs.create.focused = value && this.stage.kind === "create";
    this.inputs.rename.focused = value && this.stage.kind === "rename";
  }

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
    this.inputs.create.invalidate();
    this.inputs.rename.invalidate();
    this.shell.invalidate();
  }

  dispose(): void {
    this.closed = true;
    this.inputs.create.focused = false;
    this.inputs.rename.focused = false;
  }

  render(width: number): string[] {
    return this.shell.render(width);
  }

  // ---- view ----------------------------------------------------------------

  private rows(): readonly RouterRow[] {
    return this.options.view().rows;
  }

  /** Selectable list entries: the routes, then the add row. */
  private count(): number {
    if (this.stage.kind === "list") return this.rows().length + 1;
    return this.entries().length;
  }

  private current(): number {
    return Math.min(this.selected, Math.max(0, this.count() - 1));
  }

  private hint(): string {
    switch (this.stage.kind) {
      case "create":
      case "rename":
        return "Enter continue · Esc back";
      case "list":
        return "↑↓ move · Enter open · a add · Esc close";
      default:
        return "↑↓ move · Enter apply · Esc back";
    }
  }

  private header(): PopupRow[] {
    const theme = this.theme;
    const view = this.options.view();
    const header: PopupRow[] = [
      `${theme.fg("dim", "workspace")}  ${view.cwd}`,
      `${theme.fg("dim", "config   ")}  ${view.sources.length ? view.sources.join(", ") : "(none yet — saving creates one)"}`,
      `${theme.fg("dim", "pools    ")}  ${view.pools.length ? view.pools.join(", ") : "(none)"}`,
    ];
    if (view.errors.length) header.push("", theme.fg("error", view.errors[0]!));
    if (this.notice) header.push("", theme.fg("warning", this.notice));
    header.push("");
    return header;
  }

  private model(width: number): PopupShellModel {
    this.lastWidth = width;
    const header = this.header();
    switch (this.stage.kind) {
      case "list":
        return { header, body: this.listBody() };
      case "create":
        return { header, body: this.inputBody(this.inputs.create, width, "A new virtual model under the router provider.") };
      case "rename":
        return { header, body: this.inputBody(this.inputs.rename, width, `Rename router/${this.stage.row.route.name}. Its models and policy are kept.`) };
      case "where":
        return { header, body: [this.theme.bold(`Save router/${this.stage.name} where?`), "", ...this.menuBody(this.entries())] };
      case "confirm":
        return { header, body: this.confirmBody(this.stage.row) };
      case "targets":
        return { header, body: [this.contextLine(), "", ...this.menuBody(this.entries())] };
      default:
        return { header, body: [this.contextLine(), "", ...this.menuBody(this.entries())] };
    }
  }

  private contextLine(): PopupRow {
    const theme = this.theme;
    switch (this.stage.kind) {
      case "route": return theme.bold(`router/${this.stage.row.route.name}  ${theme.fg("dim", this.stage.row.policy)}`);
      case "targets": return theme.bold(`Chain of router/${this.stage.row.route.name}`);
      case "target": return theme.bold(`Target ${this.stage.index + 1}/${this.stage.row.route.targets.length}`);
      case "method": return theme.bold("How should the candidates be ordered?");
      case "when": return theme.bold("When should the chain be re-decided?");
      case "thinking": return theme.bold("Thinking level for this target");
      case "pool": return theme.bold("Account pool for this target");
      default: return "";
    }
  }

  private inputBody(input: Input, width: number, help: string): PopupRow[] {
    return [this.contextLine(), ...input.render(width), "", ...wrapTextWithAnsi(this.theme.fg("dim", help), Math.max(8, width - 2))];
  }

  private confirmBody(row: RouterRow): PopupRow[] {
    const theme = this.theme;
    const name = row.route.name;
    const body: PopupRow[] = [
      theme.bold(`Delete router/${name}?`),
      "",
      ...this.menuBody(this.entries()),
      "",
    ];
    body.push(...wrapTextWithAnsi(
      theme.fg("dim", `Only this route is removed from ${row.source === "global" ? "the global" : "the project"} config. Pools and other routes are untouched.`),
      Math.max(8, this.lastWidth - 2),
    ));
    return body;
  }

  private lastWidth = 80;

  private listBody(): PopupRow[] {
    const theme = this.theme;
    const view = this.options.view();
    const rows: PopupRow[] = [];
    const firstRow: number[] = [];
    const entryForRow: number[] = [];
    let selectable = 0;

    rows.push(theme.bold(theme.fg("accent", "ROUTES")));
    if (!view.rows.length) rows.push(theme.fg("dim", "  none yet — press a to add one"));
    for (const row of view.rows) {
      firstRow[selectable] = rows.length;
      const marker = this.current() === selectable ? theme.bold("›") : " ";
      const count = `${row.route.targets.length} model${row.route.targets.length === 1 ? "" : "s"}`;
      rows.push(`${marker} ${theme.fg("accent", row.id)}  ${row.policy}  ${theme.fg("dim", `${count} · ${row.source}`)}`);
      rows.push(`    ${theme.fg("muted", row.chain)}`);
      for (const issue of row.issues) rows.push(`    ${theme.fg("warning", `⚠ ${issue}`)}`);
      entryForRow.push(selectable, ...Array.from({ length: row.issues.length + 1 }, () => selectable));
      selectable++;
    }
    firstRow[selectable] = rows.length;
    rows.push(`${this.current() === selectable ? theme.bold("›") : " "} + add a route…`);
    entryForRow.push(selectable);

    if (view.shadowed.length) {
      rows.push("");
      rows.push(theme.bold(theme.fg("accent", "SHADOWED BY THE PROJECT")));
      for (const row of view.shadowed) rows.push(theme.fg("dim", `  ${row.id} — deleting the project copy restores this one`));
    }
    if (view.pools.length) {
      rows.push("");
      rows.push(theme.bold(theme.fg("accent", "POOLS")));
      rows.push(theme.fg("dim", `  ${view.pools.join(", ")} — set per target from the chain menu`));
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
    // Keep the click map coherent while a menu is open: list lines must not
    // resolve to a stale route index.
    this.layout = { firstRow, entryForRow };
    return rows;
  }

  // ---- menus ---------------------------------------------------------------

  private entries(): Entry[] {
    const stage = this.stage;
    switch (stage.kind) {
      case "list":
      case "create":
      case "rename":
      case "confirm":
        return stage.kind === "confirm" ? this.confirmEntries(stage.row) : [];
      case "where":
        return [
          {
            label: "This workspace",
            detail: ".pi/account-router.json",
            run: () => this.finish(this.draftFor(stage.name, "project")),
          },
          {
            label: "Every workspace",
            detail: "the agent-dir account-router.json",
            run: () => this.finish(this.draftFor(stage.name, "global")),
          },
        ];
      case "route":
        return this.routeEntries(stage.row);
      case "targets":
        return this.targetEntries(stage.row);
      case "target":
        return this.targetActions(stage.row, stage.index);
      case "method":
        return ROUTE_METHODS.map((method) => ({
          label: METHOD_LABELS[method],
          detail: `${method === methodOf(stage.row.route) ? "current · " : ""}${METHOD_HINTS[method]}`,
          run: () => this.applyRoute(stage.row, { ...stage.row.route, method }),
        }));
      case "when":
        return ROUTE_WHENS.map((when) => ({
          label: WHEN_LABELS[when],
          detail: `${when === whenOf(stage.row.route) ? "current · " : ""}${WHEN_HINTS[when]}`,
          run: () => this.applyRoute(stage.row, { ...stage.row.route, when }),
        }));
      case "thinking": {
        const current = stage.row.route.targets[stage.index]?.thinking;
        return TARGET_THINKING.map((level) => ({
          label: level ? level : "provider default",
          detail: level === current || (!level && current === undefined) ? "current" : undefined,
          run: () => this.setTarget(stage.row, stage.index, { ...(stage.row.route.targets[stage.index] ?? { model: "" }), thinking: level }),
        }));
      }
      case "pool": {
        const current = stage.row.route.targets[stage.index]?.pool;
        const pools = ["", ...this.options.view().pools];
        return pools.map((pool) => ({
          label: pool || "no pool",
          detail: pool === (current ?? "") ? "current" : undefined,
          run: () => this.setTarget(stage.row, stage.index, { ...(stage.row.route.targets[stage.index] ?? { model: "" }), pool: pool || undefined }),
        }));
      }
    }
  }

  private routeEntries(row: RouterRow): Entry[] {
    const entries: Entry[] = [
      { label: "Add models…", detail: "opens the model picker", run: () => this.finish({ kind: "pick-models", draft: { route: row.route, file: fileChoiceOf(row.source) } }) },
      { label: "Edit chain…", detail: `${row.route.targets.length} target(s)`, run: () => this.go({ kind: "targets", row }) },
      { label: `Method: ${METHOD_LABELS[methodOf(row.route)]}`, detail: "how candidates are ordered", run: () => this.go({ kind: "method", row }) },
      { label: `When: ${WHEN_LABELS[whenOf(row.route)]}`, detail: "when the chain is re-decided", run: () => this.go({ kind: "when", row }) },
      { label: "Rename…", detail: "keeps models and policy", run: () => this.startRename(row) },
      { label: "Delete this route", detail: "removes it from its config file", run: () => this.go({ kind: "confirm", row }) },
    ];
    if (row.route.sticky === false) entries.splice(4, 0, { label: "Turn stickiness on", detail: "continuations stay on the answering model", run: () => this.applyRoute(row, { ...row.route, sticky: undefined }) });
    else entries.splice(4, 0, { label: "Turn stickiness off", detail: "continuations may switch models too", run: () => this.applyRoute(row, { ...row.route, sticky: false }) });
    return entries;
  }

  private targetEntries(row: RouterRow): Entry[] {
    const entries: Entry[] = row.route.targets.map((target, index) => ({
      label: `${index + 1}. ${describeTarget(target)}`,
      detail: index === 0 ? "primary" : undefined,
      run: () => this.go({ kind: "target", row, index }),
    }));
    entries.push({ label: "← back", run: () => this.back() });
    return entries;
  }

  private targetActions(row: RouterRow, index: number): Entry[] {
    const target = row.route.targets[index];
    const entries: Entry[] = [];
    if (!target) return [{ label: "← back", run: () => this.back() }];
    if (index > 0) {
      entries.push({ label: "Make primary", detail: "move to the front of the chain", run: () => this.setTargets(row, moveTarget(row.route.targets, index, -index)) });
      entries.push({ label: "Move up", run: () => this.setTargets(row, moveTarget(row.route.targets, index, -1)) });
    }
    if (index < row.route.targets.length - 1) {
      entries.push({ label: "Move down", run: () => this.setTargets(row, moveTarget(row.route.targets, index, 1)) });
    }
    entries.push({ label: `Thinking: ${target.thinking ?? "provider default"}`, run: () => this.go({ kind: "thinking", row, index }) });
    entries.push({ label: `Pool: ${target.pool ?? "none"}`, run: () => this.go({ kind: "pool", row, index }) });
    entries.push({ label: "Remove from the chain", detail: "other targets keep their order", run: () => this.setTargets(row, replaceTarget(row.route.targets, index, undefined)) });
    entries.push({ label: "← back", run: () => this.back() });
    return entries;
  }

  private confirmEntries(row: RouterRow): Entry[] {
    return [
      { label: `Delete router/${row.route.name}`, detail: `from ${row.source === "global" ? "the global" : "the project"} config`, run: () => this.deleteRoute(row) },
      { label: "Keep it", detail: "nothing changes", run: () => this.back() },
    ];
  }

  // ---- actions -------------------------------------------------------------

  private draftFor(name: string, file: "project" | "global"): RouterPopupResult {
    const draft: RouterDraft = { route: { name: name.trim(), targets: [] }, file };
    return { kind: "pick-models", draft };
  }

  private applyRoute(row: RouterRow, route: RouterRow["route"]): void {
    const method = methodOf(route);
    const when = whenOf(route);
    this.apply({ kind: "save", route: withPolicy(route, method, when), file: fileChoiceOf(row.source) });
  }

  private setTargets(row: RouterRow, targets: RouteTarget[]): void {
    if (!targets.length) {
      this.notice = "A route needs at least one target. Use Delete this route to remove it.";
      this.go({ kind: "targets", row });
      return;
    }
    this.applyRoute(row, { ...row.route, targets });
    this.go({ kind: "targets", row });
  }

  private setTarget(row: RouterRow, index: number, target: RouteTarget): void {
    this.applyRoute(row, { ...row.route, targets: replaceTarget(row.route.targets, index, target) });
    // A target setting returns to that target's own menu, so the next setting
    // (thinking, then pool) is one keypress away instead of a re-navigation.
    this.go({ kind: "target", row, index });
  }

  private deleteRoute(row: RouterRow): void {
    this.apply({ kind: "delete", name: row.route.name, file: fileChoiceOf(row.source) });
    this.toList();
  }

  private apply(action: RouterAction): void {
    try {
      this.notice = this.options.apply(action);
    } catch (error) {
      this.notice = `Router: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // ---- name input ----------------------------------------------------------

  private startCreate(): void {
    const existing = this.rows().map((row) => row.route.name);
    const input = this.inputs.create;
    input.setValue(suggestRouteName(existing));
    input.focused = this.isFocused;
    this.stage = { kind: "create" };
    this.selected = 0;
  }

  private startRename(row: RouterRow): void {
    const input = this.inputs.rename;
    input.setValue(row.route.name);
    input.focused = this.isFocused;
    this.stage = { kind: "rename", row };
    this.selected = 0;
  }

  private submitName(value: string): void {
    if (this.stage.kind !== "create") return;
    const existing = this.rows().map((row) => row.route.name);
    const problem = routeNameProblem(value, existing);
    if (problem) {
      this.notice = problem;
      return;
    }
    this.notice = undefined;
    this.inputs.create.focused = false;
    this.stage = { kind: "where", name: value.trim() };
    this.selected = 0;
  }

  private submitRename(value: string): void {
    const stage = this.stage;
    if (stage.kind !== "rename") return;
    const others = this.rows().map((row) => row.route.name).filter((name) => name !== stage.row.route.name);
    const problem = routeNameProblem(value, others);
    if (problem) {
      this.notice = problem;
      return;
    }
    const name = value.trim();
    this.notice = undefined;
    this.inputs.rename.focused = false;
    if (name === stage.row.route.name) {
      this.toList();
      return;
    }
    this.apply({ kind: "rename", from: stage.row.route.name, route: { ...stage.row.route, name }, file: fileChoiceOf(stage.row.source) });
    this.toList();
  }

  // ---- navigation ----------------------------------------------------------

  private go(stage: Stage): void {
    this.stage = stage;
    this.selected = 0;
    this.inputs.create.focused = false;
    this.inputs.rename.focused = false;
  }

  private back(): void {
    switch (this.stage.kind) {
      case "list":
        this.finish(undefined);
        return;
      case "route":
      case "create":
        this.toList();
        return;
      case "where":
        // Return to the name field with the text intact, so a wrong chooser is
        // one Escape away instead of a retype.
        this.stage = { kind: "create" };
        this.selected = 0;
        return;
      case "rename":
        this.toList();
        return;
      case "targets":
        this.go({ kind: "route", row: this.stage.row });
        return;
      case "target":
        this.go({ kind: "targets", row: this.stage.row });
        return;
      case "thinking":
      case "pool":
        // A target setting returns to that target's own menu, not to the route.
        this.go({ kind: "target", row: this.stage.row, index: this.stage.index });
        return;
      case "confirm":
        this.go({ kind: "route", row: this.stage.row });
        return;
      default:
        this.go({ kind: "route", row: this.stage.row });
    }
  }

  private toList(): void {
    this.stage = { kind: "list" };
    this.inputs.create.focused = false;
    this.inputs.rename.focused = false;
    this.selected = this.current();
  }

  private handleKey(data: string): boolean | void {
    const stage = this.stage;
    if (stage.kind === "create" || stage.kind === "rename") {
      if (isPopupCloseKey(data)) {
        this.back();
        return true;
      }
      this.inputs[stage.kind].handleInput(data);
      return true;
    }
    if (isPopupCloseKey(data)) {
      // In the list the shell closes the popup; inside a menu Escape is "back".
      if (stage.kind === "list") return false;
      this.back();
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
    if (stage.kind === "list" && data === "a") {
      this.startCreate();
      return true;
    }
    if (matchesKey(data, "enter")) {
      this.choose(this.current());
      return true;
    }
    // `m`/`w` walk the two vocabularies without opening a menu: the common edit
    // is one keypress, and the menu is still there for the explanation.
    if (stage.kind === "route" && (data === "m" || data === "w")) {
      const route = stage.row.route;
      const changed = data === "m"
        ? { ...route, method: cycleMethodOrUndefined(methodOf(route)) }
        : { ...route, when: cycleValue<RouteWhen>(["turn", "failure", "quota", "overflow"], whenOf(route)) };
      this.applyRoute(stage.row, changed);
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
    if (stage.kind === "list") {
      const rows = this.rows();
      if (index >= rows.length) {
        this.startCreate();
        return;
      }
      const row = rows[index];
      if (row) this.go({ kind: "route", row });
      return;
    }
    this.entries()[index]?.run();
  }

  private finish(result: RouterPopupResult): void {
    if (this.closed) return;
    this.closed = true;
    this.inputs.create.focused = false;
    this.inputs.rename.focused = false;
    this.options.onDone(result);
  }
}

/** Selectable rows in the list are every route plus one "add" entry. */

function cycleMethodOrUndefined(current: RouteMethod): RouteMethod | undefined {
  const order: Array<RouteMethod | undefined> = ["priority", "round-robin", "cheapest", "last-good", undefined];
  const index = order.indexOf(current);
  return order[(index + 1) % order.length];
}
