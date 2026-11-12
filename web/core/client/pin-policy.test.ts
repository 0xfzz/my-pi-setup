import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PINS,
  PIN_LIMIT_MESSAGE,
  partitionPinned,
  pinPanel,
  seedPins,
  unpinPanel,
} from "./plugin-system/pin-policy.ts";
import { browserStorage, loadPinnedIds, savePinnedIds, type StorageLike } from "./plugin-system/pin-storage.ts";

function memoryStore(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

test("seeding without a stored preference pins the first three eligible panels", () => {
  assert.deepEqual(seedPins(["a", "b", "c", "d"], null), ["a", "b", "c"]);
  assert.deepEqual(seedPins(["a"], null), ["a"]);
  assert.deepEqual(seedPins([], null), []);
});

test("a stored list is deduplicated and capped, never re-seeded", () => {
  assert.deepEqual(seedPins(["a", "b"], ["b", "a", "b", "a", "c", "d"]), ["b", "a", "c"]);
  assert.deepEqual(seedPins(["a", "b", "c"], []), [], "an explicit empty list stays empty");
  assert.deepEqual(seedPins(["a", "b", "c"], ["x"]), ["x"], "stored ids are not re-seeded against eligible");
});

test("pinPanel appends, no-ops on an existing pin, and refuses past MAX_PINS", () => {
  assert.deepEqual(pinPanel([], "a"), { ok: true, pinned: ["a"] });
  assert.deepEqual(pinPanel(["a"], "b"), { ok: true, pinned: ["a", "b"] });
  assert.deepEqual(pinPanel(["a", "b"], "a"), { ok: true, pinned: ["a", "b"] });
  assert.deepEqual(pinPanel(["a", "b", "c"], "a"), { ok: true, pinned: ["a", "b", "c"] });
  const refused = pinPanel(["a", "b", "c"], "d");
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error, PIN_LIMIT_MESSAGE);
});

test("pinPanel deduplicates before counting the cap", () => {
  assert.deepEqual(pinPanel(["a", "a", "b"], "c"), { ok: true, pinned: ["a", "b", "c"] });
});

test("unpinPanel removes the id and keeps the rest in order", () => {
  assert.deepEqual(unpinPanel(["a", "b", "c"], "b"), ["a", "c"]);
  assert.deepEqual(unpinPanel(["a"], "missing"), ["a"]);
});

test("partitionPinned splits on availability while preserving pin order", () => {
  assert.deepEqual(partitionPinned(["a", "b", "c", "d"], ["c", "a"]), {
    available: ["a", "c"],
    unavailable: ["b", "d"],
  });
  assert.deepEqual(partitionPinned([], ["a"]), { available: [], unavailable: [] });
  assert.deepEqual(partitionPinned(["a", "a", "b"], ["b"]), {
    available: ["b"],
    unavailable: ["a"],
  });
});

test("MAX_PINS is the documented three-icon cap", () => {
  assert.equal(MAX_PINS, 3);
});

test("loadPinnedIds returns null for a missing, corrupt or wrong-version store", () => {
  assert.equal(loadPinnedIds(memoryStore()), null);
  assert.equal(loadPinnedIds(memoryStore({ "pi-web-minimal:pinned-panels:v1": "not json" })), null);
  assert.equal(loadPinnedIds(memoryStore({ "pi-web-minimal:pinned-panels:v1": "[1,2]" })), null);
  assert.equal(loadPinnedIds(memoryStore({ "pi-web-minimal:pinned-panels:v1": '{"version":2,"pinned":[]}' })), null);
});

test("loadPinnedIds returns the validated id list, dropping non-strings", () => {
  const stored = JSON.stringify({ version: 1, pinned: ["a", "", 3, null, "b"] });
  assert.deepEqual(loadPinnedIds(memoryStore({ "pi-web-minimal:pinned-panels:v1": stored })), ["a", "b"]);
  assert.deepEqual(loadPinnedIds(memoryStore({ "pi-web-minimal:pinned-panels:v1": '{"version":1,"pinned":[]}' })), []);
});

test("a denied store reads as no preference", () => {
  const denied: StorageLike = { getItem: () => { throw new Error("denied"); }, setItem: () => {} };
  assert.equal(loadPinnedIds(denied), null);
});

test("savePinnedIds round-trips through loadPinnedIds", () => {
  const store = memoryStore();
  savePinnedIds(store, ["a", "b", "c"]);
  assert.deepEqual(loadPinnedIds(store), ["a", "b", "c"]);
});

test("a throwing store swallows writes", () => {
  const denied: StorageLike = { getItem: () => null, setItem: () => { throw new Error("denied"); } };
  assert.doesNotThrow(() => savePinnedIds(denied, ["a"]));
});

test("browserStorage degrades to an inert store when localStorage is absent", () => {
  const store = browserStorage();
  assert.equal(store.getItem("k"), null);
  assert.doesNotThrow(() => store.setItem("k", "v"));
});