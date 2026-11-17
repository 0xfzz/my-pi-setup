import assert from "node:assert/strict";
import test from "node:test";
import { historyEntryKey, mergeHistoryEntries, type HistoryEntryLike } from "./history-pages.ts";

const entry = (text: string): HistoryEntryLike => ({
  role: "user",
  blocks: [{ kind: "text", text }],
});

test("history entry keys ignore object identity and compare rendered content", () => {
  assert.equal(historyEntryKey(entry("hello")), historyEntryKey(entry("hello")));
  assert.notEqual(historyEntryKey(entry("hello")), historyEntryKey(entry("world")));
});

test("merging a disk page with a live append keeps one copy of the shared row", () => {
  const merged = mergeHistoryEntries([entry("one"), entry("two")], [entry("two"), entry("three")], "append");
  assert.deepEqual(merged, [entry("one"), entry("two"), entry("three")]);
});

test("merging an older page prepends only entries not already loaded", () => {
  const merged = mergeHistoryEntries([entry("three")], [entry("one"), entry("two"), entry("three")], "prepend");
  assert.deepEqual(merged, [entry("one"), entry("two"), entry("three")]);
});

test("repeated identical prompts survive a page merge by occurrence", () => {
  const merged = mergeHistoryEntries([entry("hi")], [entry("hi"), entry("hi")], "append");
  assert.deepEqual(merged, [entry("hi"), entry("hi")]);
});

test("status-only live markers are distinct from plain replies with the same text", () => {
  const plain = entry("hi");
  const aborted: HistoryEntryLike = { ...entry("hi"), aborted: true };
  assert.notEqual(historyEntryKey(plain), historyEntryKey(aborted));
});
