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
  // A one-shot fallback timer (the /reload indicator expiry) is fine; what
  // must never return is a timer wired to the session-list refresh.
  assert.doesNotMatch(source, /setTimeout\([^)]*refreshSessions/, "no timeout timer drives the session list refresh");
});

// Regression: the model picker kept the previous session's model list —
// switching sessions showed another session's models until that session
// happened to push its own web_models event.
test("switching sessions resets the model list and refetches it", () => {
  assert.match(source, /setModels\(\{ models: \[\] \}\)/, "the selection effect clears the previous session's models");
  assert.match(source, /void fetchModels\(selectedId\)/, "the selection effect fetches the new session's models");
});

// Regression: a slow /models response for a session the user had already
// left overwrote the now-selected session's list.
test("fetchModels drops a response for a session the user left", () => {
  assert.match(
    source,
    /selectedIdRef\.current !== id/,
    "a stale fetch response is discarded before it reaches state",
  );
});