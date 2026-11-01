import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { PLAIN_THEME, type PopupTheme } from "../lib/popup/frame.ts";
import { routerRows, type RouterAction, type RouterPopupResult, type RouterSettingsView } from "../lib/provider/router-settings.ts";
import type { SourcedRoute } from "../lib/provider/router-config.ts";
import { RouterSettingsPopup } from "../lib/ui/router-settings.ts";

const route = (name: string, targets: string[], extra: Partial<SourcedRoute["route"]> = {}, source: SourcedRoute["source"] = "project"): SourcedRoute => ({
  route: { name, targets: targets.map((model) => ({ model })), ...extra },
  source,
});

const baseRows = () => [
  route("auto", ["antigravity/gemini-3-pro", "openai/gpt-6"]),
  route("cheap", ["antigravity/gemini-3-flash"], { method: "cheapest", when: "quota" }, "global"),
];

function view(sourced: SourcedRoute[], extras: Partial<RouterSettingsView> = {}): RouterSettingsView {
  return {
    cwd: "/work",
    provider: "router",
    sources: ["/work/.pi/account-router.json", "/home/u/.pi/agent/account-router.json"],
    rows: routerRows(sourced, "router", ["ag"]),
    shadowed: [],
    pools: ["ag"],
    errors: [],
    ...extras,
  };
}

function harness(options: { sourced?: SourcedRoute[]; extras?: Partial<RouterSettingsView>; fail?: boolean } = {}) {
  const current = view(options.sourced ?? baseRows(), options.extras);
  const actions: RouterAction[] = [];
  const results: RouterPopupResult[] = [];
  let closed = 0;
  const component = new RouterSettingsPopup({
    view: () => current,
    apply: (action) => {
      actions.push(action);
      if (options.fail) throw new Error("no write permission");
      return "saved";
    },
    theme: PLAIN_THEME,
    terminalRows: () => 40,
    onDone: (result) => {
      results.push(result);
      closed++;
    },
  });
  component.focused = true;
  return {
    component, actions, results,
    get closed() { return closed; },
  };
}

const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
const down = "\x1b[B";
const enter = "\r";
const escape = "\x1b";
/** End, then kill to start: clears a field whose cursor may sit before its text. */
const clear = (component: RouterSettingsPopup) => {
  component.handleInput("\x05");
  component.handleInput("\x15");
};

const type = (component: RouterSettingsPopup, text: string) => {
  for (const char of text) component.handleInput(char);
};

/** Open the route at `index` from the list. */
const openRoute = (h: ReturnType<typeof harness>, index = 0) => {
  for (let i = 0; i < index; i++) h.component.handleInput(down);
  h.component.handleInput(enter);
};

// ── List ─────────────────────────────────────────────────────────────────────

test("the screen shows every route with its policy, chain, source and the add row", () => {
  const { component } = harness();
  const text = plain(component.render(90));
  assert.match(text, /Router routes/);
  assert.match(text, /ROUTES/);
  assert.match(text, /router\/auto {2}priority · every turn {2}2 models · project/);
  assert.match(text, /antigravity\/gemini-3-pro → openai\/gpt-6/);
  assert.match(text, /router\/cheap {2}cheapest · on quota {2}1 model · global/);
  assert.match(text, /\+ add a route…/);
  assert.match(text, /POOLS/);
  assert.match(text, /a add/, "the hint names the add key");
  assert.match(text, /Esc close/);
  assert.match(text, /\.pi\/account-router\.json/, "the config file that will be written is visible");
});

test("a route issue is shown on its own row instead of only failing at request time", () => {
  const { component } = harness({ sourced: [route("auto", ["a/one"], { pool: "ghost" })] });
  const text = plain(component.render(90));
  assert.match(text, /⚠ route pool "ghost" is not configured/);
});

test("shadowed global routes are explained, because deleting the override restores them", () => {
  const { component } = harness({
    extras: { shadowed: routerRows([route("cheap", ["a/one"], {}, "global")], "router", ["ag"]) },
  });
  const text = plain(component.render(90));
  assert.match(text, /SHADOWED BY THE PROJECT/);
  assert.match(text, /router\/cheap — deleting the project copy restores this one/);
});

// ── Route menu ───────────────────────────────────────────────────────────────

test("Enter opens the route menu, where every edit names its effect", () => {
  const h = harness();
  openRoute(h);
  const text = plain(h.component.render(90));
  assert.match(text, /router\/auto {2}priority · every turn/);
  assert.match(text, /Add models…/);
  assert.match(text, /Edit chain…/);
  assert.match(text, /Method: priority/);
  assert.match(text, /When: every turn/);
  assert.match(text, /Rename…/);
  assert.match(text, /Delete this route/);
});

test("Add models leaves the popup with the route and the file to write", () => {
  const h = harness();
  openRoute(h);
  h.component.handleInput("1");
  assert.equal(h.closed, 1);
  const result = h.results[0];
  assert.equal(result?.kind, "pick-models");
  if (result?.kind !== "pick-models") return;
  assert.deepEqual(result.draft.route.targets.map((target) => target.model), ["antigravity/gemini-3-pro", "openai/gpt-6"]);
  assert.equal(result.draft.route.name, "auto");
  assert.equal(result.draft.file, "project");
});

test("a global route is rewritten in the global file, not copied into the project", () => {
  const h = harness();
  openRoute(h, 1);
  h.component.handleInput("1");
  const result = h.results[0];
  assert.equal(result?.kind, "pick-models");
  if (result?.kind !== "pick-models") return;
  assert.equal(result.draft.file, "global");
});

test("m and w walk the method and the trigger without opening a menu", () => {
  const viaKey = harness();
  openRoute(viaKey);
  viaKey.component.handleInput("m");
  assert.equal(viaKey.actions.length, 1);
  assert.equal(viaKey.actions[0]!.kind, "save");
  assert.equal((viaKey.actions[0] as { route: { method?: string } }).route.method, "round-robin", "priority cycles to round-robin");

  const trigger = harness();
  openRoute(trigger);
  trigger.component.handleInput("w");
  assert.equal((trigger.actions[0] as { route: { when?: string } }).route.when, "failure");
});

test("the method menu names all four methods with what they do, and applies one", () => {
  const h = harness();
  openRoute(h, 1); // every turn; cheapest · on quota
  h.component.handleInput("3");
  const text = plain(h.component.render(90));
  assert.match(text, /How should the candidates be ordered\?/);
  assert.match(text, /priority/);
  assert.match(text, /round-robin/);
  assert.match(text, /cheapest/);
  assert.match(text, /last-good/);
  assert.match(text, /ascending catalog price/);
  h.component.handleInput("2");
  const saved = h.actions[0] as { route: { method?: string; when?: string } };
  assert.equal(saved.route.method, "round-robin");
  assert.equal(saved.route.when, "quota", "choosing a method keeps the trigger");
});

test("the trigger menu names all four triggers with their conditions", () => {
  const h = harness();
  openRoute(h);
  h.component.handleInput("4");
  const text = plain(h.component.render(90));
  assert.match(text, /When should the chain be re-decided\?/);
  assert.match(text, /every turn/);
  assert.match(text, /on failure/);
  assert.match(text, /on quota/);
  assert.match(text, /only a retry after quota\/429 moves on/);
});

test("the chain menu lists targets in order and can promote one", () => {
  const h = harness();
  openRoute(h);
  h.component.handleInput("2");
  const text = plain(h.component.render(90));
  assert.match(text, /Chain of router\/auto/);
  assert.match(text, /1\. antigravity\/gemini-3-pro {2}primary/);
  assert.match(text, /2\. openai\/gpt-6/);

  h.component.handleInput(enter); // first target
  h.component.handleInput("1");   // move down
  const saved = h.actions[0] as { route: { targets: Array<{ model: string }> } };
  assert.deepEqual(saved.route.targets.map((target) => target.model), ["openai/gpt-6", "antigravity/gemini-3-pro"]);
  assert.match(plain(h.component.render(90)), /Chain of router\/auto/, "the chain menu stays open for the next edit");
});

test("a target can be pointed at a pool and given a thinking level", () => {
  const h = harness();
  openRoute(h);
  h.component.handleInput("2");
  h.component.handleInput(enter);
  h.component.handleInput("2"); // Thinking
  assert.match(plain(h.component.render(90)), /provider default/);
  h.component.handleInput("4"); // "medium" in [default, off, low, medium, high]
  const thinking = h.actions.at(-1) as { route: { targets: Array<{ thinking?: string }> } };
  assert.equal(thinking.route.targets[0]!.thinking, "medium");

  h.component.handleInput("3"); // Pool
  h.component.handleInput("2"); // "ag"
  const pooled = h.actions.at(-1) as { route: { targets: Array<{ pool?: string }> } };
  assert.equal(pooled.route.targets[0]!.pool, "ag");
});

test("removing the last target is refused with a reason instead of saving an unusable route", () => {
  const h = harness({ sourced: [route("solo", ["a/one"])] });
  openRoute(h);
  h.component.handleInput("2");
  h.component.handleInput(enter);
  h.component.handleInput("3"); // Remove in a one-target menu
  assert.deepEqual(h.actions, [], "nothing is written");
  assert.match(plain(h.component.render(90)), /A route needs at least one target/);
});

// ── Creating ─────────────────────────────────────────────────────────────────

test("a creates a route: a free name, then where to save it, then the picker", () => {
  const h = harness();
  h.component.handleInput("a");
  assert.match(plain(h.component.render(90)), /Name: /);
  assert.match(plain(h.component.render(90)), /route-1/, "a free name is suggested");
  h.component.handleInput(enter);
  const where = plain(h.component.render(90));
  assert.match(where, /Save router\/route-1 where\?/);
  assert.match(where, /This workspace/);
  assert.match(where, /Every workspace/);
  h.component.handleInput("1");
  assert.equal(h.closed, 1);
  const result = h.results[0];
  assert.equal(result?.kind, "pick-models");
  if (result?.kind !== "pick-models") return;
  assert.equal(result.draft.route.name, "route-1");
  assert.equal(result.draft.file, "project");
  assert.deepEqual(result.draft.route.targets, [], "no route is written before a model is chosen");
});

test("saving a new route globally is one choice away", () => {
  const h = harness();
  h.component.handleInput("a");
  h.component.handleInput(enter);
  h.component.handleInput("2");
  const result = h.results[0];
  assert.equal(result?.kind, "pick-models");
  if (result?.kind !== "pick-models") return;
  assert.equal(result.draft.file, "global");
});

test("a duplicate or invalid name is refused in the field, before anything is saved", () => {
  const h = harness();
  h.component.handleInput("a");
  clear(h.component);
  type(h.component, "auto");
  h.component.handleInput(enter);
  assert.match(plain(h.component.render(90)), /"auto" already exists/);
  assert.equal(h.closed, 0);
  assert.deepEqual(h.actions, []);

  clear(h.component);
  type(h.component, "bad name");
  h.component.handleInput(enter);
  assert.match(plain(h.component.render(90)), /letters, digits, dot, dash or underscore/);
});

// ── Renaming and deleting ────────────────────────────────────────────────────

test("renaming keeps the models and the policy and reports the old name", () => {
  const h = harness();
  openRoute(h);
  h.component.handleInput("6");
  clear(h.component);
  type(h.component, "fast");
  h.component.handleInput(enter);
  assert.equal(h.actions.length, 1);
  const action = h.actions[0]!;
  assert.equal(action.kind, "rename");
  if (action.kind !== "rename") return;
  assert.equal(action.from, "auto");
  assert.equal(action.route.name, "fast");
  assert.deepEqual(action.route.targets.map((target) => target.model), ["antigravity/gemini-3-pro", "openai/gpt-6"]);
  assert.equal(action.file, "project");
});

test("the rename field refuses a name another route already has", () => {
  const h = harness();
  openRoute(h);
  h.component.handleInput("6");
  clear(h.component);
  type(h.component, "cheap");
  h.component.handleInput(enter);
  assert.match(plain(h.component.render(90)), /"cheap" already exists/);
  assert.deepEqual(h.actions, []);
});

test("deleting asks first and can be abandoned", () => {
  const h = harness();
  openRoute(h);
  h.component.handleInput("7");
  const text = plain(h.component.render(90));
  assert.match(text, /Delete router\/auto\?/);
  assert.match(text, /Delete router\/auto/);
  assert.match(text, /Keep it/);
  h.component.handleInput(escape);
  assert.equal(h.closed, 0, "going back does not delete");
  assert.deepEqual(h.actions, []);
  assert.match(plain(h.component.render(90)), /Delete this route/, "it returns to the route menu");
  h.component.handleInput(escape);
  assert.match(plain(h.component.render(90)), /ROUTES/, "one more Escape returns to the list");
});

test("confirming the delete reports the name and the file", () => {
  const h = harness();
  openRoute(h, 1);
  h.component.handleInput("7");
  h.component.handleInput("1");
  assert.deepEqual(h.actions, [{ kind: "delete", name: "cheap", file: "global" }]);
});

// ── Failure and dismissal ────────────────────────────────────────────────────

test("Escape on the list closes the editor and answers with nothing", () => {
  const h = harness();
  h.component.handleInput(escape);
  assert.equal(h.closed, 1);
  assert.equal(h.results[0], undefined, "a cancelled editor is not a selection");
});

test("a failed write is reported in the screen and the editor stays usable", () => {
  const h = harness({ fail: true });
  openRoute(h);
  h.component.handleInput("5"); // toggle stickiness -> apply throws
  const text = plain(h.component.render(90));
  assert.match(text, /no write permission/);
  assert.equal(h.closed, 0);
  assert.match(plain(h.component.render(90)), /Method:/, "the menu is still there after the failure");
});

test("the editor never exceeds the terminal width", () => {
  for (const width of [30, 44, 60, 120]) {
    const { component } = harness();
    for (const line of component.render(width)) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(stripTerminalSequences(line))}`);
    }
  }
});

test("a config error is shown without hiding the routes", () => {
  const { component } = harness({ extras: { errors: ["/work/.pi/account-router.json: unexpected token"] } });
  const text = plain(component.render(90));
  assert.match(text, /unexpected token/);
  assert.match(text, /router\/auto/);
});

// ── Real theme ───────────────────────────────────────────────────────────────

test("the route list renders with Pi's own theme, where an unknown token throws", () => {
  // Same regression as the provider editor: a bad token name compiled because
  // PopupTheme accepted `string`, and only threw on the error path.
  initTheme("dark");
  const realTheme = (globalThis as unknown as Record<symbol, PopupTheme>)[
    Symbol.for("@earendil-works/pi-coding-agent:theme")
  ]!;
  assert.ok(realTheme, "initTheme installs the theme Pi hands to extensions");

  const component = new RouterSettingsPopup({
    view: () => view(baseRows(), { errors: ["account-router.json is not strict JSON."] }),
    apply: () => "saved",
    theme: realTheme,
    terminalRows: () => 40,
    onDone: () => {},
  });
  component.focused = true;
  assert.match(plain(component.render(90)), /account-router\.json is not strict JSON\./);
});
