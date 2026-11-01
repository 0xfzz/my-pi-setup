/**
 * delegate-cap.ts — how many children one parent process may hold at once.
 *
 * The cap is a concurrency ceiling, not a budget: 5 running means the next spawn
 * is refused; when one completes, its slot frees and the parent may spawn again
 * up to 5, never 6. It is per process, so a second parent session has its own
 * slots; children are tied to the process that registered them (`parentPid`).
 *
 * Pure: no I/O, so the arithmetic is testable without launching a pane.
 */

export const DEFAULT_MAX_DELEGATES = 5;
/** Sanity ceiling: beyond this a fan-out stops being reviewable. */
export const MAX_DELEGATES_LIMIT = 20;

export function resolveMaxDelegates(settings: { maxDelegates?: unknown } | undefined): number {
  const raw = settings?.maxDelegates;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isInteger(n) || n < 1) return DEFAULT_MAX_DELEGATES;
  return Math.min(n, MAX_DELEGATES_LIMIT);
}

export type ParsedMaxDelegates =
  | { ok: true; value: number }
  | { ok: false; problem: string };

export function parseMaxDelegates(value: string): ParsedMaxDelegates {
  const text = value.trim();
  if (!/^\d+$/.test(text)) return { ok: false, problem: `"${value}" is not a whole number.` };
  const n = Number(text);
  if (n < 1 || n > MAX_DELEGATES_LIMIT) {
    return { ok: false, problem: `Use a number from 1 to ${MAX_DELEGATES_LIMIT}.` };
  }
  return { ok: true, value: n };
}

/** Refusal text when the next spawn would exceed the process ceiling. */
export function delegateCapRefusal(running: readonly string[], cap: number): string | undefined {
  if (running.length < cap) return undefined;
  return (
    `Refused: ${running.length} agent(s) are already running in this process (${running.join(", ")}). `
    + `The cap is ${cap}; a new spawn would make ${running.length + 1}. `
    + `Wait for one to complete, or raise the cap with /agent max <n>.`
  );
}
