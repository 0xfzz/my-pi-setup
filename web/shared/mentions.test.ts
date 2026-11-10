import test from "node:test";
import assert from "node:assert/strict";
import { activeMentionToken } from "./mentions.ts";

test("activeMentionToken finds the token being typed at the caret", () => {
  assert.equal(activeMentionToken("look at @web/cl"), "web/cl");
  assert.equal(activeMentionToken("@"), "");
  assert.equal(activeMentionToken("plain text"), null);
  // An email-like token is not a mention (no leading boundary).
  assert.equal(activeMentionToken("mail a@b.com ple"), null);
  // A fresh token starts after whitespace.
  assert.equal(activeMentionToken("read @a.ts and @b"), "b");
});
