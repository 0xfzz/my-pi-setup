// The sidebar's search: what a query matches, and how the loaded window is
// widened by the server's answer. Pure functions, so the rules are pinned
// without a DOM.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  filterSessions,
  matchesSessionQuery,
  mergeSearchResults,
  sessionSearchText,
  visibleSessions,
} from "./session-search.ts";
import type { SessionSummary } from "./use-session.ts";

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return { cwd: "/tmp/work", live: false, modifiedAt: 0, ...overrides };
}

// Regression: a generated title was not findable in the sidebar's search box.
// The row's searchable text must include the name, or the title the user is
// looking at is not the title they can search for.
test("a session is searchable by its generated title", () => {
  const row = session({ id: "01a1d889", name: "How to test the mobile ILP epic" });
  assert.match(sessionSearchText(row), /how to test the mobile ilp epic/);
  assert.equal(matchesSessionQuery(row, "mobile ilp"), true);
  assert.equal(matchesSessionQuery(row, "ilp epic"), true);
  assert.equal(matchesSessionQuery(row, "unrelated"), false);
});

test("search still matches the project path and the session id", () => {
  const row = session({ id: "01a1d889", cwd: "/home/faiz/projects/ruumi-qa-integrated" });
  assert.equal(matchesSessionQuery(row, "ruumi-qa"), true);
  assert.equal(matchesSessionQuery(row, "01a1d8"), true);
});

test("an empty query matches everything, so clearing the box restores the list", () => {
  const rows = [session({ id: "a" }), session({ id: "b" })];
  assert.deepEqual(filterSessions(rows, ""), rows);
  assert.deepEqual(filterSessions(rows, "   "), rows);
});

test("filtering is case-insensitive and keeps the existing order", () => {
  const rows = [
    session({ id: "a", name: "Plan review" }),
    session({ id: "b", name: "Cache audit" }),
    session({ id: "c", name: "Plan follow-up" }),
  ];
  assert.deepEqual(filterSessions(rows, "PLAN").map((row) => row.id), ["a", "c"]);
});

// The reason the server is asked at all: the loaded list is a recent window, so
// a session that fell out of it cannot be found locally.
test("a server result outside the loaded window is included", () => {
  const local = [session({ id: "recent", name: "Plan review" })];
  const remote = [session({ id: "recent", name: "Plan review" }), session({ id: "older", name: "Plan of record" })];
  assert.deepEqual(mergeSearchResults(local, remote).map((row) => row.id), ["recent", "older"]);
});

test("a row both sides know keeps the local one, which carries live state", () => {
  const local = [session({ id: "x", name: "Plan review", live: true, running: true, modifiedAt: 99 })];
  const remote = [session({ id: "x", name: "Plan review", live: false, modifiedAt: 1 })];
  const [merged] = mergeSearchResults(local, remote);
  assert.equal(merged?.live, true, "the local row wins");
  assert.equal(merged?.running, true);
  assert.equal(merged?.modifiedAt, 99);
});

test("no query shows the list untouched; a query unions local matches with the server's", () => {
  const rows = [session({ id: "a", name: "Plan review" }), session({ id: "b", name: "Cache audit" })];
  assert.deepEqual(visibleSessions(rows, "", []).map((row) => row.id), ["a", "b"]);

  const remote = [session({ id: "c", name: "Plan of record" })];
  assert.deepEqual(visibleSessions(rows, "plan", remote).map((row) => row.id), ["a", "c"]);
});

test("a query that matches nothing locally still shows the server's rows", () => {
  const rows = [session({ id: "a", name: "Cache audit" })];
  const remote = [session({ id: "z", name: "How to test the mobile ILP epic" })];
  assert.deepEqual(visibleSessions(rows, "mobile ilp", remote).map((row) => row.id), ["z"]);
});

// Source guard: the sidebar must actually ask the server, and the hook must
// actually send the query — otherwise the widened scan above is dead code and
// an older titled session stays unfindable.
test("the sidebar asks the server for a query and the hook sends it", () => {
  const sidebar = readFileSync(fileURLToPath(new URL("./sidebar.tsx", import.meta.url)), "utf8");
  assert.match(sidebar, /visibleSessions\(sessions, query, remoteMatches\)/, "the sidebar merges the server's answer");
  assert.match(sidebar, /onSearch\(query\)/, "the sidebar calls the search callback");

  const hook = readFileSync(fileURLToPath(new URL("./use-session.ts", import.meta.url)), "utf8");
  assert.match(hook, /\/api\/sessions\?q=\$\{encodeURIComponent\(trimmed\)\}/, "the hook sends the query to the server");
  assert.match(hook, /searchQueryRef\.current !== trimmed/, "a stale response is dropped");
});
