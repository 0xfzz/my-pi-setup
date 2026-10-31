import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ScopeAskPopup, scopeChoices, type ScopeAnswer } from "../lib/ui/scope-ask.ts";
import { PLAIN_THEME } from "../lib/popup.ts";
import type { ScopeSuggestion } from "../lib/scope/types.ts";

const suggestion = (overrides: Partial<ScopeSuggestion> = {}): ScopeSuggestion => ({
  path: "/home/u/shared",
  access: "ro",
  glob: "/home/u/shared/*",
  exact: false,
  ...overrides,
});

function popup(overrides: Partial<ConstructorParameters<typeof ScopeAskPopup>[0]> = {}) {
  const answers: ScopeAnswer[] = [];
  const component = new ScopeAskPopup({
    tool: "read",
    display: "../shared/config.yaml",
    absolute: "/home/u/shared/config.yaml",
    write: false,
    reason: "outside the workspace: /home/u/shared/config.yaml",
    suggestion: suggestion(),
    theme: PLAIN_THEME,
    terminalRows: () => 30,
    onDone: answer => answers.push(answer),
    ...overrides,
  });
  // Pi focuses an overlay when it opens it; the Input inside only accepts keys
  // while its owner reports focus.
  component.focused = true;
  return { component, answers };
}

const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

test("the dialog offers the four grants and prints what each one stores", () => {
  const { component } = popup();
  const text = plain(component.render(72));
  assert.match(text, /read {2}\.\.\/shared\/config\.yaml/);
  assert.match(text, /outside the workspace/);
  assert.match(text, /Allow \.\.\/shared\/config\.yaml for once/);
  assert.match(text, /Always allow \.\.\/shared\/config\.yaml for this workspace/);
  assert.match(text, /saves \/home\/u\/shared\/config\.yaml in \.pi\/scope\.json/);
  assert.match(text, /Allow all \/home\/u\/shared\/\* for once/);
  assert.match(text, /session only, not saved/);
  assert.match(text, /Always allow \/home\/u\/shared\/\* for this workspace/);
  assert.match(text, /saves \/home\/u\/shared\/\* in \.pi\/scope\.json/);
  assert.match(text, /Deny with reason/);
  assert.match(text, /Esc deny/, "Escape must be documented as a denial, not a close");
});

test("the rows are ordered once, workspace, folder, folder-for-workspace, deny, deny-with-reason", () => {
  const labels = scopeChoices({
    tool: "read",
    display: "../shared/config.yaml",
    absolute: "/home/u/shared/config.yaml",
    write: false,
    reason: "outside the workspace",
    suggestion: suggestion(),
  }).map(choice => choice.label);
  assert.deepEqual(labels, [
    "Allow ../shared/config.yaml for once",
    "Always allow ../shared/config.yaml for this workspace",
    "Allow all /home/u/shared/* for once",
    "Always allow /home/u/shared/* for this workspace",
    "Deny with reason",
    "Deny",
  ]);
});

test("a write request is labelled as a write and its grants carry read-write", () => {
  const { component, answers } = popup({ tool: "write", write: true, suggestion: suggestion({ access: "rw" }) });
  const text = plain(component.render(72));
  assert.match(text, /^.*write {2}\.\.\/shared\/config\.yaml/m);
  component.handleInput("3");
  assert.equal(answers[0]?.kind, "allow");
  assert.equal(answers[0]?.kind === "allow" ? answers[0].grant.access : undefined, "rw");
});

test("an exact-file suggestion never widens to a directory", () => {
  const { component } = popup({
    display: "/home/u/.bashrc",
    absolute: "/home/u/.bashrc",
    suggestion: suggestion({ path: "/home/u/.bashrc", glob: "/home/u/.bashrc", exact: true }),
  });
  const text = plain(component.render(72));
  assert.match(text, /Allow \/home\/u\/\.bashrc for once/);
  assert.match(text, /Always allow \/home\/u\/\.bashrc for this workspace/);
  assert.doesNotMatch(text, /Allow all/, "the folder that contains the workspace is never offered");
});

test("digits choose directly; Escape denies; arrows and Enter select", () => {
  const once = popup();
  once.component.handleInput("1");
  assert.deepEqual(once.answers, [{ kind: "once" }]);

  const exact = popup();
  exact.component.handleInput("2");
  assert.equal(exact.answers[0]?.kind, "allow");
  assert.equal(exact.answers[0]?.kind === "allow" ? exact.answers[0].persist : undefined, "workspace");
  assert.equal(exact.answers[0]?.kind === "allow" ? exact.answers[0].grant.path : undefined, "/home/u/shared/config.yaml");
  assert.equal(exact.answers[0]?.kind === "allow" ? exact.answers[0].grant.exact : undefined, true);

  const folder = popup();
  folder.component.handleInput("3");
  assert.equal(folder.answers[0]?.kind, "allow");
  assert.equal(folder.answers[0]?.kind === "allow" ? folder.answers[0].persist : undefined, undefined);
  assert.equal(folder.answers[0]?.kind === "allow" ? folder.answers[0].grant.path : undefined, "/home/u/shared");

  const folderPersisted = popup();
  folderPersisted.component.handleInput("4");
  assert.equal(folderPersisted.answers[0]?.kind, "allow");
  assert.equal(folderPersisted.answers[0]?.kind === "allow" ? folderPersisted.answers[0].persist : undefined, "workspace");
  assert.equal(folderPersisted.answers[0]?.kind === "allow" ? folderPersisted.answers[0].grant.path : undefined, "/home/u/shared");

  const deny = popup();
  deny.component.handleInput("6");
  assert.deepEqual(deny.answers, [{ kind: "deny" }]);

  const escape = popup();
  escape.component.handleInput("\x1b");
  assert.deepEqual(escape.answers, [{ kind: "deny" }], "Esc denies; it never approves");

  const arrows = popup();
  arrows.component.handleInput("\x1b[B");
  arrows.component.handleInput("\r");
  assert.equal(arrows.answers[0]?.kind, "allow", "down once selects option 2");
});

test("an opaque command offers the narrowest rule, never a blanket grant", () => {
  const { component, answers } = popup({
    tool: "bash",
    display: "(command cannot be analysed)",
    write: true,
    reason: "find -exec runs code the gate cannot read",
    suggestion: suggestion({ path: "/work", glob: "/work", exact: true }),
    commandRule: { action: "bash", resource: "find *" },
  });
  const text = plain(component.render(100));
  assert.match(text, /Allow find \* commands for this session/);
  assert.match(text, /saves bash find \*/);
  assert.doesNotMatch(text, /for once/, "a command question is not a file grant");
  assert.doesNotMatch(text, /for this workspace/);
  component.handleInput("2");
  assert.deepEqual(answers, [{ kind: "rule", text: "bash find * allow" }], "option 2 saves the rule it printed, not a wildcard");
});

test("a denial can carry instructions for the model", () => {
  const { component, answers } = popup();
  component.handleInput("5");
  assert.match(plain(component.render(72)), /Tell the model what to do instead/);

  for (const char of "read ok.yaml instead") component.handleInput(char);
  component.handleInput("\r");
  assert.deepEqual(answers, [{ kind: "deny", feedback: "read ok.yaml instead" }]);
});

test("an empty note is a plain denial, and Escape returns to the options", () => {
  const empty = popup();
  empty.component.handleInput("5");
  empty.component.handleInput("\r");
  assert.deepEqual(empty.answers, [{ kind: "deny" }], "Enter on an empty note must not invent guidance");

  const back = popup();
  back.component.handleInput("5");
  back.component.handleInput("\x1b");
  assert.deepEqual(back.answers, [], "Escape inside the note backs out of the stage, it does not answer");
  assert.match(plain(back.component.render(72)), /for once/, "the question is still open");
  back.component.handleInput("6");
  assert.deepEqual(back.answers, [{ kind: "deny" }]);
});

test("e opens a prefilled rule editor and Enter returns the typed rule", () => {
  const { component, answers } = popup();
  component.handleInput("e");
  assert.match(plain(component.render(72)), /Format: <tool\|\*> <glob> <allow\|ask\|deny>/);

  component.handleInput("\r");
  assert.equal(answers[0]?.kind, "rule");
  assert.equal(answers[0]?.kind === "rule" ? answers[0].text : undefined, "read /home/u/shared/* allow");
});

test("an empty rule returns to the option list instead of answering", () => {
  const { component, answers } = popup();
  component.handleInput("e");
  for (let i = 0; i < 40; i++) component.handleInput("\x7f");
  component.handleInput("\r");
  assert.deepEqual(answers, []);
  assert.doesNotMatch(plain(component.render(72)), /Format:/);
});

test("the dialog never exceeds a narrow width and stays readable", () => {
  for (const width of [28, 40, 60]) {
    for (const editing of [false, true]) {
      const { component } = popup();
      if (editing) component.handleInput("e");
      const lines = component.render(width);
      for (const line of lines) {
        assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(stripTerminalSequences(line))}`);
      }
      assert.match(plain(lines), /1 {2}Allow/, "the first option stays readable at every width");
    }
  }
});

test("queued calls are visible while the user decides", () => {
  const { component } = popup({ queued: 2 });
  assert.match(plain(component.render(72)), /2 more waiting/);
});
