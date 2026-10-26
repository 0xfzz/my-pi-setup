/**
 * review-policy.ts — what a spec-only reviewer child is allowed to see and do.
 *
 * The EGM method depends on one property: a reviewer must not inherit the
 * author's reasoning. A persona prompt cannot deliver that. A child in this
 * harness can reach its parent's transcript (`parent_recall`), inherit a forked
 * or digested branch, see every *global* artifact, or shell out to the session
 * state directory. So the policy is data, resolved from the environment the
 * launcher writes, and every consumer (launch planning, the child-side tool
 * guard, context injection) reads the same record instead of re-deciding.
 *
 * Two deliberate limits, stated so nobody overclaims this later:
 *
 *   1. This is harness isolation, not an OS boundary. A hostile child that
 *      escaped its `--tools` allowlist would still be a process with the parent's
 *      UID. Strong adversarial isolation needs a sandbox or a separate user.
 *   2. The pinned snapshot is embedded in the reviewer's ticket. Reviewers
 *      therefore need no artifact tools at all, which is why "only explicitly
 *      supplied artifacts" is enforced by absence rather than by filtering.
 */
import { isAbsolute, relative, resolve } from "node:path";

export const REVIEW_POLICY_ENV = "PI_SUBAGENT_REVIEW_POLICY";
export const REVIEW_RUN_ENV = "PI_SUBAGENT_REVIEW_RUN";
export const REVIEW_LENS_ENV = "PI_SUBAGENT_REVIEW_LENS";
export const REVIEW_TARGET_ENV = "PI_SUBAGENT_REVIEW_TARGET";
export const REVIEW_DIR_ENV = "PI_SUBAGENT_REVIEW_DIR";
export const REVIEW_ROOTS_ENV = "PI_SUBAGENT_REVIEW_ROOTS";

/** The only policy value understood today. Anything else is treated as "no policy". */
export const SPEC_ONLY_POLICY = "spec-only";

export interface ReviewPolicy {
  runId: string;
  lens: string;
  targetHash: string;
  /** Directory this reviewer may write its single report into. */
  reportDir: string;
  /** Repository roots the reviewer may read. Empty means "the working directory". */
  roots: string[];
}

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Resolve the policy from an environment. Returns `undefined` for every ordinary
 * child: a policy that cannot be read in full is not silently downgraded to a
 * weaker one, because a reviewer with a half-read policy is a biased reviewer.
 */
export function reviewPolicyFromEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): ReviewPolicy | undefined {
  if (env[REVIEW_POLICY_ENV] !== SPEC_ONLY_POLICY) return undefined;
  const runId = clean(env[REVIEW_RUN_ENV]);
  const lens = clean(env[REVIEW_LENS_ENV]);
  const targetHash = clean(env[REVIEW_TARGET_ENV]);
  const reportDir = clean(env[REVIEW_DIR_ENV]);
  if (!runId || !lens || !targetHash || !reportDir) return undefined;
  const roots = String(env[REVIEW_ROOTS_ENV] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(entry));
  return { runId, lens, targetHash, reportDir: resolve(reportDir), roots };
}

/**
 * Tools a spec-only reviewer may call.
 *
 * Deliberately absent and load-bearing: `bash` (arbitrary interpreter), `write`
 * and `edit` (it must not be able to change the document it judges), `browser`,
 * `mcp`, `codemode` and `web_read` (open-world inputs that are not pinned),
 * every `orch_*` (it owns no children), `parent_recall`/`parent_digest` and
 * `orch_history` (the author's reasoning), and the artifact writers (the
 * snapshot is already inside its ticket).
 */
export const SPEC_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read", "grep", "find", "ls", "ffgrep", "fffind",
  "todo_plan", "todo_act", "todo_next", "workflow_todo",
  "caller_ping", "subagent_done", "orch_progress",
  "spec_review_submit",
]);

/**
 * Names a reviewer must never reach even if an agent profile, an MCP server, or a
 * late registration were to expose them. `spec_review_submit` and the read
 * instruments are the whole surface; anything else is refused by default.
 */
export const SPEC_ONLY_DENIED_TOOLS: ReadonlySet<string> = new Set([
  "bash", "write", "edit", "multi_edit", "multiedit", "apply_patch", "applypatch", "patch",
  "parent_recall", "parent_digest", "orch_history", "subagents_list",
  "subagent", "subagent_resume", "subagent_interrupt",
  "browser", "browser_download", "browser_login",
  "mcp", "mcpScript", "codemode", "tool_search",
  "web_read", "google_search", "web_search", "fetch_content", "source_check",
  "artifact_save", "artifact_edit", "generate_image",
]);

/** Any `orch_` tool is parent-only by definition, so the prefix is a blanket rule. */
export function isSpecOnlyDeniedTool(name: string): boolean {
  if (!name) return true;
  if (SPEC_ONLY_DENIED_TOOLS.has(name)) return true;
  if (name.startsWith("orch_")) return true;
  return !SPEC_ONLY_TOOLS.has(name);
}

/** Names accepted by `spec_review_submit`; kept next to the policy so they cannot drift. */
export const REVIEW_LENSES = ["comprehension", "readiness", "zoom-out", "critic"] as const;
export type ReviewLens = (typeof REVIEW_LENSES)[number];

export function isReviewLens(value: unknown): value is ReviewLens {
  return typeof value === "string" && (REVIEW_LENSES as readonly string[]).includes(value);
}

/**
 * Is `candidate` inside one of `roots` and not inside `deny`?
 *
 * Canonicalisation is lexical: `resolve()` collapses `..`, which is what stops
 * `../../.pi/agent/sessions/...` from being read under the guise of a relative
 * path. A symlink inside the repo can still point out; that is the stated limit
 * of a lexical guard, not an oversight.
 */
export function pathPolicyProblem(
  candidate: unknown,
  options: { cwd: string; roots?: readonly string[]; deny?: readonly string[] },
): string | undefined {
  if (typeof candidate !== "string" || !candidate.trim()) return undefined;
  const base = resolve(options.cwd);
  const path = resolve(base, candidate.trim());
  for (const denied of options.deny ?? []) {
    if (!denied) continue;
    const boundary = resolve(denied);
    const rel = relative(boundary, path);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      return `${candidate} is inside orchestrator control-plane state and is not readable by a reviewer`;
    }
  }
  const roots = (options.roots ?? []).map((root) => resolve(root));
  if (!roots.length) return undefined;
  for (const root of roots) {
    const rel = relative(root, path);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return undefined;
  }
  return `${candidate} is outside the reviewer's permitted roots (${roots.join(", ")})`;
}

/**
 * Which input paths a tool call touches.
 *
 * Only read instruments are inspected; a spec-only child has no writer, so this
 * exists to stop it reading the control plane (handoff copies, transcripts,
 * registry sidecars, sibling review reports) through an ordinary `read`.
 */
export function readTargets(name: string, input: any): string[] {
  const out: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim()) out.push(value);
  };
  if (name === "read" || name === "ls") {
    push(input?.path);
  } else if (name === "grep" || name === "ffgrep") {
    push(input?.path);
  } else if (name === "find" || name === "fffind") {
    push(input?.path);
    push(input?.pattern);
  }
  return out;
}

/** Tools whose input names a filesystem path, so the guard knows where to look. */
export const PATH_READ_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls", "ffgrep", "fffind"]);

/**
 * Render the policy as a short block for the reviewer ticket.
 *
 * Stated to the reviewer as facts about its own session, not as a threat model:
 * a model that believes it can "just check the parent's notes" will try, and a
 * refusal it did not expect becomes a blocker it reports instead of context it
 * silently acquires.
 */
export function renderPolicyForReviewer(policy: Pick<ReviewPolicy, "lens" | "roots">): string {
  return `Your session is isolated on purpose (lens: ${policy.lens}).
- You did not inherit any parent conversation, and you cannot pull one.
- You have no write tool. The specification you are judging is quoted in this ticket.
- You may read repository files${policy.roots.length ? ` under: ${policy.roots.join(", ")}` : ""}.
- If the document is unclear, that is a finding. Do not go looking for the author's intent.`;
}
