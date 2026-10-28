/**
 * The gate: one tool call in, one allow/block out, with at most one question.
 *
 * Three behaviours matter more than the happy path:
 *
 * 1. **Serialization.** Parallel tool calls each arrive as their own
 *    `tool_call` event. Without a queue they would open overlapping overlays and
 *    the answers would land on the wrong call. Every question goes through one
 *    lane, and the lane is re-entered before deciding, so an "allow this folder"
 *    answer covers the calls queued behind it instead of asking again.
 * 2. **No answer is not consent.** A missing UI, an aborted signal or a dialog
 *    that throws all deny. Only an explicit chooser result can allow.
 * 3. **Everything the user allowed is recorded.** `onGrant` is called for each
 *    session grant so the caller can persist it on the branch and show it in
 *    `/scope log`; nothing is written here.
 */
import { describeDecision, evaluateClaim } from "./policy.ts";
import { classifyPath, suggestGrant } from "./paths.ts";
import { claimSetFor, displayPath, type ClaimOptions } from "./tool-paths.ts";
import type { PathClaim, ScopeDecision, ScopeRoot, ScopeRule, ScopeState, ScopeSuggestion } from "./types.ts";

export interface AskRequest {
  tool: string;
  display: string;
  write: boolean;
  reason: string;
  suggestion: ScopeSuggestion;
  /** How many other calls are already waiting behind this one. */
  queued: number;
}

export type AskAnswer =
  | { kind: "once" }
  | { kind: "allow"; grant: ScopeSuggestion }
  | { kind: "deny" }
  | { kind: "rule"; text: string }
  /** No UI could ask. Distinct from "deny" so the model gets a usable reason. */
  | { kind: "unavailable"; message: string };

export interface GateResult {
  block: true;
  reason: string;
}

export interface GateDeps {
  state: () => ScopeState;
  setState: (state: ScopeState) => void;
  cwd: () => string;
  /** Ask the user. Rejecting/returning `undefined` means deny. */
  ask: (request: AskRequest) => Promise<AskAnswer | undefined>;
  /** Record a grant that must outlive this call (branch / config / audit). */
  onGrant?: (grant: { root: ScopeRoot; rule?: ScopeRule }) => void;
  /** Tool metadata, so unmapped tools can honour `readOnlyHint`. */
  annotationsFor?: (tool: string) => ClaimOptions["annotations"];
  mcpPathFields?: () => Readonly<Record<string, string>> | undefined;
  /** Called for every question the gate had to ask (audit / sidebar). */
  onAsk?: (request: AskRequest) => void;
  /** Called for every automatic approval while yolo is armed. */
  onAutoApprove?: (decision: ScopeDecision, claim: PathClaim | undefined) => void;
}

/** One question at a time, FIFO. `size` is what the sidebar shows. */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;

  get size(): number {
    return this.waiting;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    this.waiting++;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      return await task();
    } finally {
      this.waiting--;
      release();
    }
  }
}

export interface Gate {
  claimsFor: (tool: string, input: Record<string, unknown> | undefined) => ReturnType<typeof claimSetFor>;
  gate: (tool: string, input: Record<string, unknown> | undefined) => Promise<GateResult | undefined>;
  queue: SerialQueue;
}

const DENY_HINT = "Ask for a path inside the workspace, or run /scope allow <path> to grant it.";

export function createGate(deps: GateDeps): Gate {
  const queue = new SerialQueue();

  const claimsFor = (tool: string, input: Record<string, unknown> | undefined) =>
    claimSetFor(tool, input, {
      cwd: deps.cwd(),
      annotations: deps.annotationsFor?.(tool),
      mcpPathFields: deps.mcpPathFields?.(),
    });

  function toPathClaim(tool: string, request: { raw: string; write: boolean; kind: "file" | "directory" | "unknown"; action: string }): PathClaim {
    const classified = classifyPath(deps.cwd(), deps.state().roots, request.raw);
    return {
      tool,
      action: request.action,
      absolute: classified.absolute,
      resource: classified.resource,
      write: request.write,
      external: classified.external,
      kind: request.kind,
    };
  }

  function denied(tool: string, decision: ScopeDecision): GateResult {
    return { block: true, reason: `Scope: ${decision.reason}. ${tool} was not run. ${DENY_HINT}` };
  }

  async function askFor(tool: string, claim: PathClaim, decision: ScopeDecision): Promise<AskAnswer> {
    const suggestion = suggestGrant(claim.absolute, {
      cwd: deps.cwd(),
      home: process.env.HOME ?? process.env.USERPROFILE,
      kind: claim.kind,
      access: claim.write ? "rw" : "ro",
    });
    const request: AskRequest = {
      tool,
      display: displayPath(deps.cwd(), claim.absolute),
      write: claim.write,
      reason: describeDecision(decision, tool, claim.absolute),
      suggestion,
      queued: Math.max(0, queue.size - 1),
    };
    deps.onAsk?.(request);
    try {
      return (await deps.ask(request)) ?? { kind: "deny" };
    } catch {
      // A dialog failure is not an approval. Fail closed.
      return { kind: "deny" };
    }
  }

  function applyAnswer(answer: AskAnswer, claim: PathClaim): void {
    const state = deps.state();
    if (answer.kind === "allow") {
      const root: ScopeRoot = {
        path: answer.grant.path,
        access: answer.grant.access,
        source: "session",
      };
      if (!state.roots.some(existing => existing.path === root.path)) {
        deps.setState({ ...state, roots: [...state.roots, root] });
        deps.onGrant?.({ root });
      }
      return;
    }
    if (answer.kind === "rule") {
      const rule = parseRule(answer.text, claim.resource);
      const rules = [...state.rules, rule];
      deps.setState({ ...state, rules });
      deps.onGrant?.({ root: { path: "", access: "ro", source: "session" }, rule });
    }
  }

  async function gate(tool: string, input: Record<string, unknown> | undefined): Promise<GateResult | undefined> {
    const claimSet = claimsFor(tool, input);
    if (claimSet.unknown) {
      const decision = evaluateClaim({ tool, unknown: true }, deps.state());
      if (decision.effect === "deny") {
        return { block: true, reason: `Scope: ${claimSet.reason ?? decision.reason}. ${tool} was not run. ${DENY_HINT}` };
      }
      if (decision.effect === "allow") {
        if (deps.state().yolo) deps.onAutoApprove?.(decision, undefined);
        return undefined;
      }
      return queue.run(async () => {
        // Re-evaluate inside the lane: an earlier answer may have covered this.
        const again = evaluateClaim({ tool, unknown: true }, deps.state());
        if (again.effect === "allow") return undefined;
        if (again.effect === "deny") return { block: true, reason: `Scope: ${again.reason}. ${tool} was not run. ${DENY_HINT}` };
        const request: AskRequest = {
          tool,
          display: "(paths not declared)",
          write: true,
          reason: claimSet.reason ?? again.reason,
          suggestion: { path: deps.cwd(), access: "ro", glob: deps.cwd(), exact: true },
          queued: Math.max(0, queue.size - 1),
        };
        deps.onAsk?.(request);
        const answer = await deps.ask(request).catch(() => undefined);
        if (answer?.kind === "rule") applyAnswer(answer, { tool, action: tool, absolute: deps.cwd(), resource: "*", write: true, external: true, kind: "unknown" });
        if (answer?.kind === "unavailable") return { block: true, reason: answer.message };
        // There is no safe standing grant for "unknown paths": allow once only.
        return answer?.kind === "once" ? undefined : { block: true, reason: `Scope: ${tool} was not run; it does not declare the paths it touches. ${DENY_HINT}` };
      });
    }

    for (const request of claimSet.paths) {
      const claim = toPathClaim(tool, request);
      const decision = evaluateClaim(claim, deps.state());
      if (decision.effect === "deny") return denied(tool, decision);
      if (decision.effect === "allow") {
        if (deps.state().yolo && decision.reason.includes("yolo")) deps.onAutoApprove?.(decision, claim);
        continue;
      }
      const result = await queue.run(async (): Promise<GateResult | undefined> => {
        const claimed = toPathClaim(tool, request);
        const again = evaluateClaim(claimed, deps.state());
        if (again.effect === "allow") return undefined;
        if (again.effect === "deny") return denied(tool, again);
        const answer = await askFor(tool, claimed, again);
        if (answer.kind === "unavailable") return { block: true, reason: answer.message };
        if (answer.kind === "deny") {
          return { block: true, reason: `Scope: ${tool} was denied access to ${claimed.absolute}. ${DENY_HINT}` };
        }
        if (answer.kind === "once") return undefined;
        applyAnswer(answer, claimed);
        const after = evaluateClaim(claimed, deps.state());
        return after.effect === "allow" ? undefined : denied(tool, after);
      });
      if (result) return result;
    }
    return undefined;
  }

  return { claimsFor, gate, queue };
}

/** `<tool|*> <glob> <allow|ask|deny>`; a bare glob gets the claim's action. */
export function parseRule(text: string, fallbackResource: string): ScopeRule {
  const parts = text.trim().split(/\s+/);
  // The resource may contain spaces (`rm -rf *`), so the effect is the LAST word,
  // not the third one.
  const last = parts[parts.length - 1];
  if (parts.length >= 3 && last && isEffect(last)) {
    return { action: parts[0]!, resource: parts.slice(1, -1).join(" "), effect: last };
  }
  if (parts.length === 2 && isEffect(parts[1]!)) {
    return { action: "*", resource: parts[0]!, effect: parts[1]! };
  }
  if (parts.length === 1 && isEffect(parts[0]!)) {
    return { action: "*", resource: fallbackResource, effect: parts[0]! };
  }
  throw new Error(`Cannot read rule "${text}". Use <tool|*> <glob> <allow|ask|deny>.`);
}

function isEffect(value: string): value is ScopeRule["effect"] {
  return value === "allow" || value === "ask" || value === "deny";
}
