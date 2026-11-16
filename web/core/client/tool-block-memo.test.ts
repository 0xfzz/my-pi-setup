import test from "node:test";
import assert from "node:assert/strict";
import { assistantBlocksPropsEqual } from "./tool-block-memo.ts";

const call = (id: string) => ({ kind: "toolCall" as const, toolCallId: id, toolName: "bash", rawInput: "{}" });
const text = { kind: "text" as const, text: "hello" };

const props = (
  blocks: readonly unknown[],
  toolStatus: Record<string, unknown> = {},
  toolResults: Record<string, unknown> = {},
  live?: boolean,
) => ({ blocks: blocks as never, toolStatus, toolResults, live });

test("a new status map for an unrelated tool does not redraw the message", () => {
  const blocks = [call("a")];
  const previous = props(blocks, { a: "running" });
  const next = props(blocks, { a: "running", b: "running" });
  assert.equal(assistantBlocksPropsEqual(previous, next), true);
});

test("a new result map for an unrelated tool does not redraw the message", () => {
  const blocks = [call("a")];
  const resultForA = { text: "done" };
  const previous = props(blocks, {}, { a: resultForA });
  const next = props(blocks, {}, { a: resultForA, b: { text: "other" } });
  assert.equal(assistantBlocksPropsEqual(previous, next), true);
});

test("a text-only message ignores both tool maps entirely", () => {
  const blocks = [text];
  assert.equal(assistantBlocksPropsEqual(props(blocks), props(blocks, { a: "running" }, { a: { text: "x" } })), true);
});

test("a change to this message's status redraws it", () => {
  const blocks = [call("a")];
  assert.equal(assistantBlocksPropsEqual(props(blocks, { a: "running" }), props(blocks, { a: "done" })), false);
});

test("a change to this message's result redraws it", () => {
  const blocks = [call("a")];
  assert.equal(assistantBlocksPropsEqual(props(blocks, {}, { a: { text: "old" } }), props(blocks, {}, { a: { text: "new" } })), false);
});

test("new block content redraws the message even when the tool state is unchanged", () => {
  const status = { a: "running" };
  const previous = props([text], status);
  const next = props([{ kind: "text" as const, text: "hello world" }], status);
  assert.equal(assistantBlocksPropsEqual(previous, next), false);
});

test("a block array rebuilt with identical entries is treated as unchanged", () => {
  const block = call("a");
  assert.equal(assistantBlocksPropsEqual(props([block]), props([block])), true);
});

test("a different number of blocks redraws the message", () => {
  const block = call("a");
  assert.equal(assistantBlocksPropsEqual(props([block]), props([block, text])), false);
});

test("the live flag changing redraws the message, because thinking expands while streaming", () => {
  const blocks = [text];
  assert.equal(assistantBlocksPropsEqual(props(blocks, {}, {}, false), props(blocks, {}, {}, true)), false);
});

test("a tool call without an id is never matched to a map entry", () => {
  const block = { kind: "toolCall" as const, toolCallId: "", toolName: "bash", rawInput: "" };
  assert.equal(assistantBlocksPropsEqual(props([block]), props([block], { "": "running" })), true);
});
