/**
 * live.ts — one question both the wait guard and the todo nudge ask:
 * "does this parent have a child in flight?"
 *
 * The rule the wait guard enforces is about *waiting on a child*. Waiting for a
 * service, a port or a build is work, and session `01a19cd6` shows the cost of
 * not distinguishing the two: `sleep 8 && docker compose ps`, run to let MySQL
 * accept connections, was refused by a guard aimed at subagents — while that
 * session had no child at all. The parent then spent twenty minutes polling
 * `find` instead of ending its turn.
 *
 * So the guard is scoped by this predicate instead of applied to every parent
 * command. The truth lives in `ScopeRegistry`, which belongs to the delegation
 * extension; a probe is registered rather than imported so this module (and the
 * mode extension that also asks) never depends on the extension module graph.
 */

/** Answers "is a child of this session running or blocked right now?" */
export type DelegationProbe = (ownerSessionId?: string) => boolean;

let probe: DelegationProbe | undefined;

/**
 * Install (or clear) the delegation probe.
 *
 * Cleared on shutdown so a probe capturing a disposed registry cannot answer for
 * a session that no longer exists.
 */
export function setDelegationProbe(next: DelegationProbe | undefined): void {
  probe = next;
}

/**
 * True while a child of this session is running or blocked.
 *
 * False when no probe is installed (the delegation extension is not loaded), so
 * a bare `sleep` is never refused by a rule whose owner is absent.
 */
export function hasLiveDelegation(ownerSessionId?: string): boolean {
  try {
    return probe?.(ownerSessionId) === true;
  } catch {
    // A probe that throws is a bug in the probe, not evidence of a wait.
    // Refusing work because of it would block a command for the wrong reason.
    return false;
  }
}
