/**
 * When a title is generated, and why not. Pure: (state, event) → decision.
 *
 * Automatic titles only fill an empty name, at most once more after the first
 * (a refinement), with at most three automatic attempts per session, counting
 * failures. A name a person chose locks the automatic path for good. A manual
 * regenerate ignores the cap and the lock, but never runs twice within the
 * cooldown and never while a request is in flight.
 */
import type { TitleBrief } from "./brief.ts";

export const AUTO_TITLE_CAP = 3;
export const MANUAL_COOLDOWN_MS = 10_000;

export interface PolicyState {
  enabled: boolean;
  /** A delegated child session: titled by its parent, never by itself. */
  child: boolean;
  /** A request is already in flight. */
  busy: boolean;
  /** The current session name; empty when there is none. */
  name: string;
  /** The current name is the one the generator wrote last. */
  generatedName: boolean;
  /** Successful generations recorded on the branch, automatic or manual. */
  successes: number;
  /** Automatic attempts so far: successes plus failed or superseded tries. */
  automaticAttempts: number;
  /** A substantive first user message and a first assistant reply both exist. */
  hasExchange: boolean;
  /** The refinement trigger holds (see refineSignal). */
  refineSignal: boolean;
  /** A refinement pass already ran, rewritten or kept. It runs at most once. */
  refined: boolean;
  /** Milliseconds since the last manual regenerate, if there was one. */
  sinceManualMs?: number;
}

export type PolicyEvent = "settled" | "manual";

export type SkipReason =
  | "disabled"
  | "child"
  | "busy"
  | "named"
  | "cleared"
  | "no-exchange"
  | "cap"
  | "not-refinable"
  | "cooldown";

export type PolicyDecision =
  | { action: "generate"; kind: "provisional" | "refine" | "manual" }
  | { action: "skip"; reason: SkipReason };

/**
 * The refinement trigger: a committed plan now exists, or the session has run
 * four or more user turns and touched files. Either can only be read from the
 * brief, so the decision never reads the branch itself.
 */
export function refineSignal(brief: Pick<TitleBrief, "hasPlan" | "userTurns" | "footprint">): boolean {
  return brief.hasPlan || (brief.userTurns >= 4 && brief.footprint !== "");
}

function decideManual(state: PolicyState): PolicyDecision {
  if (state.child) return { action: "skip", reason: "child" };
  if (state.busy) return { action: "skip", reason: "busy" };
  if (state.sinceManualMs !== undefined && state.sinceManualMs < MANUAL_COOLDOWN_MS) {
    return { action: "skip", reason: "cooldown" };
  }
  if (!state.hasExchange) return { action: "skip", reason: "no-exchange" };
  return { action: "generate", kind: "manual" };
}

function decideAutomatic(state: PolicyState): PolicyDecision {
  if (!state.enabled) return { action: "skip", reason: "disabled" };
  if (state.child) return { action: "skip", reason: "child" };
  if (state.busy) return { action: "skip", reason: "busy" };
  if (state.name && !state.generatedName) return { action: "skip", reason: "named" };
  // A generated name the person cleared is a decision: do not write another.
  if (!state.name && state.successes > 0) return { action: "skip", reason: "cleared" };
  if (state.automaticAttempts >= AUTO_TITLE_CAP) return { action: "skip", reason: "cap" };
  if (!state.hasExchange) return { action: "skip", reason: "no-exchange" };
  if (!state.name) return { action: "generate", kind: "provisional" };
  if (state.successes === 1 && state.refineSignal && !state.refined) return { action: "generate", kind: "refine" };
  return { action: "skip", reason: "not-refinable" };
}

export function decide(state: PolicyState, event: PolicyEvent): PolicyDecision {
  return event === "manual" ? decideManual(state) : decideAutomatic(state);
}
