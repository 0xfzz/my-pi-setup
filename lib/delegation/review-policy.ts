/**
 * review-policy.ts — what a spec-only reviewer child is allowed to see and do.
 *
 * The EGM method depends on one property: a reviewer must not inherit the
 * author's reasoning. A persona prompt cannot deliver that. A child in this
 * harness can reach its parent's transcript (`agent_parent_recall`), inherit a forked
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

export interface ReviewPolicy {
  runId: string;
  /** `document` = one pinned document judged by one lens; `split` = one chunk of specs. */
  kind: "document" | "split";
  /** Document reviews only. */
  lens?: string;
  /** Split reviews only: `review-1` … `review-K`. */
  chunkId?: string;
  /** Split reviews only: the member scopes this chunk must cover. */
  members?: string[];
  targetHash: string;
  /** Directory this reviewer may write its single report into. */
  reportDir: string;
  /** Repository roots the reviewer may read. Empty means "the working directory". */
  roots: string[];
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
      return `${candidate} is inside parent control-plane state and is not readable by a reviewer`;
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
