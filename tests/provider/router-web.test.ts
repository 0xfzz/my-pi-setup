// The `/router` web editor's screens and steps.
//
// The editor is a four-screen dialog the extension publishes and the browser
// answers, so its state has to live in a value rather than in a component. These
// tests drive that value: what each screen shows, what each answer does to it,
// and which write a step asks for. They are the editor's only coverage that does
// not need a browser.

import assert from "node:assert/strict";
import test from "node:test";

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
} from "../../web/plugins/router/contract.ts";
import type { RouteConfig } from "../../lib/provider/model-routes.ts";
import {
  draftFromRow, draftRoute, draftWithValues, newDraft, pickerChoices, routerWebStart, routerWebStep,
  routerWebView, saveProblem, toggleTarget, withoutTarget,
  type RouterWebContext, type RouterWebDraft, type RouterWebScreen,
} from "../../lib/provider/router-web.ts";
import { routerRows, type RouterSettingsView } from "../../lib/provider/router-settings.ts";

const ROUTE: RouteConfig = {
  name: "auto",
  targets: [{ model: "primary/main-model" }, { model: "backup/other", thinking: "low" }],
  method: "cache",
  when: "quota",
};

const ROUTE_2: RouteConfig = { name: "cheap", targets: [{ model: "budget/model" }], method: "cheapest" };

function viewWith(...routes: RouteConfig[]): RouterSettingsView {
  return {
    cwd: "/work",
    provider: "router",
    sources: ["/work/.pi/account-router.json"],
    rows: routerRows(routes.map((route) => ({ route, source: "project" })), "router", []),
    shadowed: [],
    pools: [],
    errors: [],
  };
}

const CONTEXT: RouterWebContext = {
  view: viewWith(ROUTE, ROUTE_2),
  models: ["primary/main-model", "backup/other", "budget/model"],
};

function step(screen: RouterWebScreen, id: string, values?: Record<string, string>, context = CONTEXT) {
  return routerWebStep({ screen, action: { id, ...(values !== undefined ? { values } : {}) }, context });
}

/** The draft a step ended on, failing the test when it ended somewhere else. */
function draftOf(result: ReturnType<typeof step>): RouterWebDraft {
  if (result.kind !== "screen") assert.fail(`expected a screen, got ${result.kind}`);
  const screen = result.screen;
  if (screen.kind === "form" || screen.kind === "targets" || screen.kind === "delete") return screen.draft;
  return assert.fail(`expected a draft screen, got ${screen.kind}`);
}

// ── the list ────────────────────────────────────────────────────────────────

test("the list shows one row per route, its policy, its chain and its problems", () => {
  const context: RouterWebContext = {
    ...CONTEXT,
    view: { ...CONTEXT.view, rows: routerRows([{ route: { ...ROUTE, targets: [{ model: "a/b" }, { model: "a/b" }] }, source: "project" }], "router", []) },
  };
  const view = routerWebView(routerWebStart(), context);
  assert.equal(view.id, "router-editor:list");
  assert.equal(view.title, "Routes");
  const row = view.items?.[0];
  assert.equal(row?.label, "router/auto");
  assert.equal(row?.actionId, ROUTER_OPEN_ACTION);
  assert.deepEqual(row?.values, { [ROUTER_ROUTE_VALUE]: "auto" });
  assert.match(row?.detail ?? "", /cache · on quota/);
  assert.match(row?.detail ?? "", /a\/b → a\/b/);
  assert.ok((view.lines ?? []).some((line) => line.includes("a/b is listed twice")),
    "a duplicate target is reported where the route is chosen");

  const normal = routerWebView(routerWebStart(), CONTEXT);
  assert.match(normal.items?.[0]?.detail ?? "", /primary\/main-model → backup\/other:low/,
    "a target's thinking level rides along in the chain");
});

test("the list offers New route in the header and Close in the footer", () => {
  const view = routerWebView(routerWebStart(), CONTEXT);
  const header = view.actions?.find((action) => action.placement === "header");
  assert.equal(header?.id, ROUTER_OPEN_ACTION);
  assert.equal(header?.label, "New route");
  assert.equal(view.actions?.at(-1)?.id, ROUTER_BACK_ACTION);
});

test("an empty table says what a route is instead of showing nothing", () => {
  const view = routerWebView(routerWebStart(), { ...CONTEXT, view: viewWith() });
  assert.equal(view.items?.length, 0);
  assert.ok((view.lines ?? []).some((line) => line.includes("virtual model in /model")));
});

// ── opening a route ─────────────────────────────────────────────────────────

test("opening a row edits that route, keeping the file it came from", () => {
  const result = step(routerWebStart(), ROUTER_OPEN_ACTION, { [ROUTER_ROUTE_VALUE]: "auto" });
  const draft = draftOf(result);
  assert.equal(draft.from, "auto", "the original name is remembered, so a rename is a rename");
  assert.equal(draft.file, "project");
  assert.equal(draft.method, "cache");
  assert.equal(draft.when, "quota");
  assert.deepEqual(draft.targets.map((target) => target.model), ["primary/main-model", "backup/other"]);
});

test("New route starts a draft whose name is already free and whose file is chosen in the form", () => {
  const result = step(routerWebStart(), ROUTER_OPEN_ACTION);
  const draft = draftOf(result);
  assert.equal(draft.from, undefined, "no original name means it does not exist yet");
  assert.equal(draft.name, "route-1");
  assert.equal(draft.file, "project");
  assert.deepEqual(draft.targets, []);
});

test("opening a route that vanished says so instead of editing a ghost", () => {
  const result = step(routerWebStart(), ROUTER_OPEN_ACTION, { [ROUTER_ROUTE_VALUE]: "gone" });
  assert.equal(result.kind, "screen");
  if (result.kind !== "screen") throw new Error("unreachable");
  assert.equal(result.screen.kind, "list");
  assert.match("problem" in result.screen ? result.screen.problem ?? "" : "", /no longer in the table/);
});

// ── the form ────────────────────────────────────────────────────────────────

test("the form names the route, offers the file only while creating, and shows the chain", () => {
  const existing = draftFromRow(CONTEXT.view.rows[0]!);
  const view = routerWebView({ kind: "form", draft: existing }, CONTEXT);
  assert.equal(view.id, "router-editor:form:auto", "one id per route, so a refusal keeps the answers");
  assert.equal(view.title, "router/auto");
  assert.deepEqual(view.fields?.map((field) => field.name), [ROUTER_NAME_FIELD, ROUTER_METHOD_FIELD, ROUTER_WHEN_FIELD]);
  assert.equal(view.fields?.[0]?.value, "auto");
  assert.deepEqual(view.items?.map((item) => item.label), ["1. primary/main-model", "2. backup/other:low"]);
  assert.equal(view.items?.[0]?.actionId, ROUTER_TOGGLE_ACTION);

  const creating = routerWebView({ kind: "form", draft: newDraft(CONTEXT.view, "project") }, CONTEXT);
  assert.equal(creating.title, "New route");
  assert.deepEqual(creating.fields?.map((field) => field.name),
    [ROUTER_NAME_FIELD, ROUTER_FILE_FIELD, ROUTER_METHOD_FIELD, ROUTER_WHEN_FIELD],
    "a saved route cannot be moved between files: that is a delete plus a save");
});

test("the form's method and when selects publish the config vocabulary, not prose", () => {
  const view = routerWebView({ kind: "form", draft: draftFromRow(CONTEXT.view.rows[0]!) }, CONTEXT);
  const method = view.fields?.find((field) => field.name === ROUTER_METHOD_FIELD);
  const when = view.fields?.find((field) => field.name === ROUTER_WHEN_FIELD);
  assert.ok(method?.choices?.includes("cache"));
  assert.ok(when?.choices?.includes("quota"));
  assert.equal(method?.value, "cache");
  assert.equal(when?.value, "quota");
});

test("a form with no targets offers Choose models instead of a save that would be refused", () => {
  const view = routerWebView({ kind: "form", draft: newDraft(CONTEXT.view, "project") }, CONTEXT);
  const primary = view.actions?.find((action) => action.tone === "primary");
  assert.equal(primary?.id, ROUTER_TARGETS_ACTION);
  assert.equal(primary?.submitsInput, true, "the typed name travels with the answer");
  assert.equal(view.actions?.some((action) => action.id === ROUTER_DELETE_ACTION), false, "nothing to delete yet");
});

test("the form shows a refused value as a problem and keeps the answers", () => {
  const draft = { ...draftFromRow(CONTEXT.view.rows[0]!), name: "cheap" };
  const view = routerWebView({ kind: "form", draft, problem: "\"cheap\" already exists." }, CONTEXT);
  assert.ok((view.lines ?? []).some((line) => line.includes("already exists")));
  assert.equal(view.fields?.[0]?.value, "cheap");
});

test("saving writes the route with the policy and chain on screen", () => {
  const draft: RouterWebDraft = { ...draftFromRow(CONTEXT.view.rows[0]!), name: "fast", method: "priority", when: "turn" };
  const result = step({ kind: "form", draft }, ROUTER_SAVE_ACTION);
  assert.equal(result.kind, "write");
  if (result.kind !== "write") throw new Error("unreachable");
  assert.equal(result.action.kind, "rename", "the name changed, so the old entry is removed too");
  if (result.action.kind !== "rename") throw new Error("unreachable");
  assert.equal(result.action.from, "auto");
  assert.equal(result.action.route.name, "fast");
  assert.equal(result.action.route.method, undefined, "a default method is dropped from the file");
  assert.equal(result.action.route.when, undefined, "and so is a default trigger");
  assert.equal(result.screen.kind, "list");
  assert.match("notice" in result.screen ? result.screen.notice ?? "" : "", /Saved router\/fast/);
});

test("saving a new route saves rather than renames", () => {
  const draft: RouterWebDraft = { ...newDraft(CONTEXT.view, "global"), targets: [{ model: "budget/model" }] };
  const result = step({ kind: "form", draft }, ROUTER_SAVE_ACTION);
  assert.equal(result.kind, "write");
  if (result.kind !== "write") throw new Error("unreachable");
  assert.equal(result.action.kind, "save");
  assert.equal(result.action.file, "global");
});

test("saving is refused with a reason when the name is taken or the chain is empty", () => {
  const taken: RouterWebDraft = { ...newDraft(CONTEXT.view, "project"), name: "auto", targets: [{ model: "budget/model" }] };
  assert.match(saveProblem(taken, CONTEXT) ?? "", /already exists/);

  const empty: RouterWebDraft = { ...newDraft(CONTEXT.view, "project"), name: "fresh" };
  assert.match(saveProblem(empty, CONTEXT) ?? "", /at least one model/);

  const reserved: RouterWebDraft = { ...newDraft(CONTEXT.view, "project"), name: "status", targets: [{ model: "budget/model" }] };
  assert.match(saveProblem(reserved, CONTEXT) ?? "", /reads like a \/router subcommand/);

  const refused = step({ kind: "form", draft: taken }, ROUTER_SAVE_ACTION);
  assert.equal(refused.kind, "screen", "a refusal writes nothing");
  if (refused.kind !== "screen") throw new Error("unreachable");
  assert.equal(refused.screen.kind, "form");
  assert.match("problem" in refused.screen ? refused.screen.problem ?? "" : "", /already exists/);
});

test("renaming a route to its own name is a plain save, not a rename", () => {
  const draft = { ...draftFromRow(CONTEXT.view.rows[0]!), method: "cheapest" as const };
  const result = step({ kind: "form", draft }, ROUTER_SAVE_ACTION);
  assert.equal(result.kind, "write");
  if (result.kind !== "write") throw new Error("unreachable");
  assert.equal(result.action.kind, "save");
});

test("clicking a chain row takes that model out of the chain", () => {
  const draft = draftFromRow(CONTEXT.view.rows[0]!);
  const result = step({ kind: "form", draft }, ROUTER_TOGGLE_ACTION, { [ROUTER_MODEL_VALUE]: "primary/main-model" });
  assert.deepEqual(draftOf(result).targets.map((target) => target.model), ["backup/other"],
    "the remaining target keeps its thinking level");
  assert.equal(draftOf(result).targets[0]?.thinking, "low");
});

// ── the target picker ───────────────────────────────────────────────────────

test("Choose models carries the typed answers into the picker", () => {
  const draft = { ...newDraft(CONTEXT.view, "project"), name: "typed" };
  const result = step({ kind: "form", draft }, ROUTER_TARGETS_ACTION, { [ROUTER_NAME_FIELD]: "from-form" });
  const carried = draftOf(result);
  assert.equal(carried.name, "from-form", "the form's answer travels, so the picker cannot lose it");
  assert.equal(result.kind === "screen" && result.screen.kind, "targets");
});

test("the picker ticks the chain and leaves the rest unticked", () => {
  const draft = draftFromRow(CONTEXT.view.rows[0]!);
  const view = routerWebView({ kind: "targets", draft }, CONTEXT);
  assert.equal(view.id, "router-editor:targets:auto");
  assert.deepEqual(
    view.items?.map((item) => [item.label, item.selected]),
    [["primary/main-model", true], ["backup/other", true], ["budget/model", false]],
  );
  assert.ok((view.lines ?? []).some((line) => line.includes("Ticked: 2 of 3")));
});

test("ticking a model appends it; unticking removes it and keeps the order of the rest", () => {
  const draft = draftFromRow(CONTEXT.view.rows[0]!);
  const added = draftOf(step({ kind: "targets", draft }, ROUTER_TOGGLE_ACTION, { [ROUTER_MODEL_VALUE]: "budget/model" }));
  assert.deepEqual(added.targets.map((target) => target.model), ["primary/main-model", "backup/other", "budget/model"]);

  const removed = draftOf(step({ kind: "targets", draft: added }, ROUTER_TOGGLE_ACTION, { [ROUTER_MODEL_VALUE]: "primary/main-model" }));
  assert.deepEqual(removed.targets.map((target) => target.model), ["backup/other", "budget/model"]);
});

test("the picker's warmth detail comes from the extension and is omitted when unknown", () => {
  const draft = draftFromRow(CONTEXT.view.rows[0]!);
  const view = routerWebView(
    { kind: "targets", draft },
    { ...CONTEXT, warmth: { "primary/main-model": "warm 58k · 3m left · 94% hit" } },
  );
  assert.equal(view.items?.[0]?.detail, "warm 58k · 3m left · 94% hit");
  assert.equal(view.items?.[1]?.detail, undefined);
});

test("a catalogue larger than one dialog keeps every ticked model visible", () => {
  const models = Array.from({ length: VIEW_MAX_ROWS + 5 }, (_, index) => `p/m${index}`);
  const picked = new Set([models[0]!, models.at(-1)!]);
  const shown = pickerChoices(models, picked, "");
  assert.equal(shown.hidden, 5);
  assert.equal(shown.models.length, VIEW_MAX_ROWS, "the cap is absolute: the host refuses a longer list");
  assert.ok(shown.models.includes(models.at(-1)!), "a ticked model past the cap is still listed");
});

test("a catalogue that fits is listed whole", () => {
  const shown = pickerChoices(["a/b", "c/d"], new Set(["c/d"]), "");
  assert.deepEqual(shown, { models: ["a/b", "c/d"], hidden: 0, matched: 2 });
});

test("the filter narrows the list and keeps a ticked model it excludes", () => {
  const models = ["antigravity/gemini-3.8-flash", "openai-codex/gpt-6.1-sol", "zro-1/glm-5.3-flash"];
  const picked = new Set(["zro-1/glm-5.3-flash"]);
  const shown = pickerChoices(models, picked, "  GEMINI  ");
  assert.equal(shown.matched, 1, "matching is case-insensitive and ignores padding");
  assert.deepEqual(shown.models, ["antigravity/gemini-3.8-flash", "zro-1/glm-5.3-flash"],
    "the ticked model stays listed so it can still be unticked");
});

test("a filter that matches nothing still shows what is ticked", () => {
  const shown = pickerChoices(["a/b", "c/d"], new Set(["c/d"]), "nope");
  assert.equal(shown.matched, 0);
  assert.deepEqual(shown.models, ["c/d"]);
});

test("the picker publishes a filter box and a Filter action that submits it", () => {
  const draft = draftFromRow(CONTEXT.view.rows[0]!);
  const view = routerWebView({ kind: "targets", draft, filter: "gemini" }, CONTEXT);
  assert.equal(view.fields?.[0]?.name, ROUTER_FILTER_FIELD);
  assert.equal(view.fields?.[0]?.value, "gemini");
  const filter = view.actions?.find((action) => action.id === ROUTER_FILTER_ACTION);
  assert.equal(filter?.submitsInput, true, "the typed filter travels with the answer");
});

test("filtering keeps the draft's ticks and returns the same picker screen", () => {
  const draft = draftFromRow(CONTEXT.view.rows[0]!);
  const result = step({ kind: "targets", draft }, ROUTER_FILTER_ACTION, { [ROUTER_FILTER_FIELD]: "gpt" });
  assert.equal(result.kind, "screen");
  if (result.kind !== "screen") throw new Error("unreachable");
  assert.equal(result.screen.kind, "targets");
  if (result.screen.kind !== "targets") throw new Error("unreachable");
  assert.equal(result.screen.filter, "gpt");
  assert.deepEqual(result.screen.draft.targets, draft.targets, "filtering never changes the chain");
});

// ── delete ──────────────────────────────────────────────────────────────────

test("Delete asks first, and Keep returns to the form", () => {
  const draft = draftFromRow(CONTEXT.view.rows[0]!);
  const asked = step({ kind: "form", draft }, ROUTER_DELETE_ACTION);
  assert.equal(asked.kind, "screen");
  if (asked.kind !== "screen") throw new Error("unreachable");
  assert.equal(asked.screen.kind, "delete");

  const view = routerWebView(asked.screen, CONTEXT);
  assert.equal(view.title, "Delete router/auto?");
  assert.equal(view.actions?.find((action) => action.tone === "danger")?.id, ROUTER_DELETE_CONFIRM_ACTION);

  const kept = step(asked.screen, ROUTER_BACK_ACTION);
  assert.equal(kept.kind, "screen");
  if (kept.kind !== "screen") throw new Error("unreachable");
  assert.equal(kept.screen.kind, "form", "Keep writes nothing and returns to the route");
});

test("confirming deletes the route from the file it was read from", () => {
  const draft = draftFromRow(CONTEXT.view.rows[0]!);
  const result = step({ kind: "delete", draft }, ROUTER_DELETE_CONFIRM_ACTION);
  assert.equal(result.kind, "write");
  if (result.kind !== "write") throw new Error("unreachable");
  assert.deepEqual(result.action, { kind: "delete", name: "auto", file: "project" });
  assert.match("notice" in result.screen ? result.screen.notice ?? "" : "", /Removed router\/auto/);
});

// ── navigation and validation ───────────────────────────────────────────────

test("Back closes from the list, returns to it from the form, and returns to the form from a step", () => {
  assert.deepEqual(step(routerWebStart(), ROUTER_BACK_ACTION), { kind: "close" });

  const draft = draftFromRow(CONTEXT.view.rows[0]!);
  const fromForm = step({ kind: "form", draft }, ROUTER_BACK_ACTION);
  assert.equal(fromForm.kind === "screen" && fromForm.screen.kind, "list");

  const fromTargets = step({ kind: "targets", draft }, ROUTER_BACK_ACTION);
  assert.equal(fromTargets.kind === "screen" && fromTargets.screen.kind, "form");
  assert.deepEqual(draftOf(fromTargets), draft, "Back from the picker keeps what was ticked");
});

test("an unknown action changes nothing", () => {
  const draft = draftFromRow(CONTEXT.view.rows[0]!);
  const result = step({ kind: "form", draft }, "not-an-action");
  assert.deepEqual(draftOf(result), draft);
});

test("the form's answers are applied only when they name a known value", () => {
  const draft = draftFromRow(CONTEXT.view.rows[0]!);
  const applied = draftWithValues(draft, {
    [ROUTER_NAME_FIELD]: "  renamed  ",
    [ROUTER_METHOD_FIELD]: "cheapest",
    [ROUTER_WHEN_FIELD]: "overflow",
  });
  assert.equal(applied.name, "renamed", "the name is trimmed");
  assert.equal(applied.method, "cheapest");
  assert.equal(applied.when, "overflow");

  const refused = draftWithValues(draft, {
    [ROUTER_METHOD_FIELD]: "telepathy",
    [ROUTER_WHEN_FIELD]: "always",
    [ROUTER_FILE_FIELD]: "global",
  });
  assert.equal(refused.method, draft.method, "an unknown method never reaches a config file");
  assert.equal(refused.when, draft.when);
  assert.equal(refused.file, "project", "a saved route cannot be moved between files");
});

test("the file field is honoured only while creating", () => {
  const creating = newDraft(CONTEXT.view, "project");
  assert.equal(draftWithValues(creating, { [ROUTER_FILE_FIELD]: "global" }).file, "global");
});

test("the written route keeps the fields the editor does not show", () => {
  const base: RouteConfig = { ...ROUTE, label: "Auto", description: "best effort", sticky: true, pool: "ag" };
  const draft: RouterWebDraft = { ...draftFromRow({ ...CONTEXT.view.rows[0]!, route: base }), method: "cheapest" };
  const route = draftRoute(draft);
  assert.equal(route.label, "Auto");
  assert.equal(route.description, "best effort");
  assert.equal(route.sticky, true);
  assert.equal(route.pool, "ag");
  assert.equal(route.method, "cheapest");
});

test("toggleTarget and withoutTarget leave the input untouched", () => {
  const targets = [{ model: "a/b", thinking: "low" as const }];
  const added = toggleTarget(targets, "c/d");
  assert.deepEqual(targets, [{ model: "a/b", thinking: "low" }], "the original array is not mutated");
  assert.deepEqual(added, [{ model: "a/b", thinking: "low" }, { model: "c/d" }]);
  assert.deepEqual(withoutTarget(added, "a/b"), [{ model: "c/d" }]);
});

test("every screen passes the host's own view validation", async () => {
  // A view the contract rejects never reaches the browser, so this is what
  // keeps a new field or action from shipping as a silent blank pane.
  const { validateView } = await import("../../web/core/plugin-contracts/view.ts");
  const draft = draftFromRow(CONTEXT.view.rows[0]!);
  const screens: RouterWebScreen[] = [
    routerWebStart(),
    { kind: "list", notice: "Saved router/auto.", problem: "something" },
    { kind: "form", draft },
    { kind: "form", draft: newDraft(CONTEXT.view, "global") },
    { kind: "form", draft, problem: "A route needs at least one model." },
    { kind: "targets", draft },
    { kind: "delete", draft },
  ];
  for (const screen of screens) {
    const result = validateView(routerWebView(screen, CONTEXT));
    assert.equal(result.ok, true, `${screen.kind}: ${result.ok ? "" : result.error}`);
  }
});

test("a large catalogue still produces a valid view", async () => {
  const { validateView } = await import("../../web/core/plugin-contracts/view.ts");
  const models = Array.from({ length: VIEW_MAX_ROWS + 20 }, (_, index) => `p/m${index}`);
  const draft = { ...draftFromRow(CONTEXT.view.rows[0]!), targets: [{ model: models[0]! }, { model: models.at(-1)! }] };
  const result = validateView(routerWebView({ kind: "targets", draft }, { ...CONTEXT, models }));
  assert.equal(result.ok, true, result.ok ? "" : result.error);
});
