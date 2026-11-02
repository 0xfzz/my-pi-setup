/**
 * poll-guard.ts — a parent may look at the workspace. It may not watch it.
 *
 * The wait guard stops a parent from parking on `sleep`. The observed failure in
 * session `01a19cd6` was the other half of the same behaviour: with a child
 * building, the parent ran `find src -type f | sort` twenty times between
 * 15:24 and 15:30, then `find src/components/views src/app/page.tsx -type f`
 * thirty times between 15:34 and 15:37. No single command was a wait, and every
 * one of them was a full-context model request.
 *
 * So the rule is about repetition, not about the command: while a child is in
 * flight, the same read-only inspection may be issued a few times, then it is
 * refused. The lane belongs to the child — it is a workspace, not a progress
 * channel. Progress arrives as `agent_progress` checkpoints and the child's
 * report, and the completion itself re-triggers the parent.
 *
 * Deliberately NOT counted: anything that is not a read-only inspection. A
 * parent running `npm test` or `pnpm build` while a child works is doing work,
 * and the same build twice is not a poll. Only the closed read-only grammar
 * (`lib/plan/plan-shell.ts`) is counted, because that is the shape polling takes.
 */

/** Identical read-only inspections with a live child before the repeat is refused. */
export const POLL_LIMIT = 3;

/** The refusal. One sentence, pinned by tests so the reason does not drift. */
export const POLL_GUARD_REASON =
  `Refused: this exact inspection has already run ${POLL_LIMIT} times while a child is in flight. `
  + "The lane is the child's workspace, not a progress channel — progress arrives as agent_progress "
  + "checkpoints and the child's report, and the completion re-triggers this session by itself. "
  + "End your turn instead of watching the files.";

/** Per-session counts of an identical inspection command. */
const counts = new Map<string, Map<string, number>>();

/** Whitespace differences are not a different command. */
function commandKey(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/**
 * Record one read-only inspection and say whether it is now a poll.
 *
 * True means "this is the same look, again" — the caller refuses it. The count
 * is per exact command text, so a genuinely different inspection always runs.
 */
export function noteInspection(sessionKey: string, command: string, limit = POLL_LIMIT): boolean {
  const perSession = counts.get(sessionKey) ?? new Map<string, number>();
  counts.set(sessionKey, perSession);
  const key = commandKey(command);
  const next = (perSession.get(key) ?? 0) + 1;
  perSession.set(key, next);
  return next > limit;
}

/** Drop the record: a new session, or a test, starts from zero. */
export function resetInspectionCounts(sessionKey?: string): void {
  if (sessionKey === undefined) counts.clear();
  else counts.delete(sessionKey);
}
