import assert from "node:assert/strict";
import test from "node:test";
import { decodeHistoryCursor, encodeHistoryCursor } from "../lib/history-cursor.ts";

test("history cursors round-trip file offsets", () => {
  for (const offset of [0, 1, 4096, 1_234_567]) {
    assert.equal(decodeHistoryCursor(encodeHistoryCursor(offset)), offset);
  }
});

test("history cursors are opaque URL-safe strings", () => {
  const cursor = encodeHistoryCursor(42);
  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(cursor, /42/);
});

test("invalid history cursors are refused instead of becoming file offsets", () => {
  assert.equal(decodeHistoryCursor(""), undefined);
  assert.equal(decodeHistoryCursor("not-a-cursor"), undefined);
  assert.equal(decodeHistoryCursor(Buffer.from("h1:-1").toString("base64url")), undefined);
  assert.equal(decodeHistoryCursor(Buffer.from("h1:1.5").toString("base64url")), undefined);
  assert.equal(decodeHistoryCursor(Buffer.from("v2:10").toString("base64url")), undefined);
});
