import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { PLAIN_THEME } from "../lib/popup.ts";
import { settingsRows, type SettingsAction } from "../lib/scope/settings.ts";
import type { ScopeState } from "../lib/scope/types.ts";
import { ScopeSettingsPopup, type ScopeSettingsView } from "../lib/ui/scope-settings.ts";

const cwd = "/work";

const baseState = (): ScopeState => ({
  roots: [
    { path: cwd, access: "rw", source: "session" },
    { path: "/srv/data", access: "ro", source: "project" },
  ],
  rules: [{ action: "read", resource: "/secrets/*", effect: "deny", source: "project" }],
  defaults: { external: "ask", readExternal: "allow" },
});

function harness(options: { state?: ScopeState; fail?: boolean; sources?: string[] } = {}) {
  const state = options.state ?? baseState();
  const view: ScopeSettingsView = { cwd, sources: options.sources ?? ["/work/.pi/scope.json"], rows: settingsRows(state, cwd) };
  const actions: SettingsAction[] = [];
  const notices: string[] = [];
  let closed = 0;
  const component = new ScopeSettingsPopup({
    view: () => view,
    apply: action => {
      actions.push(action);
      if (options.fail) throw new Error("no write permission");
      return "applied";
    },
    theme: PLAIN_THEME,
    terminalRows: () => 40,
    onDone: () => { closed++; },
  });
  component.focused = true;
  return { component, actions, notices, get closed() { return closed; } };
}

const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
const down = "\x1b[B";
const enter = "\r";
const escape = "\x1b";

const type = (component: ScopeSettingsPopup, text: string) => {
  for (const char of text) component.handleInput(char);
};

/** Move to the row at `index` in the settings list and open its menu. */
const openRow = (h: ReturnType<typeof harness>, index: number) => {
  for (let i = 0; i < index; i++) h.component.handleInput(down);
  h.component.handleInput(enter);
};

test("the screen shows every section, the workspace row and the current values", () => {
  const { component } = harness();
  const text = plain(component.render(90));
  assert.match(text, /Scope settings/);
  assert.match(text, /GRANTS/);
  assert.match(text, /workspace {2}read-write · session/);
  assert.match(text, /\/srv\/data {2}read-only · project/);
  assert.match(text, /RULES/);
  assert.match(text, /read {2}\/secrets\/\* {2}deny {2}project/);
  assert.match(text, /DEFAULTS/);
  assert.match(text, /write outside workspace {2}ask/);
  assert.match(text, /read outside workspace {2}allow/);
  assert.match(text, /YOLO/);
  assert.match(text, /yolo {2}off/);
  assert.match(text, /a add/, "the hint names the add key");
  assert.match(text, /Esc close/);
});

test("the workspace row offers an access change but no removal", () => {
  const h = harness();
  openRow(h, 0);
  const text = plain(h.component.render(90));
  assert.match(text, /Change: workspace/);
  assert.match(text, /Make it read-only/);
  assert.doesNotMatch(text, /Remove this grant/, "the workspace itself is never removable");
});

test("Enter on a root changes its access through the same action the command uses", () => {
  const h = harness();
  openRow(h, 0);
  h.component.handleInput(enter);
  assert.deepEqual(h.actions, [{ kind: "grant-access", root: { path: cwd, access: "rw", source: "session" }, access: "ro" }]);
  assert.match(plain(h.component.render(90)), /applied/, "the confirmation stays visible");
});

test("a config root can be made read-write or removed, and nothing else", () => {
  const h = harness();
  openRow(h, 1);
  assert.match(plain(h.component.render(90)), /Make it read-write/);
  assert.match(plain(h.component.render(90)), /Remove this grant/);
  h.component.handleInput(enter);
  assert.deepEqual(h.actions, [{ kind: "grant-access", root: { path: "/srv/data", access: "ro", source: "project" }, access: "rw" }]);
});

test("a session rule can be promoted to the workspace; a project rule cannot", () => {
  const sessionRule = { action: "read", resource: "/tmp/*", effect: "deny" as const, source: "session" as const };
  const withSession = harness({ state: { ...baseState(), rules: [sessionRule] } });
  openRow(withSession, 2);
  assert.match(plain(withSession.component.render(90)), /Keep for this workspace/);

  const withProject = harness();
  openRow(withProject, 2);
  assert.doesNotMatch(plain(withProject.component.render(90)), /Keep for this workspace/);
});

test("a rule row changes its effect, not its text", () => {
  const h = harness();
  openRow(h, 2);
  h.component.handleInput(enter);
  assert.deepEqual(h.actions, [
    { kind: "rule-effect", rule: { action: "read", resource: "/secrets/*", effect: "deny", source: "project" }, effect: "allow" },
  ]);
});

test("a default row sets that default in one keystroke", () => {
  const h = harness();
  openRow(h, 3);
  // allow, ask (current), deny
  h.component.handleInput(down);
  h.component.handleInput(down);
  h.component.handleInput(enter);
  assert.deepEqual(h.actions, [{ kind: "default", key: "external", effect: "deny" }]);
});

test("the yolo row arms and disarms with words instead of flags", () => {
  const h = harness();
  openRow(h, 5);
  h.component.handleInput(down);
  h.component.handleInput(enter);
  assert.deepEqual(h.actions, [{ kind: "yolo", strength: "ro" }]);
});

test("a is how a grant is added: path first, then where it is saved", () => {
  const h = harness();
  h.component.handleInput("a");
  h.component.handleInput(enter);
  assert.match(plain(h.component.render(90)), /A path, absolute or relative to the workspace/);
  type(h.component, "/srv/data");
  h.component.handleInput(enter);
  const text = plain(h.component.render(90));
  assert.match(text, /Where should \/srv\/data be saved\?/);
  assert.match(text, /Read-write · this workspace/);
  h.component.handleInput("4");
  assert.deepEqual(h.actions, [{ kind: "add-grant", path: "/srv/data", access: "rw", target: "project" }]);
});

test("a rule is added as text, then a target", () => {
  const h = harness();
  h.component.handleInput("a");
  h.component.handleInput(down);
  h.component.handleInput(enter);
  type(h.component, "bash find * deny");
  h.component.handleInput(enter);
  assert.match(plain(h.component.render(90)), /Where should bash find \* deny be saved\?/);
  h.component.handleInput("1");
  assert.deepEqual(h.actions, [{ kind: "add-rule", text: "bash find * deny", target: "session" }]);
});

test("Escape closes from the list, and backs out one level everywhere else", () => {
  const closed = harness();
  closed.component.handleInput(escape);
  assert.equal(closed.closed, 1, "Esc on the list closes the screen");

  const back = harness();
  openRow(back, 3);
  back.component.handleInput(escape);
  assert.equal(back.closed, 0, "Esc inside a menu is not a close");
  assert.match(plain(back.component.render(90)), /GRANTS/, "it returns to the list");

  const add = harness();
  add.component.handleInput("a");
  add.component.handleInput(enter);
  type(add.component, "/srv/data");
  add.component.handleInput(enter);
  add.component.handleInput(escape);
  assert.equal(add.closed, 0);
  assert.match(plain(add.component.render(90)), /Path: \/srv\/data/, "the path is still there to edit");
});

test("a failed write is reported in the screen instead of closing it", () => {
  const h = harness({ fail: true });
  openRow(h, 0);
  h.component.handleInput(enter);
  const text = plain(h.component.render(90));
  assert.match(text, /no write permission/);
  assert.match(text, /GRANTS/, "the list is still usable after a failure");
  assert.equal(h.closed, 0);
});

test("an empty path or rule is not a change", () => {
  const h = harness();
  h.component.handleInput("a");
  h.component.handleInput(enter);
  h.component.handleInput(enter);
  assert.deepEqual(h.actions, []);
  assert.match(plain(h.component.render(90)), /Path:/, "the field stays open");
});

test("the screen never exceeds a narrow width", () => {
  for (const width of [30, 44, 60]) {
    const { component } = harness();
    for (const line of component.render(width)) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(stripTerminalSequences(line))}`);
    }
  }
});
