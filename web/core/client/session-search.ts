// Session-list search: the pure half of the sidebar's search box.
//
// The sidebar holds a window of recent sessions, so filtering that window
// locally cannot find a session that has fallen out of it — including one whose
// only memorable text is a generated title. The server can (it widens its scan
// when a query is present), so a search is a union of two answers:
//
//   local  — what is loaded, filtered instantly as the user types;
//   remote — the server's answer, which reaches past the window.
//
// Merging by id keeps the local row when both have it: the local row carries
// live state (`running`, `live`) the server's disk row cannot know, while the
// server's row is the one that proved the match.

import type { SessionSummary } from "./use-session.ts";

/** The text a row is searchable by: its name, its project path, its id. */
export function sessionSearchText(session: SessionSummary): string {
  return `${session.name ?? ""} ${session.cwd} ${session.id}`.toLowerCase();
}

/** Whether one row matches a query already lower-cased and trimmed. */
export function matchesSessionQuery(session: SessionSummary, needle: string): boolean {
  return needle === "" || sessionSearchText(session).includes(needle);
}

/** The loaded rows that match, in their existing order. */
export function filterSessions(sessions: readonly SessionSummary[], query: string): SessionSummary[] {
  const needle = query.trim().toLowerCase();
  return sessions.filter((session) => matchesSessionQuery(session, needle));
}

/**
 * Union of the local matches and the server's, by id. Local rows win — they
 * hold the live state — and server-only rows are appended in the order the
 * server returned them.
 */
export function mergeSearchResults(
  local: readonly SessionSummary[],
  remote: readonly SessionSummary[],
): SessionSummary[] {
  const seen = new Set(local.map((session) => session.id));
  return [...local, ...remote.filter((session) => !seen.has(session.id))];
}

/**
 * What the sidebar shows for a query: local matches instantly, widened by the
 * server's answer once it lands. With no query the full list is shown as-is.
 */
export function visibleSessions(
  sessions: readonly SessionSummary[],
  query: string,
  remote: readonly SessionSummary[],
): SessionSummary[] {
  if (query.trim() === "") return [...sessions];
  return mergeSearchResults(filterSessions(sessions, query), remote);
}
