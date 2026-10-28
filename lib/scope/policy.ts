/**
 * The decision table: one claim in, one effect out.
 *
 * Order matters and is the whole security story:
 *
 *   1. a `deny` rule wins over everything, including a grant and yolo;
 *   2. a read-only root refuses to become a write target quietly;
 *   3. an `allow` rule or a covering root allows;
 *   4. yolo may upgrade the remaining *question* — never a denial;
 *   5. otherwise ask, and the caller must obtain an answer.
 *
 * There is no branch that returns `allow` without a root, a rule or yolo, so a
 * missing root cannot be mistaken for permission.
 */
import { resolveRule } from "./glob.ts";
import type {
  Claim,
  ScopeDecision,
  ScopeState,
  UnknownClaim,
  PathClaim,
} from "./types.ts";

export interface EvaluateOptions {
  /** Set by the gate after the user answered "allow once" for this call. */
  approvedOnce?: boolean;
}

function unknownDecision(claim: UnknownClaim, state: ScopeState): ScopeDecision {
  return {
    effect: state.defaults.unknown,
    reason: `${claim.tool} does not declare the paths it touches`,
    resource: "*",
    external: true,
    write: true,
  };
}

function reasonForDeny(rule: { action: string; resource: string }, tool: string): string {
  return `${tool} is denied by rule ${rule.action}:${rule.resource}`;
}

/** Evaluate one claim. Pure: no IO, no UI, no globals. */
export function evaluateClaim(claim: Claim, state: ScopeState, options: EvaluateOptions = {}): ScopeDecision {
  if ("unknown" in claim && claim.unknown) return withYolo(unknownDecision(claim, state), state);

  const pathClaim = claim as PathClaim;
  const base = {
    resource: pathClaim.resource,
    external: pathClaim.external,
    write: pathClaim.write,
  };

  // 1. Deny rules are absolute. A session grant, a project root or yolo can never
  //    re-open something the user (or a team config) explicitly denied.
  const denied = resolveRule(state.rules, pathClaim.tool, pathClaim.resource);
  if (denied?.effect === "deny") {
    return { ...base, effect: "deny", reason: reasonForDeny(denied.rule, pathClaim.tool), rule: denied.rule };
  }
  // Rules may target the boundary action specifically (`external_directory`).
  const boundary = pathClaim.external
    ? resolveRule(state.rules, "external_directory", pathClaim.resource)
    : undefined;
  if (boundary?.effect === "deny") {
    return { ...base, effect: "deny", reason: reasonForDeny(boundary.rule, "external_directory"), rule: boundary.rule };
  }

  // 2. A read-only root still allows the read; the write has to be granted.
  const covering = pathClaim.external ? undefined : coveringRoot(state, pathClaim.absolute);
  if (covering && pathClaim.write && covering.access === "ro") {
    return withYolo(
      { ...base, effect: "ask", reason: `${pathClaim.tool} would write inside read-only root ${covering.path}`, root: covering },
      state,
    );
  }

  // 3. Explicit allow rule, then a covering root.
  const allowed = denied?.effect === "allow" ? denied : boundary?.effect === "allow" ? boundary : undefined;
  if (allowed) {
    return { ...base, effect: "allow", reason: `allowed by rule ${allowed.rule.action}:${allowed.rule.resource}`, rule: allowed.rule };
  }
  if (!pathClaim.external) {
    return { ...base, effect: "allow", reason: `inside ${covering?.access === "ro" ? "read-only " : ""}root ${covering?.path ?? "workspace"}`, root: covering };
  }
  // A root added while a question was queued (the "allow this folder" answer)
  // covers the claim even though it was classified as external when it arrived.
  if (!options.approvedOnce) {
    const covered = coveringRoot(state, pathClaim.absolute);
    if (covered) {
      if (covered.access === "ro" && pathClaim.write) {
        return withYolo(
          { ...base, effect: "ask", reason: `write inside read-only root ${covered.path}`, root: covered },
          state,
        );
      }
      return { ...base, effect: "allow", reason: `inside granted root ${covered.path}`, root: covered };
    }
  }

  // 4/5. Ask, unless yolo upgraded it. `approvedOnce` only ever covers one call.
  if (options.approvedOnce) {
    return { ...base, effect: "allow", reason: "approved once for this call" };
  }
  const decision: ScopeDecision = {
    ...base,
    effect: state.defaults.external,
    reason: `outside the workspace: ${pathClaim.absolute}`,
  };
  return withYolo(decision, state);
}

function coveringRoot(state: ScopeState, absolute: string): ScopeState["roots"][number] | undefined {
  // Longest match wins: a nested read-only root must not be shadowed by the
  // workspace root that happens to come first in the list.
  let best: ScopeState["roots"][number] | undefined;
  for (const root of state.roots) {
    if (!(root.path === absolute || absolute.startsWith(`${root.path}/`) || absolute.startsWith(`${root.path}\\`))) continue;
    if (!best || root.path.length > best.path.length) best = root;
  }
  return best;
}

/** yolo converts a question into an approval. It never touches `deny`. */
function withYolo(decision: ScopeDecision, state: ScopeState): ScopeDecision {
  if (!state.yolo) return decision;
  if (decision.effect !== "ask") return decision;
  const strength = state.yolo.strength;
  if (decision.write && strength !== "rw") {
    return { ...decision, reason: `${decision.reason} (yolo ro: writes still ask)` };
  }
  return { ...decision, effect: "allow", reason: `${decision.reason} (yolo ${strength})` };
}

/** Human-readable one-liner for the dialog and for model-facing block reasons. */
export function describeDecision(decision: ScopeDecision, tool: string, absolute: string): string {
  const verb = decision.write ? "write" : "read";
  const where = decision.external ? absolute : decision.resource;
  return `${tool} wants to ${verb} ${where} — ${decision.reason}`;
}
