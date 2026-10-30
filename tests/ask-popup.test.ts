import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { AskUserPopup, type AskAnswer } from "../lib/ui/ask.ts";
import { PLAIN_THEME } from "../lib/popup.ts";

const text = (lines: string[]) => lines.map(line => stripTerminalSequences(line)).join("\n");

test("ask popup marks the recommended answer without preselecting it", () => {
  let answer: AskAnswer | undefined;
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
  assert.equal(answer?.value, "eu-west", "Enter still selects the highlighted first option");
  assert.equal(answer?.kind, "option");
});

test("ask popup type-your-own submits a non-empty answer", () => {
  let answer: AskAnswer | undefined;
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
  assert.equal(answer?.value, "custom");
  assert.equal(answer?.kind, "text");
});

test("ask popup keeps an empty free-text answer open and Escape cancels", () => {
  let answer: AskAnswer | undefined;
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
  let answer: AskAnswer | undefined;
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
  assert.equal(answer?.value, "option 20");
  assert.equal(answer?.kind, "option");
});

test("ask popup opens directly in free-text mode when no options are supplied", () => {
  let answer: AskAnswer | undefined;
  const popup = new AskUserPopup({
    question: "Explain",
    theme: PLAIN_THEME,
    terminalRows: () => 24,
    onDone: (value) => { answer = value; },
  });
  popup.focused = true;
  for (const char of "hello") popup.handleInput(char);
  popup.handleInput("\r");
  assert.equal(answer?.value, "hello");
  assert.equal(answer?.kind, "text");
});

test("ask popup displays warning on empty submit and keeps popup open", () => {
  const holder: { answer: AskAnswer | undefined } = { answer: undefined };
  let calls = 0;
  const popup = new AskUserPopup({
    question: "Explain",
    theme: PLAIN_THEME,
    terminalRows: () => 24,
    onDone: (value) => { calls++; holder.answer = value; },
  });
  popup.focused = true;
  popup.handleInput("\r");
  assert.equal(calls, 0);
  assert.equal(holder.answer === undefined, true);
  const renderedWithWarning = text(popup.render(60));
  assert.match(renderedWithWarning, /An answer is required/);

  popup.handleInput("ok");
  const renderedTyping = text(popup.render(60));
  assert.doesNotMatch(renderedTyping, /An answer is required/);
  popup.handleInput("\r");
  assert.equal(calls, 1);
  assert.equal(holder.answer?.value, "ok");
  assert.equal(holder.answer?.kind, "text");
});

test("ask popup wraps long options and reveals the active item accurately", () => {
  const longOption1 = "A very long option line that exceeds the width of sixty columns and wraps to multiple lines cleanly";
  const longOption2 = "Another very long option line that also exceeds sixty columns and wraps to multiple lines with indent";
  let answer: AskAnswer | undefined;
  const popup = new AskUserPopup({
    question: "A long question that also exceeds forty columns and wraps onto multiple lines cleanly?",
    context: "Context line 1\nContext line 2",
    options: [longOption1, longOption2],
    theme: PLAIN_THEME,
    terminalRows: () => 20,
    onDone: (value) => { answer = value; },
  });
  const rendered = text(popup.render(60));
  assert.match(rendered, /A very long option/);
  popup.handleInput("\x1b[B");
  popup.handleInput("\r");
  assert.equal(answer?.value, longOption2);
  assert.equal(answer?.kind, "option");
});
