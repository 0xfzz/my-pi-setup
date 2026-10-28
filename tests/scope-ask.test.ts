import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ScopeAskPopup, type ScopeAnswer } from "../lib/ui/scope-ask.ts";
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

test("the dialog shows the target, the reason and the literal glob it would save", () => {
  const { component } = popup();
  const text = plain(component.render(72));
  assert.match(text, /read {2}\.\.\/shared\/config\.yaml/);
  assert.match(text, /outside the workspace/);
  assert.match(text, /Allow once/);
  assert.match(text, /Allow \/home\/u\/shared \(read-only · session\)/);
  assert.match(text, /saves \/home\/u\/shared\/\*/);
  assert.match(text, /Deny/);
  assert.match(text, /Edit a rule/);
  assert.match(text, /Esc deny/, "Escape must be documented as a denial, not a close");
});

test("a write request is labelled as a write and offers read-write access", () => {
  const { component } = popup({ tool: "write", write: true, suggestion: suggestion({ access: "rw" }) });
  const text = plain(component.render(72));
  assert.match(text, /^.*write {2}\.\.\/shared\/config\.yaml/m);
  assert.match(text, /read-write/);
});

test("an exact-file suggestion never widens to a directory", () => {
  const { component } = popup({
    suggestion: suggestion({ path: "/home/u/.bashrc", glob: "/home/u/.bashrc", exact: true }),
  });
  const text = plain(component.render(72));
  assert.match(text, /Allow only this file/);
  assert.doesNotMatch(text, /Allow \/home\/u \(/);
});

test("digits choose directly; Escape denies; arrows and Enter select", () => {
  const once = popup();
  once.component.handleInput("1");
  assert.deepEqual(once.answers, [{ kind: "once" }]);

  const allow = popup();
  allow.component.handleInput("2");
  assert.equal(allow.answers[0]?.kind, "allow");
  assert.equal(allow.answers[0]?.kind === "allow" ? allow.answers[0].grant.path : undefined, "/home/u/shared");

  const deny = popup();
  deny.component.handleInput("3");
  assert.deepEqual(deny.answers, [{ kind: "deny" }]);

  const escape = popup();
  escape.component.handleInput("\x1b");
  assert.deepEqual(escape.answers, [{ kind: "deny" }], "Esc denies; it never approves");

  const arrows = popup();
  arrows.component.handleInput("\x1b[B");
  arrows.component.handleInput("\r");
  assert.equal(arrows.answers[0]?.kind, "allow", "down once selects option 2");
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
      assert.match(plain(lines), /Allow once/);
    }
  }
});

test("queued calls are visible while the user decides", () => {
  const { component } = popup({ queued: 2 });
  assert.match(plain(component.render(72)), /2 more waiting/);
});
