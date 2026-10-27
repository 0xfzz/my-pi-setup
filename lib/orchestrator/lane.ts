/**
 * lane.ts — the ONE definition of what a lane covers.
 *
 * Two call sites used to answer this question with separate implementations:
 * `evidence.ts` (does this changed file sit inside the lane a handoff declared?)
 * and `scope-registry.findLaneConflicts` (do two live children claim the same
 * file?). They agreed by comment, not by construction, and a comment is not a
 * test: the registry's version had no glob support, so `**\/*.md` covered a file
 * at review time and nothing at admission time.
 *
 * Every lane question now routes through here, so "in lane" means one thing.
 */

/** Trim, unify separators, drop a leading `./` and trailing slashes. */
export function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "");
}

/**
 * Does `lane` (as authored in a handoff) cover `candidate` (a changed file)?
 *
 * Exact path, directory prefix, plus the glob forms a spec is likely to use.
 * A bare filename (`client.ts`) names that file wherever it lives; a path names
 * a location.
 */
export function laneCoversPath(lane: string, candidate: string): boolean {
  const l = normalizePath(lane);
  const c = normalizePath(candidate);
  if (!l || !c) return false;
  if (!/[*?[\]{}]/.test(l)) {
    if (l === c || c.startsWith(`${l}/`)) return true;
    if (!l.includes("/") && c.split("/").pop() === l) return true;
    return false;
  }
  // One scan, not chained replaces: replacing `**/` with `(?:.*/)?` and then
  // replacing `*` rewrote the marker itself, so `**/*.md` matched nothing.
  let pattern = "";
  for (let index = 0; index < l.length; index++) {
    const char = l[index]!;
    if (char === "*") {
      if (l[index + 1] === "*") {
        if (l[index + 2] === "/") {
          pattern += "(?:.*/)?";
          index += 2;
        } else {
          pattern += ".*";
          index += 1;
        }
      } else {
        pattern += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      pattern += "[^/]";
      continue;
    }
    pattern += "\\^$+.(()|[]{}".includes(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${pattern}$`).test(c) || new RegExp(`^${pattern}/`).test(c);
}

export function pathMatchesAnyLane(laneFiles: readonly string[], candidate: string): boolean {
  return laneFiles.some((lane) => laneCoversPath(lane, candidate));
}

/**
 * Do two lanes claim any of the same files?
 *
 * Symmetric: a directory covers a file inside it, whichever side it appears on.
 * This is the admission-time question ("may these two children run together?"),
 * and it uses the same matcher as the review-time question so a lane cannot be
 * disjoint at spawn and overlapping at review.
 */
export function lanesOverlap(left: string, right: string): boolean {
  return laneCoversPath(left, right) || laneCoversPath(right, left);
}
