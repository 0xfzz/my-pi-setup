import test from "node:test";
import assert from "node:assert/strict";
import { CloseIntents } from "../../lib/delegation/close-intent.ts";

test("a session is marked only between begin and end", () => {
  const intents = new CloseIntents();
  assert.equal(intents.has("/s/a.jsonl"), false);
  intents.begin("/s/a.jsonl");
  assert.equal(intents.has("/s/a.jsonl"), true);
  assert.equal(intents.has("/s/b.jsonl"), false, "another session is not affected");
  intents.end("/s/a.jsonl");
  assert.equal(intents.has("/s/a.jsonl"), false);
});

test("ending an unmarked session is harmless", () => {
  const intents = new CloseIntents();
  intents.end("/s/none.jsonl");
  assert.equal(intents.has("/s/none.jsonl"), false);
});
