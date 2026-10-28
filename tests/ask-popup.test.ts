import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { AskUserPopup } from "../lib/ui/ask.ts";
import { PLAIN_THEME } from "../lib/popup.ts";

const text = (lines: string[]) => lines.map(line => stripTerminalSequences(line)).join("\n");

test("ask popup marks the recommended answer without preselecting it", () => {
  let answer: string | undefined;
  let calls = 0;
  const popup = new AskUserPopup({
    question: "Which region?",
    context: "Deployment target",
    options: ["eu-west", "us-east"],
    recommended: 2,
    theme: PLAIN_THEME,
    terminalRows: () => 24,
    onDone: (value) => { calls++; answer = value; },
  });
  const rendered = text(popup.render(70));
  assert.match(rendered, /Which region\?/);
  assert.match(rendered, /Deployment target/);
  assert.match(rendered, /eu-west/);
  assert.match(rendered, /us-east/);
  assert.match(rendered, /\(recommended answer\)/);
  assert.equal(calls, 0);

  popup.handleInput("\r");
  assert.equal(answer, "eu-west", "Enter still selects the highlighted first option");
});

test("ask popup type-your-own submits a non-empty answer", () => {
  let answer: string | undefined;
  const popup = new AskUserPopup({
    question: "Pick",
    options: ["a", "b"],
    theme: PLAIN_THEME,
    terminalRows: () => 24,
    onDone: (value) => { answer = value; },
  });
  popup.focused = true;
  popup.handleInput("\x1b[B");
  popup.handleInput("\x1b[B");
  popup.handleInput("\r");
  for (const char of "custom") popup.handleInput(char);
  popup.handleInput("\r");
  assert.equal(answer, "custom");
});

test("ask popup keeps an empty free-text answer open and Escape cancels", () => {
  let answer: string | undefined;
  let calls = 0;
  const popup = new AskUserPopup({
    question: "Pick",
    options: ["a"],
    theme: PLAIN_THEME,
    terminalRows: () => 24,
    onDone: (value) => { calls++; answer = value; },
  });
  popup.focused = true;
  popup.handleInput("\x1b[B");
  popup.handleInput("\r");
  popup.handleInput("\r");
  assert.equal(calls, 0);
  assert.equal(answer, undefined);

  popup.handleInput("\x1b");
  assert.equal(calls, 1);
  assert.equal(answer, undefined);
});

test("ask popup scrolls a long option list and stays inside the terminal", () => {
  const options = Array.from({ length: 30 }, (_, index) => `option ${index}`);
  let answer: string | undefined;
  const popup = new AskUserPopup({
    question: "Many choices",
    options,
    theme: PLAIN_THEME,
    terminalRows: () => 12,
    onDone: (value) => { answer = value; },
  });
  for (let i = 0; i < 20; i++) popup.handleInput("\x1b[B");
  const rendered = text(popup.render(60));
  assert.ok((rendered.match(/\n/g) ?? []).length <= 12);
  assert.match(rendered, /option 20/);
  assert.doesNotMatch(rendered, /option 0\b/);
  popup.handleInput("\r");
  assert.equal(answer, "option 20");
});

test("ask popup opens directly in free-text mode when no options are supplied", () => {
  let answer: string | undefined;
  const popup = new AskUserPopup({
    question: "Explain",
    theme: PLAIN_THEME,
    terminalRows: () => 24,
    onDone: (value) => { answer = value; },
  });
  popup.focused = true;
  for (const char of "hello") popup.handleInput(char);
  popup.handleInput("\r");
  assert.equal(answer, "hello");
});
