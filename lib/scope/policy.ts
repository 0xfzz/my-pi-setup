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
 * Reads outside the workspace are the one exception: they default to `allow`
 * (`defaults.readExternal`) because a gate that asks about `ls /tmp` is a gate
 * people disable. A `deny` rule still wins, and `external_directory` rules still
 * apply to both directions.
 */
import { resolveRule } from "./glob.ts";
import { tmpdir } from "node:os";
import { rootCovering, toResourceSlash } from "./paths.ts";
import type {
  Claim,
  ScopeDecision,
  ScopeEffect,
  ScopeState,
  UnknownClaim,
  PathClaim,
} from "./types.ts";

export interface EvaluateOptions {
  /** Set by the gate after the user answered "allow once" for this call. */
  approvedOnce?: boolean;
}

function unknownDecision(claim: UnknownClaim, state: ScopeState): ScopeDecision {
  // A rule keyed on the tool name is the way out for a tool that declares
  // nothing: `<tool> * allow` silences it for good, `<tool> * deny` blocks it for
  // good. Without this the unknown default was a per-call tax with no exit, which
  // is what made an unconfigured MCP server feel like a broken gate.
  const matched = resolveRule(state.rules, claim.tool, "*");
  if (matched) {
    return {
      effect: matched.effect,
      reason: `rule ${matched.rule.action}:${matched.rule.resource} says ${matched.effect}`,
      resource: "*",
      external: true,
      write: true,
      rule: matched.rule,
    };
  }
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

/**
 * Targets that are never a boundary question.
 *
 * `cmd 2>/dev/null` was the loudest single source of asking in a shell-heavy
 * session, and a tool writing its own scratch file under `$TMPDIR` is not an
 * escape. Deny rules still win — this runs after them.
 */
const DEVICE_PREFIXES = ["/dev/", "/proc/", "/sys/"];
const TEMP_PREFIXES = ["/tmp/", "/var/tmp/", "/private/tmp/", "/private/var/folders/"];

function isSpecialPath(absolute: string, workspace: string): boolean {
  const path = toResourceSlash(absolute);
  if (DEVICE_PREFIXES.some(prefix => path.startsWith(prefix))) return true;
  const scratch = toResourceSlash(tmpdir());
  // A workspace that itself lives in the temp root does not turn its siblings
  // into scratch: there the boundary is real and must still ask.
  if (workspace === scratch || workspace.startsWith(`${scratch}/`)) return false;
  return path === scratch || path.startsWith(`${scratch}/`) || TEMP_PREFIXES.some(prefix => path.startsWith(prefix));
}

/**
 * Reads that are never quiet, whatever `readExternal` says.
 *
 * Decision F: an outside read is silent when it is ordinary, and asks when it is
 * one of the handful of files whose disclosure is the reason a gate exists —
 * private keys, cloud credentials, dotenv secrets. This is the shape Codex and
 * Claude Code's sandbox both take (reads free, dangerous reads named); asking
 * about every outside read is the noise it was meant to prevent.
 */
const SENSITIVE_SEGMENTS = [
  "/.ssh/",
  "/.aws/",
  "/.gnupg/",
  "/.docker/config.json",
  "/.config/gh/",
  "/.config/gcloud/",
  "/.kube/config",
  "/.netrc",
  "/.pgpass",
  "/.git-credentials",
  "/.npmrc",
  "/.pypirc",
];
const SENSITIVE_NAMES = [".env", ".envrc", ".netrc", ".pgpass", ".git-credentials", "id_rsa", "id_ed25519", "id_ecdsa"];
const SENSITIVE_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".kdbx", ".keystore"];
/**
 * Templates document the shape of the secrets without holding any.
 *
 * `.env.example` sat behind the `.env.` prefix rule and asked like the real
 * file, which teaches people to click through the one dialog that matters. This
 * is opencode's default too: `*.env.example: allow`.
 */
const TEMPLATE_SUFFIXES = [".env.example", ".env.sample", ".env.template"];

/** Is this one of the reads whose disclosure is the reason a gate exists? */
export function isSensitiveRead(absolute: string): boolean {
  const path = `/${toResourceSlash(absolute).replace(/^\/+/, "")}`;
  const name = path.split("/").pop() ?? "";
  if (TEMPLATE_SUFFIXES.some(suffix => name.endsWith(suffix))) return false;
  if (SENSITIVE_NAMES.includes(name) || name.startsWith(".env.")) return true;
  if (SENSITIVE_SUFFIXES.some(suffix => name.endsWith(suffix))) return true;
  return SENSITIVE_SEGMENTS.some(segment => path.includes(segment));
}

/** Evaluate one claim. Pure: no IO, no UI, no globals. */
export function evaluateClaim(claim: Claim, state: ScopeState, options: EvaluateOptions = {}): ScopeDecision {
  if ("unknown" in claim && claim.unknown) return withYolo(unknownDecision(claim, state), state);

  const pathClaim = claim as PathClaim;
  const base = {
    resource: pathClaim.resource,
    external: pathClaim.external,
    // `unknown` posture is judged as a write would be: a reader the scanner cannot
    // vouch for must not slip through on the read default.
    write: pathClaim.posture !== "read",
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
  // A command rule speaks about the whole segment, not about one path:
  // `{"action":"bash","resource":"git -C ../other status *","effect":"allow"}`
  // is one grant per habit instead of a folder grant per path.
  const byCommand = pathClaim.command ? resolveRule(state.rules, pathClaim.tool, pathClaim.command) : undefined;
  if (byCommand?.effect === "deny") {
    return { ...base, effect: "deny", reason: reasonForDeny(byCommand.rule, pathClaim.tool), rule: byCommand.rule };
  }

  // 2. Device, /proc and temp targets are never a boundary question. `cmd
  //    2>/dev/null` must not prompt, and a scratch file under $TMPDIR is not an
  //    escape — this was the loudest source of asking in a shell-heavy session.
  if (isSpecialPath(pathClaim.absolute, state.roots[0]?.path ?? "")) {
    return { ...base, effect: "allow", reason: `special path ${pathClaim.absolute}` };
  }

  // 3. A read-only root still allows the read; a write has to be granted.
  const covering = pathClaim.external ? undefined : coveringRoot(state, pathClaim.absolute);
  if (covering && base.write && covering.access === "ro") {
    return withYolo(
      { ...base, effect: "ask", reason: `${pathClaim.tool} would write inside read-only root ${covering.path}`, root: covering },
      state,
    );
  }

  // 4. Explicit allow rule, then a covering root.
  const allowed =
    denied?.effect === "allow" ? denied
    : boundary?.effect === "allow" ? boundary
    : byCommand?.effect === "allow" ? byCommand
    : undefined;
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
      if (covered.access === "ro" && base.write) {
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
    effect: base.write ? state.defaults.external : state.defaults.readExternal,
    reason: `outside the workspace: ${pathClaim.absolute}`,
  };
  // 5. A sensitive read is never quiet, whatever `readExternal` says: keys,
  //    cloud credentials and dotenv files are the reads that actually matter.
  if (!base.write && isSensitiveRead(pathClaim.absolute)) {
    return withYolo({ ...decision, effect: state.defaults.external, reason: `${decision.reason} (sensitive)` }, state);
  }
  return withYolo(decision, state);
}

/**
 * The one policy the decision table cannot see: yolo approves *ordinary* outside
 * paths, never a sensitive read.
 *
 * `withYolo` upgrades whatever question it is handed, and the sensitive-read
 * branch has already turned its answer into `ask` — so `yolo ro` used to
 * auto-approve `cat ~/.ssh/id_rsa`. That contradicts the rule the whole list
 * exists to state ("a sensitive read always asks"), and the arm's strength says
 * nothing about it: `ro` restricts writes, not disclosure.
 *
 * This is a gate `onEvaluate` hook rather than a branch in `evaluateClaim`
 * because the table is deliberately stateless — it is given a claim and a state,
 * and statelessness is what makes it testable. The narrowing is a question about
 * intent, so it sits in the hook stage where opencode puts `permission.evaluate`.
 */
export function narrowYoloSensitiveRead(decision: ScopeDecision, claim: Claim, yolo: boolean): ScopeEffect | undefined {
  if (!yolo || decision.effect !== "allow") return undefined;
  // Only the outside default: inside the workspace the workspace root is the
  // grant, and yolo changes nothing about it. Narrowing an inside `.env` read
  // here would make arming yolo *more* intrusive than leaving it off.
  if ("unknown" in claim || claim.posture !== "read" || !claim.external) return undefined;
  return isSensitiveRead(claim.absolute) ? "ask" : undefined;
}

function coveringRoot(state: ScopeState, absolute: string): ScopeState["roots"][number] | undefined {
  // Most specific literal prefix wins: a nested read-only root must not be
  // shadowed by the workspace root that happens to come first in the list, and a
  // wildcard root (`~/projects/*`) matches by pattern instead of by prefix.
  return rootCovering(state.roots, absolute);
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
