/**
 * The `/router` editor as the web drives it.
 *
 * The TUI popup owns its screen, so it can keep a draft in a component. The web
 * cannot: every screen is a dialog the extension publishes and every answer
 * comes back through the action pipeline, so the draft has to live in a value
 * the extension can hold between two dialogs. That value, its screens and their
 * validation are pure functions here — the extension supplies the route table,
 * the catalogue and the file, this module decides what the next screen is.
 *
 * Four screens, and every one of them writes nothing:
 *
 *   list     → the routes, their policies and their problems
 *   form     → one route: name, file, method, when, and its chain
 *   targets  → the catalogue as a tick list, for building that chain
 *   delete   → the confirmation, because a route is a file entry
 *
 * A step either returns the next screen or names the one `RouterAction` to
 * apply, so the write stays in the extension and goes through the same writer
 * `/router reload` and the TUI editor use. Nothing here reads the clock, the
 * disk or pi.
 */
import type {
  DialogAction, DialogField, DialogItem, DialogWebView, ListItem, ListStatus, ListWebView,
} from "../../web/core/plugin-contracts/view.ts";
import { VIEW_MAX_ROWS } from "../../web/core/plugin-contracts/view.ts";
import {
  ROUTER_BACK_ACTION,
  ROUTER_DELETE_ACTION,
  ROUTER_DELETE_CONFIRM_ACTION,
  ROUTER_FILE_FIELD,
  ROUTER_FILTER_ACTION,
  ROUTER_FILTER_FIELD,
  ROUTER_METHOD_FIELD,
  ROUTER_MODEL_VALUE,
  ROUTER_NAME_FIELD,
  ROUTER_OPEN_ACTION,
  ROUTER_ROUTE_VALUE,
  ROUTER_SAVE_ACTION,
  ROUTER_TARGETS_ACTION,
  ROUTER_TOGGLE_ACTION,
  ROUTER_WHEN_FIELD,
  routerDialogId,
} from "../../web/plugins/router/contract.ts";
import {
  METHOD_HINTS, ROUTE_METHODS, ROUTE_WHENS, WHEN_HINTS, routeMethod, routeWhen,
  type RouteConfig, type RouteMethod, type RouteTarget, type RouteWhen,
} from "./model-routes.ts";
import {
  describeChain, describeTarget, fileChoiceOf, routeIssues, routeNameProblem, suggestRouteName,
  withPolicy, type RouterFileChoice, type RouterRow, type RouterSettingsView,
} from "./router-settings.ts";

/** What a screen needs that the extension owns: the table, the catalogue, the warmth. */
export type RouterWebContext = {
  view: RouterSettingsView;
  /** `provider/model` refs a target may name, already filtered and sorted. */
  models: readonly string[];
  /** How warm a model is, as `/router status` prints it. Absent when unknown. */
  warmth?: Readonly<Record<string, string>>;
};

/**
 * One route being edited.
 *
 * `base` is the route as it was loaded, so fields this editor does not show
 * (a label, a description, a route-level pool) survive a save. `from` is the
 * name it had, which is what makes a rename a rename instead of a new route
 * beside a stale one; `undefined` means the route does not exist yet.
 */
export type RouterWebDraft = {
  base: RouteConfig;
  name: string;
  file: RouterFileChoice;
  method: RouteMethod;
  when: RouteWhen;
  targets: readonly RouteTarget[];
  from?: string;
};

export type RouterWebListScreen = { kind: "list"; notice?: string; problem?: string };
export type RouterWebFormScreen = { kind: "form"; draft: RouterWebDraft; problem?: string };
/** The target picker: the draft plus the text the list is narrowed by. */
export type RouterWebTargetsScreen = { kind: "targets"; draft: RouterWebDraft; filter?: string };
export type RouterWebDeleteScreen = { kind: "delete"; draft: RouterWebDraft };

export type RouterWebScreen =
  | RouterWebListScreen
  | RouterWebFormScreen
  | RouterWebTargetsScreen
  | RouterWebDeleteScreen;

/** What the answer to one action was: the next screen, or the write it implies. */
export type RouterWebResult =
  | { kind: "screen"; screen: RouterWebScreen }
  | { kind: "write"; screen: RouterWebScreen; action: RouterActionWrite }
  | { kind: "close" };

/**
 * The one write a step can ask for.
 *
 * Deliberately not `RouterAction`: `pick-models` is the TUI's overlay handoff
 * and has no meaning here, and a screen may only ever save, rename or delete.
 */
export type RouterActionWrite =
  | { kind: "save"; route: RouteConfig; file: RouterFileChoice }
  | { kind: "rename"; from: string; route: RouteConfig; file: RouterFileChoice }
  | { kind: "delete"; name: string; file: RouterFileChoice };

/** The route a draft would write. */
export function draftRoute(draft: RouterWebDraft): RouteConfig {
  return withPolicy({ ...draft.base, name: draft.name, targets: [...draft.targets] }, draft.method, draft.when);
}

/** A draft for a route the table already holds. */
export function draftFromRow(row: RouterRow): RouterWebDraft {
  return {
    base: row.route,
    name: row.route.name,
    file: fileChoiceOf(row.source),
    method: routeMethod(row.route),
    when: routeWhen(row.route),
    targets: row.route.targets,
    from: row.route.name,
  };
}

/** A draft for a route that does not exist yet, named so saving needs no typing. */
export function newDraft(view: RouterSettingsView, file: RouterFileChoice): RouterWebDraft {
  const name = suggestRouteName(view.rows.map((row) => row.route.name));
  return { base: { name, targets: [] }, name, file, method: "priority", when: "turn", targets: [] };
}

/** The editor's first screen. */
export function routerWebStart(): RouterWebScreen {
  return { kind: "list" };
}

// ── the right sidebar panel ─────────────────────────────────────────────────

/**
 * What the sidebar panel reads: the table, and how warm each target is.
 *
 * Warmth is keyed by `warmthKey(route, model)` rather than by model, because a
 * cache entry belongs to the account that wrote it: the same model reached
 * through two routes with different pools is two different entries.
 */
export type RouterPanelContext = {
  view: RouterSettingsView;
  warmth?: Readonly<Record<string, string>>;
  /** The model the route is currently answering from, keyed by route name. */
  current?: Readonly<Record<string, string>>;
};

/** The key a panel warmth reading is filed under. */
export function warmthKey(routeName: string, model: string): string {
  return `${routeName}/${model}`;
}

/**
 * The sidebar panel: one row per route, its chain and its warmth as the detail.
 *
 * A list view is the whole of it — the host renders a panel's view read-only, so
 * this is a visualization by construction, not an editor with its controls
 * removed. Everything the panel says comes from the same `RouterSettingsView`
 * the TUI popup and the editor render, so the three cannot disagree.
 */
export function routerPanelView(context: RouterPanelContext): ListWebView {
  const { view } = context;
  const items: ListItem[] = view.rows.map((row) => {
    const current = context.current?.[row.route.name];
    return {
      text: current ? `${row.id} · ${current}` : row.id,
      status: panelStatus(row),
      detail: panelDetail(row, context, current),
    };
  });
  for (const row of view.shadowed) {
    items.push({
      text: `${row.id} (hidden)`,
      status: "neutral",
      detail: `A project route with this name wins over the global one.\n\n${panelDetail(row, context)}`,
    });
  }
  for (const error of view.errors) {
    items.push({ text: "Config error", status: "failed", detail: error });
  }
  if (items.length === 0) {
    items.push({
      text: "No routes yet",
      status: "neutral",
      detail: "A route is a virtual model in `/model` that answers from the chain you give it. Open **Models → Router** to create one.",
    });
  }
  const shown = items.slice(0, VIEW_MAX_ROWS);
  return {
    type: "list",
    title: "Routes",
    items: shown,
    ...(shown.length < items.length ? { omitted: items.length - shown.length } : {}),
  };
}

/**
 * A route's icon: blocked when the config has something wrong with it, done
 * when it does not. A healthy route is not "active" — nothing is running.
 */
function panelStatus(row: RouterRow): ListStatus {
  return row.issues.length > 0 ? "blocked" : "done";
}

/** One route's detail: its policy, its chain with warmth, and anything wrong. */
function panelDetail(row: RouterRow, context: RouterPanelContext, current?: string): string {
  const blocks: string[] = [];
  if (current) blocks.push(`**now:** \`${current}\``);
  blocks.push(`**${row.policy}**`);
  const chain = row.route.targets.map((target) => {
    const warmth = context.warmth?.[warmthKey(row.route.name, target.model)];
    const suffix = warmth === undefined ? "" : ` · ${warmth}`;
    return `- \`${describeTarget(target)}\`${suffix}`;
  });
  blocks.push(chain.length > 0 ? chain.join("\n") : "_no targets yet_");
  if (row.issues.length > 0) blocks.push(row.issues.map((issue) => `- ${issue}`).join("\n"));
  blocks.push(`_${row.source === "global" ? "global" : "project"} config_`);
  return blocks.join("\n\n");
}

// ── the view ────────────────────────────────────────────────────────────────

/** The dialog for the screen on show. */
export function routerWebView(screen: RouterWebScreen, context: RouterWebContext): DialogWebView {
  if (screen.kind === "form") return formView(screen, context);
  if (screen.kind === "targets") return targetsView(screen, context);
  if (screen.kind === "delete") return deleteView(screen);
  return listView(screen, context);
}

function listView(screen: RouterWebListScreen, context: RouterWebContext): DialogWebView {
  const { view } = context;
  const rows = view.rows;
  const items: DialogItem[] = rows.map((row) => ({
    id: row.route.name,
    label: row.id,
    detail: `${row.policy} · ${row.chain}`,
    actionId: ROUTER_OPEN_ACTION,
    values: { [ROUTER_ROUTE_VALUE]: row.route.name },
  }));
  return {
    type: "dialog",
    id: routerDialogId("list"),
    title: "Routes",
    lines: [
      ...(rows.length === 0 ? ["No routes yet. A route is a virtual model in /model that answers from the chain you give it."] : []),
      ...(screen.notice !== undefined ? [screen.notice] : []),
      ...(screen.problem !== undefined ? [`Problem: ${screen.problem}`] : []),
      ...contextLines(context),
    ],
    items,
    actions: [
      { id: ROUTER_OPEN_ACTION, label: "New route", tone: "primary", placement: "header" },
      { id: ROUTER_BACK_ACTION, label: "Close" },
    ],
  };
}

/** The facts a route list shows under the rows: where it came from and what is wrong. */
function contextLines(context: RouterWebContext): string[] {
  const { view } = context;
  const lines: string[] = [];
  if (view.sources.length > 0) lines.push(`Read from: ${view.sources.join(", ")}`);
  if (view.pools.length > 0) lines.push(`Pools: ${view.pools.join(", ")}`);
  if (view.trace !== undefined) lines.push(view.trace);
  for (const row of view.rows) {
    for (const issue of row.issues) lines.push(`router/${row.route.name}: ${issue}`);
  }
  if (view.shadowed.length > 0) {
    lines.push(`Hidden by a project route: ${view.shadowed.map((row) => row.id).join(", ")}`);
  }
  for (const error of view.errors) lines.push(`Config: ${error}`);
  return lines;
}

function formView(screen: RouterWebFormScreen, context: RouterWebContext): DialogWebView {
  const { draft } = screen;
  const creating = draft.from === undefined;
  const route = draftRoute(draft);
  const issues = routeIssues(route, context.view.pools);
  return {
    type: "dialog",
    // One id per route, so a refusal keeps the answers and a rename does not
    // reset them halfway through typing.
    id: routerDialogId(`form:${draft.from ?? "new"}`),
    title: creating ? "New route" : `router/${draft.from}`,
    lines: [
      ...(screen.problem !== undefined ? [`Problem: ${screen.problem}`] : []),
      `Chain: ${draft.targets.length > 0 ? describeChain(route) : "(none yet — choose models)"}`,
      ...(draft.targets.length > 0 ? ["Click a model below to take it out of the chain."] : []),
      ...issues.map((issue) => `Warning: ${issue}`),
    ],
    fields: formFields(draft, creating),
    items: draft.targets.slice(0, VIEW_MAX_ROWS).map((target, index) => ({
      id: `${index}:${target.model}`,
      label: `${index + 1}. ${describeTarget(target)}`,
      ...detailOf(context.warmth, target.model),
      actionId: ROUTER_TOGGLE_ACTION,
      values: { [ROUTER_MODEL_VALUE]: target.model },
    })),
    actions: formActions(draft, creating),
  };
}

/** The form's action bar: save (or pick models first), delete, back. */
function formActions(draft: RouterWebDraft, creating: boolean): DialogAction[] {
  const hasTargets = draft.targets.length > 0;
  return [
    hasTargets
      ? { id: ROUTER_SAVE_ACTION, label: creating ? "Create route" : "Save", tone: "primary", submitsInput: true }
      : { id: ROUTER_TARGETS_ACTION, label: "Choose models", tone: "primary", submitsInput: true },
    ...(hasTargets ? [{ id: ROUTER_TARGETS_ACTION, label: "Choose models", submitsInput: true }] : []),
    ...(creating ? [] : [{ id: ROUTER_DELETE_ACTION, label: "Delete", tone: "danger" as const }]),
    { id: ROUTER_BACK_ACTION, label: "Back" },
  ];
}

/** A row's warmth, when the extension knows it. */
function detailOf(warmth: Readonly<Record<string, string>> | undefined, model: string): { detail?: string } {
  const detail = warmth?.[model];
  return detail === undefined ? {} : { detail };
}

/**
 * The form's fields.
 *
 * `file` is only offered while creating: moving a saved route between files is
 * a delete plus a save, and offering it as a field would let the editor write
 * the new file before it removed the old entry.
 */
function formFields(draft: RouterWebDraft, creating: boolean): DialogField[] {
  return [
    {
      name: ROUTER_NAME_FIELD,
      label: "Route name",
      value: draft.name,
      required: true,
      help: "Letters, digits, dot, dash or underscore. /model lists it as router/<name>.",
    },
    ...(creating
      ? [{
        name: ROUTER_FILE_FIELD,
        label: "Save to",
        kind: "select" as const,
        choices: ["project", "global"],
        value: draft.file,
        help: "project writes .pi/account-router.json, global writes ~/.pi/agent/account-router.json.",
      }]
      : []),
    {
      name: ROUTER_METHOD_FIELD,
      label: "Method",
      kind: "select",
      choices: [...ROUTE_METHODS],
      value: draft.method,
      help: METHOD_HINTS[draft.method],
    },
    {
      name: ROUTER_WHEN_FIELD,
      label: "Re-decide",
      kind: "select",
      choices: [...ROUTE_WHENS],
      value: draft.when,
      help: WHEN_HINTS[draft.when],
    },
  ];
}

function targetsView(screen: RouterWebTargetsScreen, context: RouterWebContext): DialogWebView {
  const { draft } = screen;
  const picked = new Set(draft.targets.map((target) => target.model));
  const filter = screen.filter ?? "";
  const shown = pickerChoices(context.models, picked, filter);
  return {
    type: "dialog",
    id: routerDialogId(`targets:${draft.from ?? "new"}`),
    title: `Models for router/${draft.name}`,
    lines: [
      filter.trim() === ""
        ? `Ticked: ${picked.size} of ${context.models.length} available.`
        : `Ticked: ${picked.size} · ${shown.matched} match "${filter.trim()}" of ${context.models.length}.`,
      ...(shown.hidden > 0 ? [`Showing ${VIEW_MAX_ROWS} at a time; ${shown.hidden} more are hidden. Filter to narrow the list.`] : []),
      "Click a model to tick or untick it. The chain keeps the order you tick them in.",
    ],
    fields: [{
      name: ROUTER_FILTER_FIELD,
      label: "Filter",
      value: filter,
      placeholder: "provider/model, or part of one",
      help: "Ticks are kept while you filter; a ticked model stays listed even when it does not match.",
    }],
    items: shown.models.map((model) => ({
      id: model,
      label: model,
      ...detailOf(context.warmth, model),
      actionId: ROUTER_TOGGLE_ACTION,
      values: { [ROUTER_MODEL_VALUE]: model },
      selected: picked.has(model),
    })),
    // Filter submits the box; Done needs no answer, because a tick is applied
    // the moment it is clicked.
    actions: [
      { id: ROUTER_FILTER_ACTION, label: "Filter", tone: "primary", submitsInput: true },
      { id: ROUTER_BACK_ACTION, label: "Done" },
    ],
  };
}

/**
 * The catalogue rows the picker shows: the filter's matches, then any ticked
 * model the filter hid, capped at what one dialog can carry.
 *
 * Two rules earn their complexity. A ticked model is always listed — an answer
 * already given must not become invisible, because unticking it would then be
 * impossible — so a ticked model the filter excludes is appended after the
 * matches rather than dropped. And the cap is absolute: the host refuses a
 * longer list outright, so past `VIEW_MAX_ROWS` the picked models keep their
 * slots and the rest of the budget goes to matches in catalogue order.
 */
export function pickerChoices(
  models: readonly string[],
  picked: ReadonlySet<string>,
  filter: string,
): { models: string[]; hidden: number; matched: number } {
  const needle = filter.trim().toLowerCase();
  const matched = needle === ""
    ? [...models]
    : models.filter((model) => model.toLowerCase().includes(needle));
  const matchedSet = new Set(matched);
  const listed = [...matched, ...models.filter((model) => picked.has(model) && !matchedSet.has(model))];
  const shown = withinCap(listed, picked);
  return { models: shown, hidden: listed.length - shown.length, matched: matched.length };
}

/** `listed` capped at the dialog limit, keeping every picked model. */
function withinCap(listed: readonly string[], picked: ReadonlySet<string>): string[] {
  if (listed.length <= VIEW_MAX_ROWS) return [...listed];
  const kept = new Set(listed.filter((model) => picked.has(model)).slice(0, VIEW_MAX_ROWS));
  for (const model of listed) {
    if (kept.size >= VIEW_MAX_ROWS) break;
    kept.add(model);
  }
  return listed.filter((model) => kept.has(model));
}

function deleteView(screen: RouterWebDeleteScreen): DialogWebView {
  const { draft } = screen;
  const name = draft.from ?? draft.name;
  return {
    type: "dialog",
    id: routerDialogId(`delete:${name}`),
    title: `Delete router/${name}?`,
    lines: [
      `router/${name} is removed from the ${draft.file} file. Nothing else changes.`,
      ...(draft.file === "project" ? ["A global route with that name becomes active again if one exists."] : []),
    ],
    actions: [
      { id: ROUTER_DELETE_CONFIRM_ACTION, label: "Delete", tone: "danger" },
      { id: ROUTER_BACK_ACTION, label: "Keep" },
    ],
  };
}

// ── the steps ───────────────────────────────────────────────────────────────

export type RouterWebAction = { id: string; values?: Record<string, string> };

/**
 * What one action does.
 *
 * Pure: the answer is the next screen, or the write to apply first. The
 * extension applies the write and then shows the returned screen, so a refused
 * write never leaves the editor on a screen that claims it succeeded.
 */
export function routerWebStep(input: {
  screen: RouterWebScreen;
  action: RouterWebAction;
  context: RouterWebContext;
}): RouterWebResult {
  const { screen, action, context } = input;
  // Back is checked before the screen's own actions: every screen has a way
  // out, including the confirmation, whose only other answer is Delete.
  if (action.id === ROUTER_BACK_ACTION) return backStep(screen);
  if (screen.kind === "delete") return deleteStep(screen, action);
  if (screen.kind === "targets") return targetsStep(screen, action);
  if (screen.kind === "form") return formStep(screen, action, context);
  return listStep(screen, action, context);
}

function backStep(screen: RouterWebScreen): RouterWebResult {
  if (screen.kind === "list") return { kind: "close" };
  if (screen.kind === "form") return { kind: "screen", screen: { kind: "list" } };
  // The picker and the confirmation both return to the form that opened them.
  // The filter stays behind with the picker: it is a way of browsing, not part
  // of the route.
  return { kind: "screen", screen: { kind: "form", draft: screen.draft } };
}

function listStep(
  screen: RouterWebListScreen,
  action: RouterWebAction,
  context: RouterWebContext,
): RouterWebResult {
  if (action.id !== ROUTER_OPEN_ACTION) return { kind: "screen", screen };
  const name = action.values?.[ROUTER_ROUTE_VALUE];
  if (name === undefined || name === "") {
    return { kind: "screen", screen: { kind: "form", draft: newDraft(context.view, "project") } };
  }
  const row = context.view.rows.find((candidate) => candidate.route.name === name);
  if (row === undefined) {
    return { kind: "screen", screen: { kind: "list", problem: `router/${name} is no longer in the table.` } };
  }
  return { kind: "screen", screen: { kind: "form", draft: draftFromRow(row) } };
}

function formStep(
  screen: RouterWebFormScreen,
  action: RouterWebAction,
  context: RouterWebContext,
): RouterWebResult {
  const draft = draftWithValues(screen.draft, action.values);
  if (action.id === ROUTER_TOGGLE_ACTION) {
    const model = action.values?.[ROUTER_MODEL_VALUE];
    if (model === undefined) return { kind: "screen", screen };
    return { kind: "screen", screen: { kind: "form", draft: { ...draft, targets: withoutTarget(draft.targets, model) } } };
  }
  if (action.id === ROUTER_TARGETS_ACTION) return { kind: "screen", screen: { kind: "targets", draft } };
  if (action.id === ROUTER_DELETE_ACTION) {
    if (draft.from === undefined) return { kind: "screen", screen: { kind: "list", problem: "Nothing to delete yet." } };
    return { kind: "screen", screen: { kind: "delete", draft } };
  }
  if (action.id === ROUTER_SAVE_ACTION) return saveStep(draft, context);
  return { kind: "screen", screen: { kind: "form", draft } };
}

function saveStep(draft: RouterWebDraft, context: RouterWebContext): RouterWebResult {
  const problem = saveProblem(draft, context);
  if (problem !== undefined) return { kind: "screen", screen: { kind: "form", draft, problem } };
  const route = draftRoute(draft);
  const saved = { kind: "list" as const, notice: `Saved router/${route.name} in the ${draft.file} file.` };
  if (draft.from !== undefined && draft.from !== route.name) {
    return { kind: "write", screen: saved, action: { kind: "rename", from: draft.from, route, file: draft.file } };
  }
  return { kind: "write", screen: saved, action: { kind: "save", route, file: draft.file } };
}

/** Why this draft cannot be written, or `undefined` when it can. */
export function saveProblem(draft: RouterWebDraft, context: RouterWebContext): string | undefined {
  const others = context.view.rows
    .map((row) => row.route.name)
    .filter((name) => name !== draft.from);
  const nameProblem = routeNameProblem(draft.name, others);
  if (nameProblem !== undefined) return nameProblem;
  if (draft.targets.length === 0) return "A route needs at least one model.";
  return undefined;
}

function targetsStep(screen: RouterWebTargetsScreen, action: RouterWebAction): RouterWebResult {
  if (action.id === ROUTER_FILTER_ACTION) {
    return { kind: "screen", screen: { ...screen, filter: action.values?.[ROUTER_FILTER_FIELD] ?? "" } };
  }
  if (action.id !== ROUTER_TOGGLE_ACTION) return { kind: "screen", screen };
  const model = action.values?.[ROUTER_MODEL_VALUE];
  if (model === undefined) return { kind: "screen", screen };
  return {
    kind: "screen",
    screen: { ...screen, draft: { ...screen.draft, targets: toggleTarget(screen.draft.targets, model) } },
  };
}

function deleteStep(screen: RouterWebDeleteScreen, action: RouterWebAction): RouterWebResult {
  if (action.id !== ROUTER_DELETE_CONFIRM_ACTION) return { kind: "screen", screen };
  const name = screen.draft.from ?? screen.draft.name;
  return {
    kind: "write",
    screen: { kind: "list", notice: `Removed router/${name} from the ${screen.draft.file} file.` },
    action: { kind: "delete", name, file: screen.draft.file },
  };
}

/** Tick a model that is not in the chain, or untick one that is. */
export function toggleTarget(targets: readonly RouteTarget[], model: string): RouteTarget[] {
  if (targets.some((target) => target.model === model)) return withoutTarget(targets, model);
  return [...targets, { model }];
}

/** Remove a model from the chain, keeping every other target's settings. */
export function withoutTarget(targets: readonly RouteTarget[], model: string): RouteTarget[] {
  return targets.filter((target) => target.model !== model).map((target) => ({ ...target }));
}

/**
 * The draft with the form's answers applied.
 *
 * Only values the editor published are accepted, so a stale or hand-made
 * request cannot put an unknown method into a config file.
 */
export function draftWithValues(draft: RouterWebDraft, values: Record<string, string> | undefined): RouterWebDraft {
  if (values === undefined) return draft;
  const name = values[ROUTER_NAME_FIELD]?.trim();
  const file = values[ROUTER_FILE_FIELD];
  const method = values[ROUTER_METHOD_FIELD];
  const when = values[ROUTER_WHEN_FIELD];
  return {
    ...draft,
    ...(name !== undefined && name !== "" ? { name } : {}),
    ...(draft.from === undefined && (file === "project" || file === "global") ? { file } : {}),
    ...(isMethod(method) ? { method } : {}),
    ...(isWhen(when) ? { when } : {}),
  };
}

function isMethod(value: string | undefined): value is RouteMethod {
  return value !== undefined && (ROUTE_METHODS as readonly string[]).includes(value);
}

function isWhen(value: string | undefined): value is RouteWhen {
  return value !== undefined && (ROUTE_WHENS as readonly string[]).includes(value);
}
