import test from "node:test";
import assert from "node:assert/strict";
import { createInlineLoading } from "./inline-loading.ts";

test("no claim means the generic card is not suppressed", () => {
  const loading = createInlineLoading();
  assert.equal(loading.getSnapshot(), false);
});

test("an active claim suppresses until it is released", () => {
  const loading = createInlineLoading();
  const release = loading.claim();
  assert.equal(loading.getSnapshot(), true);
  release();
  assert.equal(loading.getSnapshot(), false);
});

test("overlapping claims keep suppression until the last one releases", () => {
  const loading = createInlineLoading();
  const first = loading.claim();
  const second = loading.claim();
  first();
  assert.equal(loading.getSnapshot(), true);
  second();
  assert.equal(loading.getSnapshot(), false);
});

test("releasing the same claim twice does not steal another claim's count", () => {
  const loading = createInlineLoading();
  const keep = loading.claim();
  const drop = loading.claim();
  drop();
  drop();
  assert.equal(loading.getSnapshot(), true);
  keep();
  assert.equal(loading.getSnapshot(), false);
});

test("subscribers hear every claim and release, and unsubscribe cleanly", () => {
  const loading = createInlineLoading();
  let calls = 0;
  const unsubscribe = loading.subscribe(() => { calls += 1; });
  const release = loading.claim();
  release();
  assert.equal(calls, 2);
  unsubscribe();
  loading.claim();
  assert.equal(calls, 2);
});
