// The git branch a session's directory is on, for the composer's workspace
// line. Read-only and best-effort: the line is context, never session state,
// so a directory that is not a worktree, a missing git binary or a slow
// lookup all answer "no branch" instead of failing the request.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A lookup that outlives this is not worth waiting for: the line is decoration. */
export const GIT_BRANCH_TIMEOUT_MS = 1_000;

/**
 * The branch name for `cwd`, or null when there is none to show.
 *
 * `symbolic-ref` answers the branch HEAD points at, which also covers a
 * freshly initialised repository that has no commits yet. A detached HEAD
 * points at no branch, so it reports null rather than inventing a name.
 */
export async function gitBranch(cwd: string, timeoutMs: number = GIT_BRANCH_TIMEOUT_MS): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    const name = stdout.trim();
    return name === "" ? null : name;
  } catch {
    // Detached HEAD, not a repository, git missing, unreadable directory, or
    // a timeout: every one of them is simply "no branch to show".
    return null;
  }
}
