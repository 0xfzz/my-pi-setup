import test from "node:test";
import assert from "node:assert/strict";
import { createHistoryCache } from "./history-cache.ts";

function fakeFiles(initial: Record<string, string>) {
  const stamps = { ...initial };
  const loads: string[] = [];
  return {
    stamps,
    loads,
    stamp: async (file: string) => stamps[file] ?? "missing",
    load: async (file: string) => {
      loads.push(file);
      return `parsed:${file}@${stamps[file]}`;
    },
  };
}

test("an unchanged file is parsed once and served from the cache", async () => {
  const files = fakeFiles({ "a.jsonl": "1:100" });
  const read = createHistoryCache({ load: files.load, stamp: files.stamp });
  assert.equal(await read("a.jsonl"), "parsed:a.jsonl@1:100");
  assert.equal(await read("a.jsonl"), "parsed:a.jsonl@1:100");
  assert.deepEqual(files.loads, ["a.jsonl"]);
});

test("a changed stamp (an appended turn) is parsed again, never served stale", async () => {
  const files = fakeFiles({ "a.jsonl": "1:100" });
  const read = createHistoryCache({ load: files.load, stamp: files.stamp });
  await read("a.jsonl");
  files.stamps["a.jsonl"] = "2:200";
  assert.equal(await read("a.jsonl"), "parsed:a.jsonl@2:200");
  assert.equal(files.loads.length, 2);
});

test("the least recently stored history is dropped once the capacity is exceeded", async () => {
  const files = fakeFiles({ "a": "1", "b": "1", "c": "1" });
  const read = createHistoryCache({ load: files.load, stamp: files.stamp, capacity: 2 });
  await read("a");
  await read("b");
  await read("c");
  await read("b");
  await read("a");
  assert.deepEqual(files.loads, ["a", "b", "c", "a"]);
});
