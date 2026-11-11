// Guard test for the session-list transport: the sidebar used to poll
// GET /api/sessions every 2 s; it must now hold one directory EventSource.
// This reads the hook's source rather than rendering React, which makes the
// regression cheap to pin without a DOM harness.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./use-session.ts", import.meta.url)), "utf8");

test("use-session holds a directory EventSource, not a /api/sessions poll", () => {
  assert.match(source, /new EventSource\("\/api\/sessions\/events"\)/, "the directory stream is opened");
  assert.doesNotMatch(source, /setInterval/, "no interval timer drives the session list refresh");
  assert.doesNotMatch(source, /setTimeout\(/, "no timeout timer drives the session list refresh");
});