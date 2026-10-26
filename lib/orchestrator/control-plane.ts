/**
 * Paths the orchestrator may never write, in any capability.
 *
 * Everything in the orchestrator's control plane is a plain file: the registry
 * sidecar, child launch scripts, the handoff audit copies, and the children's own
 * `session.jsonl` transcripts. `write` access to any of them is not "power", it is
 * the ability to forge the instrument that is supposed to judge it:
 *
 *   - edit the sidecar → mark your own children closed, clear a `failed` row
 *   - edit `<session>.jsonl` → rewrite what a child said it did
 *   - write `<session>.exitcode` → fabricate a clean exit the watcher will consume
 *   - edit a handoff audit copy → change the criteria the review compares against
 *
 * That class stays closed even when capability is `full`. Repository files are
 * fair game: that is the trade "the orchestrator may implement, but the review
 * must be able to prove what happened".
 */
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

/** Files that bind a session to an outcome, wherever they live. */
const SIDECAR_NAME = /^(orchestrator-registry-.*\.json|.*\.(exit|exitcode))$/;

function isInside(candidate: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
  return rel.split(sep).length >= 0;
}

/**
 * Returns a reason when `candidate` is control plane, `undefined` when it is an
 * ordinary repository path.
 *
 * `sessionDir` is Pi's own state directory: everything under it (transcripts,
 * artifacts, launch scripts, handoff copies, the registry sidecar) belongs to the
 * control plane by construction, so a single containment check covers the class.
 */
export function isControlPlanePath(
  candidate: unknown,
  options: { sessionDir?: string | null } = {},
): string | undefined {
  if (typeof candidate !== "string" || !candidate.trim()) return undefined;
  const path = candidate.trim();
  if (SIDECAR_NAME.test(basename(path))) {
    return `${basename(path)} is orchestrator control-plane state`;
  }
  if (options.sessionDir && isInside(path, options.sessionDir)) {
    return `${path} is inside the session state directory (control plane)`;
  }
  return undefined;
}
