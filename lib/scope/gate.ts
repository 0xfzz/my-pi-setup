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
import { dirname } from "node:path";
import { describeDecision, evaluateClaim } from "./policy.ts";
import { classifyPath, suggestGrant } from "./paths.ts";
import { claimSetFor, displayPath, type PathRequest } from "./tool-paths.ts";
import type {
  Claim,
  PathClaim,
  ScopeDecision,
  ScopeEffect,
  ScopeRoot,
  ScopeRule,
  ScopeState,
  ScopeSuggestion,
  UnknownClaim,
} from "./types.ts";
import type { ClaimSnapshot, DecisionRecord } from "./telemetry.ts";
import type { SandboxBoundary } from "./sandbox/policy.ts";

export interface AskRequest {
  tool: string;
  display: string;
  /**
   * The canonical target of the claim.
   *
   * The dialog needs it because `display` is workspace-relative whenever it can
   * be, while an "always allow this one file" answer has to store an absolute
   * path; deriving it from `suggestion.path` would store the containing folder.
   */
  absolute: string;
  write: boolean;
  reason: string;
  suggestion: ScopeSuggestion;
  /**
   * Set when the call is an opaque shell construct, so there is no directory to
   * grant. The narrowest standing answer is a rule scoped to the command's
   * leading word (`find *`), and it is only offered when it actually narrows the
   * call: for `bash -c ...` every rule would be tool-wide, so none is offered.
   */
  commandRule?: { action: string; resource: string };
  /** How many other calls are already waiting behind this one. */
  queued: number;
}

export type AskAnswer =
  | { kind: "once" }
  /**
   * A standing grant.
   *
   * `persist: "workspace"` means the user asked for it to outlive the session,
   * so `onPersistGrant` writes it to the project config. The session root is
   * still added: the call in flight must pass its own re-check whether or not
   * the file write lands.
   */
  | { kind: "allow"; grant: ScopeSuggestion; persist?: "workspace" }
  /**
   * `feedback` is opencode's `CorrectedError`: a denial that carries what to do
   * instead. A plain deny ends the attempt; a deny with a note lets the model
   * correct itself rather than retry the same thing blind.
   */
  | { kind: "deny"; feedback?: string }
  | { kind: "rule"; text: string }
  /** No UI could ask. Distinct from "deny" so the model gets a usable reason. */
  | { kind: "unavailable"; message: string };

export interface GateResult {
  block: true;
  reason: string;
  /** The user's correction, when the denial came with instructions. */
  feedback?: string;
}

/** What a policy hook knows about the decision it is looking at. */
export interface EvaluateContext {
  tool: string;
  /** The claim that produced this decision. */
  claim: Claim;
  /**
   * `recheck` is a re-evaluation after an answer landed, not a fresh verdict.
   * Both must agree, or a "yes" would approve a call that policy still narrows
   * on its own.
   */
  phase: "initial" | "recheck";
}

/**
 * opencode's `permission.evaluate` hook: the last word on a computed effect.
 *
 * `evaluateClaim` knows paths, postures and roots. It cannot know policy that is
 * not about a path — a yolo arm, a read-only phase, a team's extra rules. Return
 * an effect to replace the computed one, or `undefined` to keep it.
 */
export type EvaluateHook = (decision: ScopeDecision, context: EvaluateContext) => ScopeEffect | undefined;

export interface GateDeps {
  state: () => ScopeState;
  setState: (state: ScopeState) => void;
  cwd: () => string;
  /**
   * Where a bash call actually runs, once Pi's configured command prefix is
   * applied. A `cd` in that prefix moves the directory every relative claim
   * resolves against, so the gate must use the same base the process will use.
   * Optional: without it, the session cwd is the base.
   */
  baseFor?: (command: unknown) => { base: string; opaque?: string };
  /** Ask the user. Rejecting/returning `undefined` means deny. */
  ask: (request: AskRequest) => Promise<AskAnswer | undefined>;
  /** Record a grant that must outlive this call (branch / config / audit). */
  onGrant?: (grant: { root: ScopeRoot; rule?: ScopeRule }) => void;
  /**
   * Write a grant the user asked to keep "for this workspace".
   *
   * Separate from `onGrant` on purpose: the branch snapshot reinforces a session
   * answer, while this one has to reach the project's config file so a *new*
   * session starts with it already granted.
   */
  onPersistGrant?: (grant: ScopeSuggestion) => void;
  /**
   * Is this a delegated child session?
   *
   * A child has no user watching its pane, so a question must go up the ladder —
   * `agent_ping` → the orchestrator → `agent_escalate` — instead of opening a
   * dialog nobody will answer. The caller answers with `scope_answer`.
   */
  isChild?: () => boolean;
  /** Called for every question the gate had to ask (audit / sidebar). */
  onAsk?: (request: AskRequest) => void;
  /** Called for every automatic approval while yolo is armed. */
  onAutoApprove?: (decision: ScopeDecision, claim: PathClaim | undefined) => void;
  /**
   * Called once per claim with the verdict it finally received.
   *
   * Unlike `onAsk`/`onAutoApprove`, which mark the two exceptional outcomes, this
   * sees the ordinary internal allow too: the point is a complete record of what
   * the gate judged, so a later pass can tune detection and find false positives.
   * A throwing hook cannot change the verdict.
   */
  onDecision?: (record: DecisionRecord) => void;
  /**
   * Policy that is not about a path, consulted for every decision the gate makes
   * including the re-checks inside the question lane.
   *
   * It may tighten or relax `allow`/`ask`. It is never consulted about `deny`:
   * deny is the promise that no grant, yolo arm or hook re-opens what the user
   * closed. opencode's plugin hook *can* flip a deny into an allow; this one
   * deliberately cannot.
   */
  onEvaluate?: EvaluateHook;
  /**
   * Armed-sandbox context attached to every decision record, so telemetry can
   * say under which frontend a verdict was made.
   */
  sandbox?: () => { backend: string; mode: string; degraded?: boolean } | undefined;
  /**
   * The bash ask lane, as the caller sees the sandbox.
   *
   * `"refusal"` means an armed backend is available, so bash pre-flight
   * questions (path claims and the opaque-command ask) are suppressed: bash
   * runs sandboxed, the kernel refuses the outside write, and the refusal
   * becomes the question through `handleRefusal`. Never consulted for deny —
   * deny is re-checked in every lane and always wins.
   */
  bashAskLane?: () => "ask" | "refusal";
  /**
   * What the armed sandbox can actually write, consulted by every evaluation.
   *
   * Supplying it keeps the gate and the kernel answering the same question the
   * same way: without it, the table's own temp/device silences would approve
   * writes the kernel is about to refuse. Return `undefined` when no boundary is
   * enforced (sandbox off, or a degraded backend running bare).
   */
  sandboxBoundary?: () => SandboxBoundary | undefined;
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

/**
 * The path a kernel sandbox needs in order to honour an approval.
 *
 * Landlock and bwrap allow writes *beneath* a path, so approving a file that
 * does not exist yet needs its directory: a `--rw <file>` grant approves the
 * name and still refuses creating it. Writing at `/` is never the answer.
 */
function sandboxGrantFor(absolute: string): readonly string[] {
  const parent = dirname(absolute);
  return parent && parent !== "/" && parent !== absolute ? [parent] : [];
}

export interface RefusalOutcome {
  allowed: boolean;
  reason?: string;
  grantSummary?: string;
  /**
   * Paths the answered question just approved, to be added to the next wrap.
   * A gate rule cannot widen the kernel, so a rule answer grants nothing here.
   */
  granted?: readonly string[];
  /**
   * Whether retrying the command can actually succeed.
   *
   * A trailer may only say "retry" when this is true; an approval that never
   * reaches the sandbox is exactly the loop this field exists to end.
   */
  retrySafe: boolean;
}

export interface Gate {
  claimsFor: (tool: string, input: Record<string, unknown> | undefined) => ReturnType<typeof claimSetFor>;
  gate: (tool: string, input: Record<string, unknown> | undefined) => Promise<GateResult | undefined>;
  evaluate: (claim: PathClaim) => ScopeDecision;
  handleRefusal: (tool: string, absolutePath: string) => Promise<RefusalOutcome>;
  queue: SerialQueue;
}

const DENY_HINT = "Ask for a path inside the workspace, or run /scope allow <path> to grant it.";

/**
 * The recorded reason when an armed sandbox takes over the bash ask lane
 * (`sandbox.ask: "refusal"`): the kernel refuses the write and the refusal
 * becomes the question, so the pre-flight parser question is suppressed.
 */
const SANDBOX_REFUSAL_REASON = "sandbox refusal mode: bash runs kernel-sandboxed; an outside write will be refused and asked afterwards";
/**
 * The hint on an opaque-command decision.
 *
 * The path hint is the wrong instruction here: nothing about the construct is a
 * path question, and the old hint sent the model to a blanket tool-wide rule.
 */
const COMMAND_HINT = "Restructure the command (a script file, explicit paths), or run /scope rules to see what is in force.";

/** The word a standing rule should lead with: `find . -exec rm {} \;` -> `find`. */
function commandHead(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  const first = command.trim().split(/\s+/)[0];
  if (!first) return undefined;
  const bare = first.split("/").pop() ?? first;
  return bare.replace(/^["']|["']$/g, "") || undefined;
}

/**
 * The part of a tool call worth recording: the shell command, or the path the
 * tool names. File contents and edit bodies are deliberately never included.
 */
function summarizeInput(tool: string, input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const keys = tool === "bash" ? ["command"] : ["path", "file_path", "pattern", "query", "dir", "directory"];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/**
 * A deny is either "stop" or "no, do this instead".
 *
 * opencode splits the two: a reject without a message is a typed failure that
 * ends the step, a reject with a message is feedback the model reads and acts
 * on. The difference is only whether the user left a note, so the note replaces
 * the generic hint instead of sitting next to it — two competing instructions
 * are worse than one.
 */
function denyResult(tool: string, target: string, feedback?: string): GateResult {
  const instruction = feedback?.trim();
  if (!instruction) {
    return { block: true, reason: `Scope: ${tool} was denied access to ${target}. ${DENY_HINT}` };
  }
  return {
    block: true,
    reason: `Scope: ${tool} was denied access to ${target}. Do this instead: ${instruction}`,
    feedback: instruction,
  };
}

export function createGate(deps: GateDeps): Gate {
  const queue = new SerialQueue();

  const claimsFor = (tool: string, input: Record<string, unknown> | undefined) => {
    // A prefix whose directory cannot be resolved makes the call unjudgeable: the
    // relative paths could mean anything, so it is reported instead of guessed.
    const effective = tool === "bash" ? deps.baseFor?.(input?.command) : undefined;
    if (effective?.opaque) {
      return { paths: [], unknown: true, opaque: effective.opaque, reason: effective.opaque };
    }
    return claimSetFor(tool, input, { cwd: effective?.base ?? deps.cwd() });
  };

  function toPathClaim(tool: string, request: PathRequest): PathClaim {
    // A `cd` earlier in the command moves what a later relative path means.
    const classified = classifyPath(request.base ?? deps.cwd(), deps.state().roots, request.raw);
    return {
      tool,
      action: request.action,
      absolute: classified.absolute,
      resource: classified.resource,
      write: request.write,
      posture: request.posture,
      external: classified.external,
      kind: request.kind,
      ...(request.command ? { command: request.command } : {}),
      ...(request.base ? { base: request.base } : {}),
    };
  }

  /**
   * Apply the policy hook to a computed decision.
   *
   * A hook that throws keeps the decision it could not improve: a policy plugin
   * that crashes must not become a silent allow.
   */
  function withHook(decision: ScopeDecision, context: EvaluateContext): ScopeDecision {
    const hook = deps.onEvaluate;
    if (!hook || decision.effect === "deny") return decision;
    let effect: ScopeEffect | undefined;
    try {
      effect = hook(decision, context);
    } catch {
      return decision;
    }
    if (!effect || effect === decision.effect) return decision;
    return { ...decision, effect, reason: `${decision.reason} (policy hook: ${effect})` };
  }

  function denied(tool: string, decision: ScopeDecision): GateResult {
    return { block: true, reason: `Scope: ${decision.reason}. ${tool} was not run. ${DENY_HINT}` };
  }

  /**
   * Evaluate one claim with the armed sandbox's boundary attached.
   *
   * Every evaluation goes through here: a decision reached without the boundary
   * is a decision that can disagree with the kernel.
   */
  function decideClaim(claim: Claim, tool: string, phase: EvaluateContext["phase"]): ScopeDecision {
    return withHook(evaluateClaim(claim, deps.state(), { sandbox: deps.sandboxBoundary?.() }), { tool, claim, phase });
  }

  async function askFor(tool: string, claim: PathClaim, decision: ScopeDecision): Promise<AskAnswer> {
    const suggestion = suggestGrant(claim.absolute, {
      cwd: deps.cwd(),
      home: process.env.HOME ?? process.env.USERPROFILE,
      kind: claim.kind,
      access: claim.write ? "rw" : "ro",
    });
    if (deps.isChild?.()) return escalate(tool, claim, suggestion);
    const request: AskRequest = {
      tool,
      display: displayPath(deps.cwd(), claim.absolute),
      absolute: claim.absolute,
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

  /**
   * What a child is told instead of a question.
   *
   * The child does not contact the user itself — that is the same ladder
   * `lib/orchestrator/handoff.ts` states for every other uncertainty — so the
   * block carries the exact ask, the narrowest grant, and the tool that applies
   * the answer.
   */
  function escalate(tool: string, claim: PathClaim, suggestion: ScopeSuggestion): AskAnswer {
    const need = claim.posture === "read" ? "read" : "write";
    return {
      kind: "unavailable",
      message:
        `Scope: ${tool} needs ${need} access to ${claim.absolute}, which is outside the workspace. ` +
        `Do not ask the user: ask your parent with agent_ping and then apply the answer.\n` +
        `  agent_ping({ message: "scope: ${tool} wants ${need} ${claim.absolute} — allow-once, allow-folder (${suggestion.glob}), or deny?" })\n` +
        `  scope_answer({ decision: "allow-once" | "allow-folder" | "deny", path: "${claim.absolute}", access: "${claim.write ? "rw" : "ro"}", feedback?: "…" })\n` +
        `When the answer is deny, pass \`feedback\` with what to do instead; the retry then gets your instruction instead of a bare refusal.\n` +
        `Nothing was run.`,
    };
  }

  function escalateUnknown(tool: string): AskAnswer {
    return {
      kind: "unavailable",
      message:
        `Scope: ${tool} contains a construct this gate cannot analyse, so its filesystem effect is unknown. ` +
        `Do not ask the user: agent_ping your parent for a decision, then apply it with ` +
        `scope_answer, or ask them for a rule that covers the command.`,
    };
  }

  /**
   * Add a root, upgrading `ro` to `rw` when the user asked for more.
   *
   * Without the upgrade a second "allow read-write" answer on an already
   * read-only folder would change nothing and the call would ask again forever.
   */
  function grantsRoot(state: ScopeState, root: ScopeRoot): ScopeState | undefined {
    const existing = state.roots.find(candidate => candidate.path === root.path);
    if (!existing) return { ...state, roots: [...state.roots, root] };
    if (existing.access !== "ro" || root.access !== "rw") return undefined;
    return { ...state, roots: state.roots.map(candidate => (candidate.path === root.path ? { ...candidate, access: "rw" } : candidate)) };
  }

  function applyAnswer(answer: AskAnswer, claim: PathClaim): void {
    if (answer.kind === "allow") {
      const root: ScopeRoot = {
        path: answer.grant.path,
        access: answer.grant.access,
        source: "session",
      };
      const next = grantsRoot(deps.state(), root);
      if (next) {
        deps.setState(next);
        deps.onGrant?.({ root });
      }
      if (answer.persist === "workspace") deps.onPersistGrant?.(answer.grant);
      return;
    }
    if (answer.kind === "rule") {
      const rule = parseRule(answer.text, claim.resource);
      const state = deps.state();
      // Repeating an answer that is already stored must not stack a second copy:
      // `resolveRule` is last-match-wins, so a duplicate can later shadow the rule
      // it duplicates and make a narrowing edit appear to do nothing.
      const duplicate = state.rules.some(existing =>
        existing.action === rule.action && existing.resource === rule.resource && existing.effect === rule.effect);
      if (duplicate) return;
      const rules = [...state.rules, rule];
      deps.setState({ ...state, rules });
      deps.onGrant?.({ root: { path: "", access: "ro", source: "session" }, rule });
    }
  }

  /** Flatten a claim for the telemetry record. */
  function claimSnapshot(claim: PathClaim): ClaimSnapshot {
    return {
      action: claim.action,
      absolute: claim.absolute,
      resource: claim.resource,
      write: claim.write,
      posture: claim.posture,
      external: claim.external,
      kind: claim.kind,
      ...(claim.command ? { command: claim.command } : {}),
      ...(claim.base ? { base: claim.base } : {}),
    };
  }

  /**
   * Emit one telemetry record for a verdict that has already been reached.
   *
   * A sink that throws keeps the verdict it was told about: diagnostics must not
   * become a policy, and a read-only telemetry destination must not block a tool.
   */
  function report(record: Omit<DecisionRecord, "cwd"> & { decision?: ScopeDecision; claim?: PathClaim }): void {
    const hook = deps.onDecision;
    if (!hook) return;
    const { decision, claim, ...rest } = record;
    const state = deps.state();
    const sandbox = deps.sandbox?.();
    const stored: DecisionRecord = {
      ...rest,
      ...(sandbox ? { sandbox } : {}),
      // The gate is the producer of these records; `scope_answer` and `/scope`
      // commands set their own source at the call site.
      source: rest.source ?? "gate",
      cwd: deps.cwd(),
      // An explicitly-passed reason wins: callers that also pass a decision
      // carry the same verdict text, but the sandbox refusal lane records a
      // deliberate note instead of the ask decision's own question.
      reason: rest.reason ?? decision?.reason,
      ...(claim ? { claim: claimSnapshot(claim) } : {}),
      ...(decision?.rule ? { rule: decision.rule } : {}),
      ...(decision?.root ? { root: decision.root } : {}),
      ...(decision && state.yolo && decision.reason.includes("(yolo") ? { yolo: state.yolo.strength } : {}),
      state: {
        roots: state.roots.length,
        rules: state.rules.length,
        ...(state.yolo ? { yolo: state.yolo.strength } : {}),
        external: state.defaults.external,
        readExternal: state.defaults.readExternal,
      },
    };
    try {
      hook(stored);
    } catch {
      // A broken sink is not a verdict: swallow it and keep the decision.
    }
  }

  async function gate(tool: string, input: Record<string, unknown> | undefined): Promise<GateResult | undefined> {
    const claimSet = claimsFor(tool, input);
    const inputText = summarizeInput(tool, input);
    if (claimSet.unknown) {
      // A command the scanner cannot analyse is a parser limit, not a verdict:
      // name it, and let a rule cover it, instead of letting it read as suspicion.
      const opaque = claimSet.opaque;
      const unknownClaim: UnknownClaim = { tool, unknown: true };
      const decide = (phase: EvaluateContext["phase"]) => decideClaim(unknownClaim, tool, phase);
      const decision = decide("initial");
      if (decision.effect === "deny") {
        report({ tool, input: inputText, effect: "deny", asked: false, unknown: true, ...(opaque ? { opaque } : {}), reason: decision.reason, decision });
        return { block: true, reason: `Scope: ${claimSet.reason ?? decision.reason}. ${tool} was not run. ${DENY_HINT}` };
      }
      if (decision.effect === "allow") {
        const auto = Boolean(deps.state().yolo && decision.reason.includes("(yolo"));
        if (auto) deps.onAutoApprove?.(decision, undefined);
        report({ tool, input: inputText, effect: "allow", asked: false, auto, unknown: true, ...(opaque ? { opaque } : {}), reason: decision.reason, decision });
        return undefined;
      }
      if (tool === "bash" && deps.bashAskLane?.() === "refusal") {
        report({ tool, input: inputText, effect: "allow", asked: false, unknown: true, ...(opaque ? { opaque } : {}), reason: SANDBOX_REFUSAL_REASON, decision });
        return undefined;
      }
      return queue.run(async () => {
        // Re-evaluate inside the lane: an earlier answer may have covered this.
        const again = decide("recheck");
        if (again.effect === "allow") {
          report({ tool, input: inputText, effect: "allow", asked: false, unknown: true, ...(opaque ? { opaque } : {}), reason: again.reason, decision: again });
          return undefined;
        }
        if (again.effect === "deny") {
          report({ tool, input: inputText, effect: "deny", asked: false, unknown: true, ...(opaque ? { opaque } : {}), reason: again.reason, decision: again });
          return { block: true, reason: `Scope: ${again.reason}. ${tool} was not run. ${COMMAND_HINT}` };
        }
        const head = commandHead(input?.command);
        // Only offer a rule that narrows. For `bash -c ...` the head is the tool
        // itself, so any rule would be tool-wide; the dialog offers none and the
        // block below says to restructure instead of granting everything.
        const commandRule = head && head !== tool ? { action: tool, resource: `${head} *` } : undefined;
        const request: AskRequest = {
          tool,
          display: "(command cannot be analysed)",
          absolute: deps.cwd(),
          write: true,
          reason: claimSet.reason ?? again.reason,
          suggestion: { path: deps.cwd(), access: "ro", glob: deps.cwd(), exact: true },
          ...(commandRule ? { commandRule } : {}),
          queued: Math.max(0, queue.size - 1),
        };
        deps.onAsk?.(request);
        const answer = deps.isChild?.() ? escalateUnknown(tool) : await deps.ask(request).catch(() => undefined);
        const asked = true;
        if (answer?.kind === "rule") {
          applyAnswer(answer, { tool, action: tool, absolute: deps.cwd(), resource: "*", write: false, posture: "unknown", external: true, kind: "unknown" });
          // A rule that names the tool is the standing grant for "unknown paths".
          const after = decide("recheck");
          if (after.effect === "allow") {
            report({ tool, input: inputText, effect: "allow", asked, answer: "rule", unknown: true, ...(opaque ? { opaque } : {}), reason: after.reason, decision: after });
            return undefined;
          }
          if (after.effect === "deny") {
            report({ tool, input: inputText, effect: "deny", asked, answer: "rule", unknown: true, ...(opaque ? { opaque } : {}), reason: after.reason, decision: after });
            return { block: true, reason: `Scope: ${after.reason}. ${tool} was not run. ${COMMAND_HINT}` };
          }
        }
        if (answer?.kind === "unavailable") {
          report({ tool, input: inputText, effect: "deny", asked, answer: deps.isChild?.() ? "escalated" : "no-answer", unknown: true, ...(opaque ? { opaque } : {}), reason: again.reason, decision: again });
          return { block: true, reason: answer.message };
        }
        if (answer?.kind === "once") {
          report({ tool, input: inputText, effect: "allow", asked, answer: "once", unknown: true, ...(opaque ? { opaque } : {}), reason: again.reason, decision: again });
          return undefined;
        }
        if (answer?.kind === "deny" && answer.feedback?.trim()) {
          report({ tool, input: inputText, effect: "deny", asked, answer: "deny-feedback", unknown: true, ...(opaque ? { opaque } : {}), reason: again.reason, decision: again });
          return denyResult(tool, "an unreadable command", answer.feedback);
        }
        report({
          tool,
          input: inputText,
          effect: "deny",
          asked,
          answer: answer?.kind === "deny" ? "deny" : "no-answer",
          unknown: true,
          ...(opaque ? { opaque } : {}),
          reason: again.reason,
          decision: again,
        });
        return {
          block: true,
          reason:
            `Scope: ${tool} was not run; ${opaque ?? "the command could not be analysed"}. ` +
            `${
              commandRule
                ? `The narrowest standing grant is the rule {"action":"${tool}","resource":"${commandRule.resource}","effect":"allow"}.`
                : `No narrow rule exists for this construct: restructure it into a script file with explicit paths instead of granting every ${tool} command.`
            } ${COMMAND_HINT}`,
        };
      });
    }

    for (const request of claimSet.paths) {
      const claim = toPathClaim(tool, request);
      const decision = decideClaim(claim, tool, "initial");
      if (decision.effect === "deny") {
        report({ tool, input: inputText, effect: "deny", asked: false, reason: decision.reason, decision, claim });
        return denied(tool, decision);
      }
      if (decision.effect === "allow") {
        const auto = Boolean(deps.state().yolo && decision.reason.includes("(yolo"));
        if (auto) deps.onAutoApprove?.(decision, claim);
        report({ tool, input: inputText, effect: "allow", asked: false, auto, reason: decision.reason, decision, claim });
        continue;
      }
      if (tool === "bash" && deps.bashAskLane?.() === "refusal") {
        report({ tool, input: inputText, effect: "allow", asked: false, reason: SANDBOX_REFUSAL_REASON, decision, claim });
        continue;
      }
      const result = await queue.run(async (): Promise<GateResult | undefined> => {
        const claimed = toPathClaim(tool, request);
        const again = decideClaim(claimed, tool, "recheck");
        if (again.effect === "allow") {
          report({ tool, input: inputText, effect: "allow", asked: false, reason: again.reason, decision: again, claim: claimed });
          return undefined;
        }
        if (again.effect === "deny") {
          report({ tool, input: inputText, effect: "deny", asked: false, reason: again.reason, decision: again, claim: claimed });
          return denied(tool, again);
        }
        const answer = await askFor(tool, claimed, again);
        if (answer.kind === "unavailable") {
          report({
            tool,
            input: inputText,
            effect: "deny",
            asked: true,
            answer: deps.isChild?.() ? "escalated" : "no-answer",
            reason: again.reason,
            decision: again,
            claim: claimed,
          });
          return { block: true, reason: answer.message };
        }
        if (answer.kind === "deny") {
          report({
            tool,
            input: inputText,
            effect: "deny",
            asked: true,
            answer: answer.feedback?.trim() ? "deny-feedback" : "deny",
            reason: again.reason,
            decision: again,
            claim: claimed,
          });
          return denyResult(tool, claimed.absolute, answer.feedback);
        }
        if (answer.kind === "once") {
          report({ tool, input: inputText, effect: "allow", asked: true, answer: "once", reason: again.reason, decision: again, claim: claimed });
          return undefined;
        }
        applyAnswer(answer, claimed);
        const after = decideClaim(claimed, tool, "recheck");
        report({
          tool,
          input: inputText,
          effect: after.effect,
          asked: true,
          answer: answer.kind === "allow" ? (answer.persist === "workspace" ? "allow-workspace" : "allow-session") : "rule",
          reason: after.reason,
          decision: after,
          claim: claimed,
        });
        return after.effect === "allow" ? undefined : denied(tool, after);
      });
      if (result) return result;
    }
    return undefined;
  }

  const evaluate = (claim: PathClaim): ScopeDecision => decideClaim(claim, claim.tool, "initial");

  async function handleRefusal(tool: string, absolutePath: string): Promise<RefusalOutcome> {
    const classified = classifyPath(deps.cwd(), deps.state().roots, absolutePath);
    const claim: PathClaim = {
      tool,
      action: tool,
      absolute: classified.absolute,
      resource: classified.resource,
      write: true,
      posture: "write",
      external: classified.external,
      kind: "unknown",
    };

    const decision = decideClaim(claim, tool, "initial");
    if (decision.effect === "deny") {
      report({ tool, input: absolutePath, effect: "deny", asked: false, reason: decision.reason, decision, claim });
      return { allowed: false, reason: decision.reason, retrySafe: false };
    }
    if (decision.effect === "allow") {
      const auto = Boolean(deps.state().yolo && decision.reason.includes("(yolo"));
      if (auto) deps.onAutoApprove?.(decision, claim);
      report({ tool, input: absolutePath, effect: "allow", asked: false, auto, reason: decision.reason, decision, claim });
      // The gate approved it, but the kernel still refused: widen the next wrap
      // so the retry can succeed. Saying "retry" without this is the loop.
      const granted = sandboxGrantFor(claim.absolute);
      return {
        allowed: true,
        grantSummary: "allowed by existing rule or yolo",
        granted,
        retrySafe: granted.length > 0,
      };
    }

    return await queue.run(async (): Promise<RefusalOutcome> => {
      const again = decideClaim(claim, tool, "recheck");
      if (again.effect === "allow") {
        report({ tool, input: absolutePath, effect: "allow", asked: false, reason: again.reason, decision: again, claim });
        const granted = sandboxGrantFor(claim.absolute);
        return { allowed: true, grantSummary: "allowed by prior grant", granted, retrySafe: granted.length > 0 };
      }
      if (again.effect === "deny") {
        report({ tool, input: absolutePath, effect: "deny", asked: false, reason: again.reason, decision: again, claim });
        return { allowed: false, reason: again.reason, retrySafe: false };
      }

      const answer = await askFor(tool, claim, again);
      if (answer.kind === "unavailable") {
        report({
          tool,
          input: absolutePath,
          effect: "deny",
          asked: true,
          answer: deps.isChild?.() ? "escalated" : "no-answer",
          reason: again.reason,
          decision: again,
          claim,
        });
        return { allowed: false, reason: answer.message, retrySafe: false };
      }
      if (answer.kind === "deny") {
        report({
          tool,
          input: absolutePath,
          effect: "deny",
          asked: true,
          answer: answer.feedback?.trim() ? "deny-feedback" : "deny",
          reason: again.reason,
          decision: again,
          claim,
        });
        return { allowed: false, reason: answer.feedback ?? again.reason, retrySafe: false };
      }
      if (answer.kind === "once") {
        report({ tool, input: absolutePath, effect: "allow", asked: true, answer: "once", reason: again.reason, decision: again, claim });
        const granted = sandboxGrantFor(claim.absolute);
        return { allowed: true, grantSummary: "allowed once", granted, retrySafe: granted.length > 0 };
      }

      applyAnswer(answer, claim);
      const after = decideClaim(claim, tool, "recheck");
      const summary = answer.kind === "allow"
        ? `allowed for ${answer.grant.exact ? "this file" : "this folder"} (${answer.persist === "workspace" ? "workspace config" : "this session"})`
        : `rule added: ${answer.text}`;
      report({
        tool,
        input: absolutePath,
        effect: after.effect,
        asked: true,
        answer: answer.kind === "allow" ? (answer.persist === "workspace" ? "allow-workspace" : "allow-session") : "rule",
        reason: after.reason,
        decision: after,
        claim,
      });
      const granted = answer.kind === "allow" ? [answer.grant.path] : [];
      return {
        allowed: after.effect === "allow",
        reason: after.reason,
        grantSummary: summary,
        granted,
        retrySafe: after.effect === "allow" && granted.length > 0,
      };
    });
  }

  return { claimsFor, gate, evaluate, handleRefusal, queue };
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
