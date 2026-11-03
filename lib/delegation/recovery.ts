/**
 * recovery.ts — what machinery does about a failed child before it bothers the parent.
 *
 *   transient            → retry the SAME model after a backoff (bounded)
 *   quota / config / auth → the model, not the task, is the problem: fail over to
 *                          the next usable model of the role's pool
 *   transient, exhausted → the model keeps failing: fail over as well
 *   nothing left to try  → escalate to the parent with the class remedy
 *
 * Pure so the policy is testable without panes, clocks or a registry. The caller
 * supplies the candidates (already filtered to models that resolve and have
 * credentials); this module only decides the order and the stopping rule.
 */
import type { ChildErrorClass } from "./child-error.ts";

export const MAX_RETRIES_PER_MODEL = 3;
/** Total failovers one work unit may use, regardless of pool size. */
export const MAX_FAILOVERS = 3;

export interface RecoveryState {
  /** Retries spent on the current model. */
  attempts: number;
  /** Failovers spent on this work unit. */
  failovers: number;
  /** Every model that failed this unit, `provider/model`. */
  tried: string[];
  /** When a scheduled recovery is due (epoch ms) — persisted so a restart re-arms it. */
  dueAt?: number;
  /** What the scheduled recovery will do. */
  action?: "retry" | "failover";
  /** The model the scheduled recovery resumes on (failover only). */
  model?: string;
}

export type RecoveryDecision =
  | { action: "retry"; delayMs: number; attempt: number }
  | { action: "failover"; delayMs: number; model: string }
  | { action: "escalate"; reason: string };

/** Backoff for the Nth retry: exponential from 15s, never below the provider's wait, capped at 10m. */
export function retryDelayMs(attempt: number, retryAfterMs?: number): number {
  const exponential = 15_000 * 2 ** Math.max(0, attempt);
  return Math.min(10 * 60_000, Math.max(exponential, (retryAfterMs ?? 0) + 5_000));
}

export function decideRecovery(input: {
  errorClass: ChildErrorClass;
  retryAfterMs?: number;
  /**
   * The provider went silent (see ChildErrorVerdict.stalled). Retrying the same
   * endpoint only waits out the same stall, so another usable model is preferred.
   */
  stalled?: boolean;
  state: RecoveryState;
  /** Usable models for this role (credentials present), in preference order. */
  candidates: readonly string[];
}): RecoveryDecision {
  const { errorClass, state } = input;
  if (errorClass === "aborted") return { action: "escalate", reason: "the run was cancelled, not failed by the provider" };

  const next = input.candidates.find((model) => !state.tried.includes(model));
  const stallSwitch = input.stalled === true && next !== undefined;
  if (errorClass === "transient" && !stallSwitch && state.attempts < MAX_RETRIES_PER_MODEL) {
    return { action: "retry", attempt: state.attempts + 1, delayMs: retryDelayMs(state.attempts, input.retryAfterMs) };
  }

  const failoverable = errorClass === "transient" || errorClass === "quota" || errorClass === "config" || errorClass === "auth";
  if (failoverable) {
    if (state.failovers >= MAX_FAILOVERS) {
      return { action: "escalate", reason: `${state.failovers} model failovers already spent on this work unit` };
    }
    if (next) return { action: "failover", model: next, delayMs: 5_000 };
    return {
      action: "escalate",
      reason: input.candidates.length === 0
        ? "no alternative model is configured for this role (bind a pool with /agent-model)"
        : "every model in the role's pool has already failed this work unit",
    };
  }
  return { action: "escalate", reason: "this failure is not one a different model or a retry can fix" };
}

export function emptyRecovery(): RecoveryState {
  return { attempts: 0, failovers: 0, tried: [] };
}
