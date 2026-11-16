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

// Compaction feedback: /compact used to ride a channel nothing listened to for
// an in-process session, and neither the running compaction nor the boundary
// it left behind was ever rendered. The hook owns the live half.
test("use-session tracks a running compaction from its own events", () => {
  assert.match(source, /case "compaction_start":/, "the start event is handled");
  assert.match(source, /case "compaction_end":/, "the end event is handled");
  assert.match(
    source,
    /setCompacting\(isCompactionReason\(data\.reason\) \? data\.reason : "manual"\)/,
    "the reason comes from the event, defaulting to a manual compaction",
  );
  assert.match(source, /setCompacting\(null\)/, "the end event clears it");
  // The selection effect must not carry a compaction across a session switch.
  assert.match(
    source,
    /setSessionCommands\(\[\]\);\n\s*\/\/ Never carry a compaction[\s\S]*?setCompacting\(null\);/,
    "switching sessions clears the compaction state",
  );
});

// A custom compactor (an extension's `turn_end` boundary draft, like VCC)
// never fires compaction_start/compaction_end: pi announces its entry as an
// appended entry. The hook must still bring the marker into the transcript.
test("use-session picks up a compaction an extension appended", () => {
  assert.match(source, /case "compaction_applied":/, "the appended-compaction signal is handled");
  assert.match(
    source,
    /case "compaction_applied":[\s\S]{0,700}setHistoryEpoch\(\(epoch\) => epoch \+ 1\)/,
    "it re-reads the transcript rather than trusting the event's payload",
  );
});


// nothing on disk to mark it: without a transcript row the browser would show
// a context that never shrank and no explanation.
test("use-session surfaces a failed automatic compaction", () => {
  assert.match(
    source,
    /if \(errorMessage !== "" && data\.reason !== "manual"\) \{\n\s*appendEntry\(\{ role: "compaction", blocks: \[\], summary: "", error: errorMessage \}\);/,
    "an automatic compaction failure appends a marker carrying its reason",
  );
});