/**
 * Where a shell command actually runs.
 *
 * Pi spawns the shell at the session cwd, but it also prepends the configured
 * command prefix to every bash call, so a `cd` in that prefix changes the
 * directory the model's own relative paths resolve against. The gate has to use
 * the same base the process will use, or every relative claim is judged against
 * the wrong folder.
 *
 * Only the cwd effect of the prefix is modelled: assignments, `source`, exported
 * variables and anything else that does not move the directory are transparent.
 * The one case that cannot be guessed is a cd-family command whose argument is
 * computed at runtime, and that is reported rather than silently assumed.
 */
import { resolve } from "node:path";
import { expandHome } from "./paths.ts";
import { scanShell } from "./shell-syntax.ts";

export interface EffectiveBase {
  base: string;
  /** A cd-family command whose target cannot be resolved statically. */
  opaque?: string;
}

const CD = new Set(["cd", "pushd"]);

/**
 * A trailing list operator is what a real prefix looks like (`cd /repo &&`), and
 * tree-sitter reports that as incomplete syntax. Dropping it is what makes the
 * prefix parseable; the operator itself has no cwd effect.
 */
const TRAILING_OPERATOR = /\s*(?:&&|\|\||;|\|)\s*$/;

/** Does the text mention a cd-family command at a word boundary? */
const CD_MENTION = /(?:^|[\s;&|(])(?:cd|pushd)(?:\s|$)/;

export function effectiveBase(cwd: string, prefix: string | undefined): EffectiveBase {
  if (!prefix || !prefix.trim()) return { base: cwd };

  const scan = scanShell(prefix.replace(TRAILING_OPERATOR, ""));
  if (scan.reason) {
    // A prefix the scanner cannot read is only a problem when it may have moved
    // the directory: `source ~/.nvm/nvm.sh` is transparent, a failed `cd` is not.
    return CD_MENTION.test(prefix)
      ? { base: cwd, opaque: `the shell command prefix could not be analysed (${scan.reason})` }
      : { base: cwd };
  }

  const bases: string[] = [cwd];
  for (const item of scan.commands) {
    if (item.scope === "enter") {
      // A subshell starts from the inherited base and cannot move the outer one.
      bases.push(bases[bases.length - 1]!);
      continue;
    }
    if (item.scope === "leave") {
      if (bases.length > 1) bases.pop();
      continue;
    }
    const first = item.words[0];
    if (!first?.value) continue;
    const binary = (first.value.split("/").pop() ?? "").trim();
    if (!CD.has(binary)) continue;

    const target = item.words.slice(1).find(word => !word.text.startsWith("-"));
    if (!target?.value) {
      return {
        base: cwd,
        opaque: `the shell command prefix changes directory to a value it cannot resolve (${target?.text ?? "no argument"})`,
      };
    }
    if (/[*?[\]]/.test(target.value)) {
      // `cd ./build/*` is a pattern that could match several directories, so any
      // base chosen for it would be a guess.
      return {
        base: cwd,
        opaque: `the shell command prefix changes directory to a pattern it cannot resolve (${target.text})`,
      };
    }
    const current = bases[bases.length - 1]!;
    bases[bases.length - 1] = resolve(current, expandHome(target.value));
  }

  return { base: bases[0]! };
}
