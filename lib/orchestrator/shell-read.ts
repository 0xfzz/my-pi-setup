/**
 * shell-read.ts — repository history for a reader, without a general shell.
 *
 * The grammar is `readOnlyShellCommand` from `lib/plan-shell.ts`: the same closed
 * language the Plan mode and the supervisor already rely on. It re-quotes every
 * argument, so the sanitized string contains no expansion, redirection, heredoc
 * or executable pipeline. This module adds the second half a reviewer needs: the
 * *paths* inside the command are checked against the reviewer's roots before
 * anything runs.
 *
 * `git log`, `git diff`, `rg`, `find`, `cat` answer questions a plain `read`
 * cannot; `git checkout`, `rm`, `>` and `$(…)` are refused by construction.
 */
import { pathPolicyProblem } from "./review-policy.ts";
import { readOnlyShellCommand } from "../plan-shell.ts";

export interface ShellReadOptions {
  cwd: string;
  roots?: string[];
  deny?: string[];
  /** Injected path policy (tests, or a caller with a narrower root set). */
  guard?: (token: string) => string | undefined;
}

export type ShellReadResult =
  | { ok: true; command: string }
  | { ok: false; problem: string };

/** The grammar re-quotes every argument, so tokens are single-quoted literals. */
export function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /'((?:[^']|'\\'')*)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    tokens.push(match[1]!.replace(/'\\''/g, "'"));
  }
  return tokens;
}

export function shellReadCommand(command: unknown, options: ShellReadOptions): ShellReadResult {
  const sanitized = readOnlyShellCommand(command);
  if (!sanitized) {
    return {
      ok: false,
      problem:
        "Not a read-only command. Allowed: ls, cat, head, tail, wc, stat, find, rg, git status/log/diff/show/ls-files/rev-parse. "
        + "No redirection, heredoc, $(), backticks, or unknown commands.",
    };
  }

  const guard = options.guard
    ?? ((token: string) => pathPolicyProblem(token, { cwd: options.cwd, roots: options.roots, deny: options.deny }));

  for (const token of shellTokens(sanitized)) {
    if (!token || token.startsWith("-")) continue;
    const problem = guard(token);
    if (problem) return { ok: false, problem };
  }

  return { ok: true, command: sanitized };
}
