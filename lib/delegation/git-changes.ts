/**
 * git-changes.ts — what actually changed on disk, whatever tool changed it.
 *
 * The receipt's lane check read the child's `write`/`edit` tool calls, so a child
 * that wrote with `bash` (`sed -i`, `>`, `tee`, `mv`, a generator script) was
 * invisible. The working tree does not care how a file changed, so the check is
 * made there: a signature (mtime + size) of every dirty path is taken when the
 * child starts and compared when it settles.
 *
 * Attribution is the hard part with parallel children. A path changed since the
 * baseline is only held against a child when no OTHER child's lane covers it and
 * the parent did not write it itself; when the parent ran shell commands in the
 * window the finding is downgraded to ambiguous rather than blamed on the child.
 *
 * Not a git repository, or git missing, is "unknown", never "clean".
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

import { laneCoversPath, normalizePath } from "./lane.ts";

/** path → "mtimeMs:size" (or "deleted"). Capped so a huge dirty tree cannot bloat the registry. */
export type TreeSignature = Record<string, string>;

const MAX_PATHS = 2000;

export function snapshotTree(cwd: string): TreeSignature | null {
  let raw: string;
  try {
    raw = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
  } catch {
    return null;
  }
  const out: TreeSignature = {};
  const parts = raw.split("\0").filter(Boolean);
  for (let i = 0; i < parts.length && Object.keys(out).length < MAX_PATHS; i++) {
    const entry = parts[i]!;
    const code = entry.slice(0, 2);
    const path = normalizePath(entry.slice(3));
    // A rename carries the old path as the next NUL field.
    if (code[0] === "R" || code[0] === "C") i++;
    if (!path) continue;
    try {
      const stat = statSync(join(cwd, path));
      out[path] = `${Math.round(stat.mtimeMs)}:${stat.size}`;
    } catch {
      out[path] = "deleted";
    }
  }
  return out;
}

/** Paths whose signature differs from the baseline, including newly dirty and newly deleted ones. */
export function changedSince(baseline: TreeSignature, current: TreeSignature): string[] {
  const changed: string[] = [];
  for (const [path, signature] of Object.entries(current)) {
    if (baseline[path] !== signature) changed.push(path);
  }
  // A file dirty at the baseline that is clean now was reverted or committed: a change too.
  for (const path of Object.keys(baseline)) {
    if (!(path in current)) changed.push(path);
  }
  return changed.sort();
}

export interface Attribution {
  /** Changes nobody else's lane or the parent's own writes account for. */
  unowned: string[];
  /** Changes inside this child's lane (expected). */
  inLane: string[];
  /** Changes owned by another child's lane, or written by the parent. */
  elsewhere: string[];
}

export function attributeChanges(input: {
  changed: readonly string[];
  ownLane: readonly string[];
  otherLanes: readonly string[];
  parentWrites: readonly string[];
}): Attribution {
  const result: Attribution = { unowned: [], inLane: [], elsewhere: [] };
  const covered = (lanes: readonly string[], path: string) => lanes.some((lane) => laneCoversPath(lane, path));
  for (const path of input.changed) {
    if (covered(input.ownLane, path)) result.inLane.push(path);
    else if (covered(input.otherLanes, path) || input.parentWrites.some((w) => normalizePath(w) === path)) result.elsewhere.push(path);
    else result.unowned.push(path);
  }
  return result;
}
