import type { ScopedChild, ScopeRegistry } from "./scope-registry.ts";

export type SteerOutcome =
  | "interrupt"
  | "queue"
  | "ambiguous"
  | "nonexistent"
  | "gone"
  | "blocked-owner"
  | "unauthorized";

export interface MatchLadderEvidence {
  level: "L0" | "L1" | "L2" | "L3" | "L4";
  signal: string;
  detail: string;
}

export interface SteerResolution {
  outcome: SteerOutcome;
  target?: ScopedChild;
  candidates: ScopedChild[];
  evidence?: MatchLadderEvidence;
  reason: string;
  suggestedAction?: string;
  inventory?: Array<{ id: string; name: string; scope: string; status: string }>;
  questions?: string[];
}

export interface MatchOwnerOptions {
  id?: string;
  name?: string;
  scope?: string;
  origin: "user" | "orchestrator";
  queue?: boolean;
}

/**
 * Extracts possible file paths from text.
 * Matches strings looking like paths (contains '/' or file extension '.ts', '.js', etc.)
 */
export function extractPotentialPaths(text: string): string[] {
  const words = text.split(/\s+/);
  const paths: string[] = [];
  for (const raw of words) {
    // Strip wrapping punctuation like quotes, backticks, parens
    const w = raw.replace(/^[`'"(\[]+|[`'")\],:;.]+$/g, "");
    if (!w) continue;
    if (w.includes("/") || /\.[a-zA-Z0-9_-]{1,10}$/.test(w)) {
      paths.push(w);
    }
  }
  return paths;
}

/**
 * Deterministic match ladder (D5): pure function, no I/O, no model guessing.
 */
export function matchOwner(
  update: string,
  scopes: ScopeRegistry,
  options: MatchOwnerOptions
): SteerResolution {
  const allChildren = scopes.getAllChildren();
  const runningChildren = scopes.getRunningChildren();

  // Inventory of current children for escalation
  const inventory = allChildren.map((c) => ({
    id: c.id,
    name: c.name,
    scope: c.scope,
    status: c.status,
  }));

  const questionsForNonexistent = [
    "1. New work: spawn a new subagent with a dedicated spec for this task.",
    "2. Vision change: update the global vision artifact and re-broadcast to affected scopes.",
    "3. Spec contradiction: revise the assigned lane and criteria if this belongs to an existing scope.",
    "4. False premise: this target does not exist; verify running subagents with /sv2 or sv2_running.",
  ];

  let candidates: ScopedChild[] = [];
  let evidence: MatchLadderEvidence | undefined;

  // ── L0: explicit id / exact name ──────────────────────────────────────────
  if (options.id) {
    const found = allChildren.find((c) => c.id === options.id);
    if (found) {
      candidates = [found];
      evidence = {
        level: "L0",
        signal: `Explicit ID: ${options.id}`,
        detail: `Matched child ${found.name} (${found.id})`,
      };
    }
  } else if (options.name) {
    const found = allChildren.filter(
      (c) => c.name.toLowerCase() === options.name!.toLowerCase()
    );
    if (found.length > 0) {
      candidates = found;
      evidence = {
        level: "L0",
        signal: `Explicit Name: ${options.name}`,
        detail: `Matched ${found.length} child(ren) by name`,
      };
    }
  } else {
    // Check if update text explicitly contains a known child ID or exact name
    for (const child of allChildren) {
      const idRegex = new RegExp(`\\b${escapeRegExp(child.id)}\\b`, "i");
      const nameRegex = new RegExp(`\\b${escapeRegExp(child.name)}\\b`, "i");
      if (idRegex.test(update)) {
        candidates.push(child);
        evidence = {
          level: "L0",
          signal: `Child ID in text: ${child.id}`,
          detail: `Matched child ${child.name} (${child.id})`,
        };
        break;
      } else if (nameRegex.test(update)) {
        candidates.push(child);
        evidence = {
          level: "L0",
          signal: `Child name in text: ${child.name}`,
          detail: `Matched child ${child.name}`,
        };
      }
    }
  }

  // ── L1: scope token in the update (word-boundary on {work-name}) ───────────
  if (candidates.length === 0) {
    if (options.scope) {
      const inScope = allChildren.filter(
        (c) => c.scope.toLowerCase() === options.scope!.toLowerCase()
      );
      if (inScope.length > 0) {
        candidates = inScope;
        evidence = {
          level: "L1",
          signal: `Scope option: ${options.scope}`,
          detail: `Matched ${inScope.length} child(ren) in scope ${options.scope}`,
        };
      }
    } else {
      // Find all scopes known to registry
      const knownScopes = new Set(allChildren.map((c) => c.scope));
      const matchedScopes: string[] = [];
      const inScopeMatches: ScopedChild[] = [];
      for (const scope of knownScopes) {
        // Use lookaround to ensure it's a bare scope token and not e.g. scope.spec or scope.spec.md
        const scopeRegex = new RegExp(`(?<![\\w.-])${escapeRegExp(scope)}(?![\\w.-])`, "i");
        if (scopeRegex.test(update)) {
          matchedScopes.push(scope);
          const inScope = allChildren.filter(
            (c) => c.scope.toLowerCase() === scope.toLowerCase()
          );
          for (const child of inScope) {
            if (!inScopeMatches.some((m) => m.id === child.id)) {
              inScopeMatches.push(child);
            }
          }
        }
      }
      if (inScopeMatches.length > 0) {
        candidates = inScopeMatches;
        evidence = {
          level: "L1",
          signal: `Scope token in text: ${matchedScopes.join(", ")}`,
          detail: `Matched ${candidates.length} child(ren) in scope(s) ${matchedScopes.join(", ")}`,
        };
      }
    }
  }

  // ── L2: a path in update falls inside a child's declared lane ─────────────
  if (candidates.length === 0) {
    const extractedPaths = extractPotentialPaths(update);
    const matchedOwners = new Map<string, ScopedChild>();
    const matchedPaths: string[] = [];
    for (const path of extractedPaths) {
      const laneMatches = scopes.resolveLaneForPath(path);
      if (laneMatches.length > 0) {
        matchedPaths.push(path);
        for (const match of laneMatches) {
          matchedOwners.set(match.id, match);
        }
      }
    }
    if (matchedOwners.size > 0) {
      candidates = Array.from(matchedOwners.values());
      evidence = {
        level: "L2",
        signal: `Path in declared lane: ${matchedPaths.join(", ")}`,
        detail: `Matched declared lane(s) for ${candidates.map((m) => m.name).join(", ")}`,
      };
    }
  }

  // ── L3: a path matches Milestone.files[] for exactly one child ────────────
  if (candidates.length === 0) {
    const extractedPaths = extractPotentialPaths(update);
    const matchedOwners = new Map<string, ScopedChild>();
    const matchedPaths: string[] = [];
    for (const path of extractedPaths) {
      const normPath = path.replace(/^\.?\//, "");
      const milestoneMatches = runningChildren.filter((c) =>
        (c.lastMilestoneFiles || []).some((f) => f.replace(/^\.?\//, "") === normPath)
      );
      if (milestoneMatches.length > 0) {
        matchedPaths.push(path);
        for (const match of milestoneMatches) {
          matchedOwners.set(match.id, match);
        }
      }
    }
    if (matchedOwners.size > 0) {
      candidates = Array.from(matchedOwners.values());
      evidence = {
        level: "L3",
        signal: `Path matches last milestone files: ${matchedPaths.join(", ")}`,
        detail: `Matched milestone files for ${candidates.map((m) => m.name).join(", ")}`,
      };
    }
  }

  // ── L4: update names an artifact id belonging to one scope ────────────────
  if (candidates.length === 0) {
    for (const child of allChildren) {
      const specArtifact = `${child.scope}.spec`;
      const specArtifactMd = `${child.scope}.spec.md`;
      const matchesSpec = update.includes(specArtifact) || update.includes(specArtifactMd);
      const matchesCustom = child.artifactIds?.some((artId) => {
        const regex = new RegExp(`(?<![\\w.-])${escapeRegExp(artId)}(?![\\w.-])`, "i");
        return regex.test(update);
      });
      if (matchesSpec || matchesCustom) {
        candidates.push(child);
        evidence = {
          level: "L4",
          signal: `Artifact id for scope: ${child.scope}`,
          detail: `Matched spec or artifact belonging to scope ${child.scope}`,
        };
      }
    }
  }

  // ── Outcome Evaluation ───────────────────────────────────────────────────

  // 0 candidates -> nonexistent
  if (candidates.length === 0) {
    return {
      outcome: "nonexistent",
      candidates: [],
      reason: "No running or known subagent matches the given update.",
      suggestedAction: "Ask user to clarify owner, spawn a new worker, or update vision.",
      inventory,
      questions: questionsForNonexistent,
    };
  }

  // >= 2 candidates -> ambiguous
  if (candidates.length > 1) {
    return {
      outcome: "ambiguous",
      candidates,
      evidence,
      reason: `Ambiguous match: ${candidates.length} subagents match the signal (${evidence?.signal}).`,
      suggestedAction: "Ask user to select the intended subagent from candidates.",
      inventory,
    };
  }

  // Exactly 1 candidate
  const target = candidates[0];

  // Authority check (D6): Orchestrator cannot change target's scope
  if (options.origin === "orchestrator" && options.scope && options.scope !== target.scope) {
    return {
      outcome: "unauthorized",
      target,
      candidates,
      evidence,
      reason: `Orchestrator cannot redirect subagent across scopes (${target.scope} -> ${options.scope}). Escalate to user.`,
      suggestedAction: "Escalate scope modification to user.",
      inventory,
    };
  }

  // Target status checks:
  if (target.status === "completed" || target.status === "failed" || target.status === "closed") {
    return {
      outcome: "gone",
      target,
      candidates,
      evidence,
      reason: `Target subagent ${target.name} (${target.id}) has ended (status: ${target.status}).`,
      suggestedAction: "Ask user whether to resume the ended session or spawn a fresh worker on this scope.",
      inventory,
    };
  }

  if (target.status === "blocked" || target.pendingPing) {
    return {
      outcome: "blocked-owner",
      target,
      candidates,
      evidence,
      reason: `Target subagent ${target.name} (${target.id}) is blocked or awaiting an agent_ping response.`,
      suggestedAction: "Ask user to resolve pending blocker before issuing steering.",
      inventory,
    };
  }

  // Running target:
  // D7: User-origin defaults to "interrupt", orchestrator defaults to "queue"
  let outcome: SteerOutcome = "interrupt";
  if (options.origin === "orchestrator") {
    outcome = "queue";
  } else if (options.queue) {
    outcome = "queue";
  } else {
    outcome = "interrupt";
  }

  return {
    outcome,
    target,
    candidates,
    evidence,
    reason: `Resolved single owner ${target.name} [${target.id}] in scope "${target.scope}" via ${evidence?.level} (${evidence?.signal}).`,
    suggestedAction: outcome === "interrupt" ? "Issue hard interrupt + steer" : "Queue soft steer",
    inventory,
  };
}

export interface ClientLike {
  paneSendKeys(paneId: string, keys: string[]): Promise<void>;
  paneSendText(paneId: string, text: string): Promise<void>;
  /**
   * Herdr's real contract: `paneRead(paneId, lines)` returns the visible pane
   * text, or null when the pane is gone. This used to be typed as
   * `{ tail: string }`, so every call site read `.tail` off a string and
   * confirmed delivery with `undefined` — a steer could be reported as
   * delivered while nothing had been observed.
   */
  paneRead(paneId: string, lines: number): Promise<string | null>;
}

/** Herdr key-combo syntax (not Pi's): `esc`, `enter`. */
export const INTERRUPT_KEY = "esc";
export const SUBMIT_KEY = "enter";

/**
 * Deliver a steer and report only what was actually observed.
 *
 * The interrupt sequence is esc → wait for the prompt to return → text → enter.
 * Typing into a pane that never yielded would interleave with the child's current
 * work, so a prompt that does not settle is reported as `interrupt-failed`
 * instead of being typed over.
 */
export async function deliverSteer(
  client: ClientLike,
  paneId: string,
  mode: "interrupt" | "queue",
  message: string,
  opts: { settleTimeoutMs?: number; pollIntervalMs?: number; lines?: number } = {},
): Promise<{ status: "delivered" | "interrupt-failed"; preTail: string | null; observedTail: string | null; reason?: string }> {
  const settleTimeoutMs = opts.settleTimeoutMs ?? 5_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 400;
  const lines = opts.lines ?? 20;

  const preTail = await client.paneRead(paneId, lines).catch(() => null);

  if (mode === "interrupt") {
    await client.paneSendKeys(paneId, [INTERRUPT_KEY]);
    const deadline = Date.now() + settleTimeoutMs;
    let settled = false;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      // The pane is an interactive TUI: once the turn is interrupted the editor
      // prompt is back, so the tail stops changing. A read failure is not proof
      // of settling, so it keeps waiting until the deadline.
      const now = await client.paneRead(paneId, lines).catch(() => null);
      if (now === null) continue;
      if (now === preTail) {
        settled = true;
        break;
      }
      // Any stable frame counts: compare against the previous observation.
      const again = await client.paneRead(paneId, lines).catch(() => null);
      if (again !== null && again === now) {
        settled = true;
        break;
      }
    }
    if (!settled) {
      return {
        status: "interrupt-failed",
        preTail,
        observedTail: await client.paneRead(paneId, lines).catch(() => null),
        reason:
          `The pane did not return to an idle prompt within ${settleTimeoutMs}ms after Escape. ` +
          `Nothing was typed, so no partial instruction was left in the child. ` +
          `Retry, or resume the session with sv2_resume.`,
      };
    }
  }

  await client.paneSendText(paneId, message);
  await client.paneSendKeys(paneId, [SUBMIT_KEY]);

  return {
    status: "delivered",
    preTail,
    observedTail: await client.paneRead(paneId, lines).catch(() => null),
  };
}

export async function routeUpdate(
  registry: ScopeRegistry,
  options: MatchOwnerOptions & {
    update: string;
    apply?: boolean;
    /**
     * Refuse delivery to a target that must not receive author contact.
     *
     * The router owns target resolution, so the caller cannot pre-check it
     * reliably. A refusal is reported as `blocked-owner` and never touches the
     * pane: a reviewer that is told "here is the author's answer" is no longer
     * independent.
     */
    targetRefusal?: (target: ScopedChild) => string | undefined;
  },
  client?: ClientLike
): Promise<SteerResolution & { applied?: boolean; deliveryTail?: string | null }> {
  const decision = matchOwner(options.update, registry, options);
  // Ambiguous / nonexistent / gone / unauthorized / blocked-owner must never
  // touch a pane. Only a resolved single owner with a definitive mode proceeds.
  if (!options.apply || !client) return decision;
  if (!decision.target?.paneId) return decision;
  if (decision.outcome !== "interrupt" && decision.outcome !== "queue") return decision;
  const refusal = options.targetRefusal?.(decision.target);
  if (refusal) {
    return { ...decision, outcome: "blocked-owner", reason: refusal, applied: false };
  }

  const delivery = await deliverSteer(
    client,
    decision.target.paneId,
    decision.outcome,
    options.update,
  );

  return {
    ...decision,
    applied: delivery.status === "delivered",
    deliveryTail: delivery.observedTail,
    ...(delivery.status === "interrupt-failed"
      ? { reason: delivery.reason ?? decision.reason }
      : {}),
  };
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
