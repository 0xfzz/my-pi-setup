/**
 * child-error.ts — what a child's failure MEANS, so the parent can act on it.
 *
 * Before this module a child that hit a provider limit wrote a `ping` sidecar
 * ("Subagent halted: …"), and the parent opened an *escalation* for it: a quota
 * error was handled as a question to be answered. Answering "429" with text
 * resumes the child into the same wall. The failure class decides the remedy:
 *
 *   transient — capacity / rate window / network: the same model works again
 *               after a wait. Bounded resume is right.
 *   quota     — the account is out until a reset: waiting is pointless inside
 *               the budget; change the model/account or ask the user.
 *   auth      — credentials: only the user can fix it.
 *   config    — model/provider not registered or not supported: a different
 *               model binding is needed; retry is pointless.
 *   aborted   — the run was cancelled (Esc, watchdog interrupt): not an error
 *               in the provider, never retried automatically.
 *   unknown   — unclassified: report verbatim, parent decides.
 *
 * Patterns come from the real corpus in ~/.pi/agent/sessions, not from guesses.
 */

export type ChildErrorClass = "transient" | "quota" | "auth" | "config" | "aborted" | "unknown";

export interface ChildErrorVerdict {
  class: ChildErrorClass;
  /** Provider-suggested wait, when the message states one. */
  retryAfterMs?: number;
  /** Whether a bounded automatic/parent resume of the SAME model is sensible. */
  retryable: boolean;
  /**
   * The endpoint stopped answering (no response headers, a dropped connection, a
   * timeout). Retrying the same endpoint on a backoff just waits out the same
   * stall, so recovery moves to another model when one is available.
   */
  stalled: boolean;
  /** The remedy, in the parent's vocabulary. */
  advice: string;
}

// Order matters: quota and auth are checked before the generic "rate limit"
// wording because several quota messages also say "limit".
const RULES: Array<{ class: ChildErrorClass; test: RegExp }> = [
  { class: "aborted", test: /\b(operation was aborted|request was aborted|aborted by user)\b/i },
  {
    class: "quota",
    test: /usage limit|quota reached|quota exceeded|free[_ ]tier|used today'?s|usage pack|budget_exceeded|insufficient[_ ]quota|billing|hourly rate limit|reached your .*limit/i,
  },
  { class: "auth", test: /invalid .*credentials|auth_error|unauthori[sz]ed|\b401\b|\b403\b|\/login|api key/i },
  { class: "config", test: /not registered|not supported|model.*not found|unknown model|requires global regions|no such model/i },
  {
    class: "transient",
    test: /\b429\b|\b50[0234]\b|rate[_ ]limit|at capacity|concurrency capacity|connection error|fetch failed|timed out|no response headers|stream ended|terminated|bad gateway|overloaded|internal server error|server_error|try again|retry (in|shortly)|without a finish reason|ECONNRESET|ETIMEDOUT/i,
  },
];

const ADVICE: Record<ChildErrorClass, string> = {
  transient:
    "Provider capacity or network blip. agent_resume the SAME session after the wait (bounded: the row counts attempts); "
    + "if it recurs, resume with a different model.",
  quota:
    "The account is out of quota until a reset. Do NOT resume the same model: agent_resume with a different `model`, "
    + "or hand the decision to the user (agent_escalate to-user).",
  auth: "Credentials are invalid or expired. Only the user can fix this: ask them to log in again, then resume.",
  config: "The model/provider binding is wrong for this account. Resume with a different model; retrying is pointless.",
  aborted: "The run was cancelled, not failed by the provider. Decide whether to resume with direction or close.",
  unknown: "Unclassified failure. Read the message, then resume with direction, change model, or close the child.",
};

/** "retry shortly (after 18 s)", "in about 25 seconds", "~5 min", "in 2h 3m" → ms. */
export function parseRetryAfterMs(message: string): number | undefined {
  const text = String(message ?? "");
  const hms = text.match(/(?:in|after|wait)\s+~?(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+)\s*s(?:ec(?:onds?)?)?)?(?![a-z])/i);
  if (hms && (hms[1] || hms[2] || hms[3])) {
    return ((Number(hms[1] ?? 0) * 60 + Number(hms[2] ?? 0)) * 60 + Number(hms[3] ?? 0)) * 1000;
  }
  const loose = text.match(/(\d+)\s*(seconds?|s|minutes?|min|m)\b/i);
  if (loose) return Number(loose[1]) * (/^m/i.test(loose[2]!) ? 60_000 : 1000);
  return undefined;
}

/** Wording that means the endpoint went silent, not that it said "busy, try later". */
const STALL_PATTERN = /no response headers|fetch failed|timed out|ETIMEDOUT|ECONNRESET|connection error|stream ended|terminated/i;

export function classifyChildError(message: string | null | undefined): ChildErrorVerdict {
  const text = String(message ?? "");
  const rule = RULES.find((candidate) => candidate.test.test(text));
  const cls: ChildErrorClass = rule?.class ?? "unknown";
  const retryAfterMs = parseRetryAfterMs(text);
  return {
    class: cls,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    retryable: cls === "transient",
    stalled: cls === "transient" && STALL_PATTERN.test(text),
    advice: ADVICE[cls],
  };
}

/** The sidecar text orch-child writes for a terminal model failure. */
export const HALTED_PREFIX = "Subagent halted:";

/** True when a `ping` is really a terminal failure the child could not ask about. */
export function isHaltedPing(message: string | null | undefined): boolean {
  return String(message ?? "").trimStart().startsWith(HALTED_PREFIX);
}
