/**
 * Which paths a tool call claims to touch.
 *
 * Jurisdiction is explicit and closed. Scope gates only the builtin tools whose
 * inputs are paths (`GATED_TOOLS`). A gated call yields either the paths it
 * claims or an `unknown` verdict when the input cannot be analysed.
 *
 *   - `paths`   — the tool declares path inputs we understand (`read`, `write`,
 *                 `edit`, `grep`, `find`, `ls`, `ffgrep`, `fffind`) or it is a
 *                 shell command whose path-shaped channels we can extract.
 *   - `unknown` — the shell construct could not be lowered (`bash -c`,
 *                 `find -exec`, an interpreter heredoc). This is a parser limit,
 *                 not a verdict, and policy answers it with `ask` unless a rule
 *                 for the tool says otherwise.
 *   - *nothing* — every other tool: MCP, custom, delegation and session state.
 *                 Those bypass the gate entirely. A bypass is not an `allow`
 *                 rule: nothing is asked, recorded or persisted, so nothing can
 *                 be widened later, and the gate makes no claim about what an
 *                 MCP server does internally.
 *
 * The failure mode to avoid is treating "outside my jurisdiction" as "checked
 * and safe". It is neither, and the docs say so plainly.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { readOnlyShellCommand } from "../plan-shell.ts";
import { expandHome, toResourceSlash } from "./paths.ts";
import type { ScopePosture } from "./types.ts";
import { scanShell, type ShellWord } from "./shell-syntax.ts";

export interface PathRequest {
  /** Path as typed by the model; the gate resolves it against the cwd. */
  raw: string;
  /** Convenience mirror of `posture === "write"`. */
  write: boolean;
  /** What the call does to this path: read, write, or cannot be told apart. */
  posture: ScopePosture;
  kind: "file" | "directory" | "unknown";
  /** Rule action: the tool name, so per-tool rules keep working. */
  action: string;
  /** The raw shell segment this claim came from, for command-prefix rules. */
  command?: string;
  /** Directory a relative `raw` was written against (`cd` changes it). */
  base?: string;
}

export interface ClaimSet {
  paths: PathRequest[];
  unknown: boolean;
  /**
   * Set when the call cannot be analysed at all — a parser limit, not a verdict.
   * opencode draws the same line: an opaque command is a scanner error, never a
   * permission denial, so it is reported by name instead of looking like suspicion.
   */
  opaque?: string;
  reason?: string;
}

interface PathTool {
  fields: readonly string[];
  write: boolean;
  kind: PathRequest["kind"];
  /** Directory to use when the field is absent (search tools default to cwd). */
  fallback?: "cwd";
}

const PATH_TOOLS: Readonly<Record<string, PathTool>> = {
  read: { fields: ["path"], write: false, kind: "file" },
  write: { fields: ["path"], write: true, kind: "file" },
  edit: { fields: ["path"], write: true, kind: "file" },
  grep: { fields: ["path"], write: false, kind: "directory", fallback: "cwd" },
  find: { fields: ["path"], write: false, kind: "directory", fallback: "cwd" },
  ls: { fields: ["path"], write: false, kind: "directory", fallback: "cwd" },
  ffgrep: { fields: ["path"], write: false, kind: "directory", fallback: "cwd" },
  fffind: { fields: ["path"], write: false, kind: "directory", fallback: "cwd" },
};

/**
 * The tools this gate judges: the builtins whose inputs name a path.
 *
 * Everything else is outside its jurisdiction on purpose, and MCP is why this
 * list is a closed set rather than a table of guesses: an MCP server's inputs are
 * the server's business, so gating them would mean inventing path semantics the
 * host cannot verify. A tool that is not listed here bypasses the gate; it is not
 * allowed by it.
 */
export const GATED_TOOLS: ReadonlySet<string> = new Set([
  "bash", "read", "write", "edit", "grep", "find", "ls", "ffgrep", "fffind",
]);

/**
 * Flags whose value is a program, not a path.
 *
 * The value is data for a language runtime (`node -e`, `python3 -c`) and is never
 * scanned for paths; for a shell it is a nested program the gate cannot read, so
 * it makes the call opaque instead.
 */
const INLINE_CODE_FLAGS = new Set(["-c", "-e", "-p", "-r", "--eval", "--print", "--command"]);

/** Binaries whose -c/-e argument is another shell program the gate cannot read. */
const SHELLS = new Set(["bash", "sh", "zsh", "fish", "dash", "ksh", "osascript"]);

/**
 * Binaries whose heredoc body is *code*, not data. `git commit -F - <<EOF` feeds
 * data and must keep working; `python3 <<EOF` feeds a program and must not be
 * mistaken for a harmless redirect.
 */
const INTERPRETERS = new Set([
  "python", "python3", "node", "deno", "bun", "perl", "ruby", "php",
  "bash", "sh", "zsh", "fish", "osascript",
]);

const WRAPPERS = new Set(["sudo", "env", "time", "nice", "nohup", "command", "exec", "timeout"]);

/** Binaries whose arguments are a program the gate cannot read. */
const OPAQUE_BINARIES = new Set(["eval", "exec", "source", ".", "xargs"]);

/**
 * Which argv slots hold a path, per binary.
 *
 * This replaces "any word containing a slash is a path", which put `origin/main`,
 * `HEAD:src/x`, `ghcr.io/a/b:1`, `2024/01/02` and a `grep -E 'a/b'` pattern in
 * front of the user as boundary escapes. A slot is a path only when the binary
 * says so — its operands, or a named flag — and an operand only when it is
 * path-shaped or actually exists. A claim that resolves nowhere is not a claim.
 */
interface PathSpec {
  /**
   * Operands may be paths. Each is claimed only when it is path-shaped or
   * actually exists, so `grep foo` and `git checkout origin/main` claim nothing.
   */
  operands?: boolean;
  /** Flags whose *next* token is a path (`git -C <dir>`, `tar -f <file>`). */
  valueFlags?: readonly string[];
  /** Flags carrying their path inline, as `--flag=value`. */
  inlineFlags?: readonly string[];
  posture: ScopePosture;
  /** Sub-command postures for dispatchers: `git add` writes, `git status` reads. */
  subcommands?: Readonly<Record<string, ScopePosture>>;
  /** Flags that turn a reader into a writer (`sed -i`, `sort -o`). */
  writeFlags?: readonly string[];
  /** Flags whose values are data, never path operands (patterns, formats, URLs). */
  dataFlags?: readonly string[];
  /** Positional data arguments before file operands (grep/sed/awk patterns). */
  dataOperands?: number;
  /**
   * How many leading operands can be an entry script (`node script.js`).
   *
   * Only the entry script is a path claim. For `node /c /e`, `/c` is the script
   * and `/e` is an argument whose meaning belongs to that program, so it is
   * never claimed. This is the difference between "an argv slot" and "a path".
   */
  entryOperands?: number;
  /** Commands such as git/npm can read or mutate their effective cwd implicitly. */
  usesCwd?: boolean;
}

const READ: ScopePosture = "read";
const WRITE: ScopePosture = "write";
const EITHER: ScopePosture = "unknown";

/** Read a path and change nothing about it. */
const READERS = [
  "cat", "tac", "head", "tail", "less", "more", "most", "bat", "nl", "wc", "od", "xxd",
  "hexdump", "strings", "file", "stat", "du", "df", "ls", "tree", "readlink", "realpath",
  "basename", "dirname", "diff", "cmp", "comm", "join", "paste", "cksum", "md5sum", "sha1sum",
  "sha256sum", "sha512sum", "shasum", "b2sum", "iconv", "base64", "base32", "zcat", "grep",
  "egrep", "fgrep", "rg", "ag", "ack", "pt", "ugrep", "fd", "find", "which", "type",
] as const;

/** Take a path and change it, including when it does not exist yet. */
const MUTATORS = [
  "cp", "mv", "rm", "rmdir", "mkdir", "touch", "ln", "chmod", "chown", "chgrp", "tee",
  "dd", "truncate", "install",
] as const;

/** Same, but the operand set is the archive, not every argument. */
const ARCHIVE_TOOLS = ["tar", "unzip", "zip", "gzip", "gunzip", "bzip2", "xz", "zstd"] as const;

function specFor(names: readonly string[], spec: PathSpec): Record<string, PathSpec> {
  return Object.fromEntries(names.map(name => [name, spec]));
}

const GIT_READ = [
  "status", "log", "diff", "show", "blame", "grep", "ls-files", "ls-tree", "rev-parse",
  "describe", "shortlog", "whatchanged", "cat-file", "merge-base", "show-ref", "reflog",
] as const;
const GIT_WRITE = [
  "add", "commit", "rm", "mv", "checkout", "restore", "switch", "reset", "clean", "apply",
  "am", "cherry-pick", "rebase", "merge", "stash", "tag", "gc", "prune", "worktree",
  "submodule", "init", "clone", "fetch", "pull", "push",
] as const;

/** Sub-command posture for a dispatcher, built from two name lists. */
const GIT_POSTURE: Readonly<Record<string, ScopePosture>> = Object.fromEntries([
  ...GIT_READ.map(name => [name, READ] as const),
  ...GIT_WRITE.map(name => [name, WRITE] as const),
]);

const SPECS: Readonly<Record<string, PathSpec>> = {
  ...specFor(READERS, { operands: true, posture: READ }),
  ...specFor(MUTATORS, { operands: true, posture: WRITE }),
  ...specFor(ARCHIVE_TOOLS, { operands: true, posture: WRITE }),
  ...specFor(["echo", "printf", "true", "false", "date", "pwd"], { posture: READ }),
  ...specFor(["grep", "egrep", "fgrep", "rg", "ag", "ack"], { operands: true, posture: READ, dataOperands: 1, dataFlags: ["-e", "--regexp", "-g", "--glob", "-t", "--type", "--include", "--exclude"], valueFlags: ["-f", "--file"] }),
  cd: { operands: true, posture: READ },
  awk: { operands: true, posture: READ, dataOperands: 1, dataFlags: ["-F", "-v"], valueFlags: ["-f"] },
  // A reader that writes when told to.
  sed: { operands: true, posture: READ, writeFlags: ["-i", "--in-place"], dataOperands: 1, dataFlags: ["-e", "--expression"], valueFlags: ["-f", "--file"] },
  sort: { operands: true, posture: READ, writeFlags: ["-o", "--output"] },
  patch: { operands: true, posture: WRITE, valueFlags: ["-i", "-o", "-d", "--directory"] },
  tar: { operands: true, posture: WRITE, valueFlags: ["-f", "-C", "-T", "--file", "--directory", "--files-from"] },
  rsync: { operands: true, posture: WRITE, valueFlags: ["--exclude-from", "--include-from", "--files-from", "--log-file", "-e"] },
  // Fetching writes a file when asked to.
  curl: { posture: READ, valueFlags: ["-o", "--output", "-T", "--upload-file", "-K", "--config", "--cacert", "--cert", "--key"], inlineFlags: ["--output", "--upload-file", "--config"], dataFlags: ["-w", "--write-out", "-H", "--header", "-X", "--request", "-d", "--data", "--url", "-m", "--max-time"] },
  wget: { posture: WRITE, valueFlags: ["-O", "--output-document", "-P", "--directory-prefix", "-i", "--input-file"] },
  // Dispatchers: a sub-command decides the posture, a flag names the directory.
  git: {
    operands: true,
    posture: EITHER,
    valueFlags: ["-C", "--git-dir", "--work-tree", "--exec-path"],
    inlineFlags: ["--git-dir", "--work-tree"],
    subcommands: GIT_POSTURE,
    usesCwd: true,
  },
  npm: { operands: true, posture: EITHER, valueFlags: ["--prefix", "--cwd", "-C"], inlineFlags: ["--prefix", "--cwd"] },
  pnpm: { operands: true, posture: EITHER, valueFlags: ["--prefix", "--cwd", "-C", "--dir"], inlineFlags: ["--prefix", "--cwd", "--dir"] },
  yarn: { operands: true, posture: EITHER, valueFlags: ["--cwd"], inlineFlags: ["--cwd"] },
  bun: { operands: true, posture: EITHER, valueFlags: ["--cwd"], inlineFlags: ["--cwd"] },
  make: { operands: true, posture: EITHER, valueFlags: ["-C", "--directory", "-f", "--file", "--makefile"], inlineFlags: ["--directory", "--file", "--makefile"] },
  docker: { posture: EITHER, valueFlags: ["-v", "--volume", "--mount", "-w", "--workdir", "-f", "--file", "--env-file", "--config"], inlineFlags: ["--volume", "--mount", "--workdir", "--file", "--config"] },
  podman: { posture: EITHER, valueFlags: ["-v", "--volume", "--mount", "-w", "--workdir", "-f", "--file"], inlineFlags: ["--volume", "--mount", "--workdir", "--file"] },
  kubectl: { posture: EITHER, valueFlags: ["-f", "--filename", "--kubeconfig", "--context"], inlineFlags: ["--filename", "--kubeconfig"] },
  helm: { posture: EITHER, valueFlags: ["-f", "--values", "--kubeconfig"], inlineFlags: ["--values", "--kubeconfig"] },
  cargo: { operands: true, posture: EITHER, valueFlags: ["--manifest-path", "--target-dir"], inlineFlags: ["--manifest-path", "--target-dir"] },
  go: { operands: true, posture: EITHER, valueFlags: ["-C", "-o", "-modfile"] },
  // Language runtimes: the first operand may be an entry script; a -e/-c/-m value
  // is program text or a module name, never a path.
  node: { entryOperands: 1, posture: READ, dataFlags: ["-e", "--eval", "-p", "--print", "-r", "--require", "-m"] },
  python: { entryOperands: 1, posture: READ, dataFlags: ["-c", "-m", "-W", "-X"] },
  python3: { entryOperands: 1, posture: READ, dataFlags: ["-c", "-m", "-W", "-X"] },
};

const stripQuotes = (word: string): string => word.replace(/^["']|["']$/g, "");

/**
 * Is this word shaped like a path the user would expect us to gate?
 *
 * Deliberately narrow: a bare relative word with a slash is *not* path-shaped,
 * so `origin/main`, `HEAD:src/x` and a regex pattern never become claims. They
 * still count when they exist on disk, which is what pulls in `src/app.ts`.
 */
function pathShaped(word: string): boolean {
  const value = stripQuotes(word);
  if (!value || value.startsWith("-")) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return false; // URL
  return value.startsWith("/") || value.startsWith("~") || value.startsWith("./")
    || value.startsWith("../") || value === ".." || value.startsWith(".\\")
    || /^[A-Za-z]:[\\/]/.test(value);
}

/** Does this word name something that exists, relative to the workspace? */
function existing(cwd: string, word: string): boolean {
  try {
    statSync(resolve(cwd, expandHome(stripQuotes(word))));
    return true;
  } catch {
    return false;
  }
}

/** File or directory from the filesystem, `unknown` when it does not exist yet. */
function kindOf(cwd: string, word: string): "file" | "directory" | "unknown" {
  try {
    return statSync(resolve(cwd, expandHome(stripQuotes(word)))).isDirectory() ? "directory" : "file";
  } catch {
    return "unknown";
  }
}

/** Index of the sub-command word, skipping flags and the values they consume. */
function subcommandIndex(args: readonly string[], spec: PathSpec): number {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (spec.valueFlags?.includes(arg)) {
      index++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return index;
  }
  return -1;
}

/** The value attached to a short flag, as in `git -C../elsewhere status`. */
function attachedFlagValue(spec: PathSpec, arg: string): string | undefined {
  for (const flag of spec.valueFlags ?? []) {
    if (!flag.startsWith("-") || flag.startsWith("--") || flag.length > 3) continue;
    if (arg.length > flag.length && arg.startsWith(flag)) return arg.slice(flag.length);
  }
  return undefined;
}



/** Does this word look like a filesystem path rather than a flag or a bare name? */

/**
 * Extract path claims from a shell command.
 *
 * A bare relative filename is deliberately not a claim: it resolves under the
 * cwd, which is in scope. Absolute paths, `~`, `./`, `../` and anything with a
 * separator are, as are redirection targets — those are exactly how a command
 * leaves the workspace.
 */
export function shellClaim(command: unknown, cwd: string): ClaimSet {
  if (typeof command !== "string" || !command.trim()) {
    return {
      paths: [{ raw: cwd, write: true, posture: "write", kind: "directory", action: "bash" }],
      unknown: false,
    };
  }

  // Parse, never execute. A quoted string, a loop value and the output of a `$()`
  // are different things, and only the parse tells them apart — which is why
  // `grep '$(x)|/etc/hosts'` and a `for … ; do code=$(curl …) ; done` loop stop
  // asking, while `cat $(pwd)/x` still does.
  const scan = scanShell(command);
  const opaque = (reason: string): ClaimSet => ({ paths: [], unknown: true, opaque: reason, reason });
  if (scan.reason) return opaque(scan.reason);

  const commandReads = readOnlyShellCommand(command) !== undefined;
  const paths: PathRequest[] = [];
  const seen = new Set<string>();
  // A `cd` inside this scope changes what a later relative path means; a
  // subshell or `$()` starts from the cwd it inherited.
  const bases: string[] = [resolve(cwd)];

  const claim = (word: ShellWord, posture: ScopePosture, base: string, source: string, kind?: PathRequest["kind"]): void => {
    const raw = word.value ?? stripQuotes(word.text);
    if (!raw || raw === "-" || /^[<>|&;()]+$/.test(raw)) return;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) return;
    if (seen.has(`${base}\u0000${raw}`)) return;
    seen.add(`${base}\u0000${raw}`);
    paths.push({
      raw,
      base,
      write: posture === "write",
      posture,
      kind: kind ?? kindOf(base, raw),
      action: "bash",
      command: source,
    });
  };

  for (const item of scan.commands) {
    if (item.scope === "enter") {
      bases.push(bases[bases.length - 1]!);
      continue;
    }
    if (item.scope === "leave") {
      if (bases.length > 1) bases.pop();
      continue;
    }
    const base = bases[bases.length - 1]!;
    const source = item.source || command;

    for (const redirect of item.redirects) {
      if (redirect.target.value === undefined) {
        return opaque(`a redirect target is computed at runtime (${redirect.target.text})`);
      }
      claim(redirect.target, redirect.write ? "write" : "read", base, source);
    }

    const first = item.words[0];
    if (!first) continue;
    if (first.value === undefined) return opaque(`the command name "${first.text}" is computed at runtime`);
    let binary = (first.value.split("/").pop() ?? "").trim();
    let args = item.words.slice(1);

    // Unwrap `sudo`, `env`, `timeout 120`, `nice -n 5`, … so the real binary decides.
    for (let depth = 0; depth < 3 && WRAPPERS.has(binary); depth++) {
      let index = 0;
      while (index < args.length && (args[index]!.text.startsWith("-") || (binary === "timeout" && /^\d/.test(args[index]!.text)))) index++;
      const next = args[index];
      if (!next?.value) return opaque(`"${binary}" wraps a command the gate cannot read`);
      binary = (next.value.split("/").pop() ?? "").trim();
      args = args.slice(index + 1);
    }

    if (OPAQUE_BINARIES.has(binary)) return opaque(`"${binary}" runs code the gate cannot read`);
    if (INTERPRETERS.has(binary)) {
      // A shell's -c argument is another shell program the gate cannot see, so the
      // call is opaque. A language runtime's -e/-c argument is data: it produces no
      // path claim and does not make the call unreadable.
      if (SHELLS.has(binary) && args.some(arg => INLINE_CODE_FLAGS.has(arg.text))) {
        return opaque(`"${binary}" was given inline code (-c)`);
      }
      if (item.heredoc) return opaque(`"${binary}" reads a heredoc as a program`);
    }
    if (binary === "find" && args.some(arg => arg.text === "-exec" || arg.text === "-execdir")) {
      return opaque("find -exec runs code the gate cannot read");
    }

    if (binary === "cd" || binary === "pushd") {
      const target = args.find(arg => !arg.text.startsWith("-"));
      const next = target ? (target.value ?? (pathShaped(target.text) ? stripQuotes(target.text) : undefined)) : process.env.HOME;
      if (next === undefined) return opaque("the working directory is computed at runtime");
      // A directory change reads the directory; it does not write to it. Treating
      // it as a write is what made `cd <read-only root> && git fetch` ask.
      claim({ text: next, value: next }, "read", base, source, "directory");
      bases[bases.length - 1] = resolve(base, expandHome(next));
      continue;
    }

    const spec = SPECS[binary];
    const writes = spec?.writeFlags?.some(flag => args.some(arg => arg.text === flag || arg.text.startsWith(`${flag}=`))) ?? false;
    const subIndex = spec?.subcommands ? subcommandIndex(args.map(arg => arg.text), spec) : -1;
    const sub = subIndex >= 0 ? args[subIndex]!.value : undefined;
    const posture: ScopePosture = writes
      ? "write"
      : (sub ? spec?.subcommands?.[sub] : undefined) ?? spec?.posture ?? (commandReads ? "read" : "unknown");

    if (spec?.usesCwd && !spec.valueFlags?.some(flag => args.some(arg => arg.text === flag || arg.text.startsWith(`${flag}=`)))) {
      // `git status` acts on the cwd; `git -C ../x status` names it explicitly.
      claim({ text: ".", value: "." }, posture, base, source, "directory");
    }

    if (!spec) {
      // No table entry: an arbitrary program's arguments belong to that program.
      // This is the `node /c /e` class — a slash in an application argument is
      // data, not a filesystem claim — so nothing here becomes a path claim. The
      // command text is still covered by rules, and its cd/redirect channels were
      // already judged above.
      continue;
    }

    let data = spec.dataOperands ?? 0;
    let entry = 0;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (spec.dataFlags?.some(flag => arg.text === flag || arg.text.startsWith(`${flag}=`))) {
        // The value is data (a pattern, a write-out format, a URL), not a path.
        index++;
        continue;
      }
      const inline = spec.inlineFlags?.find(flag => arg.text.startsWith(`${flag}=`));
      if (inline) {
        const value = arg.text.slice(inline.length + 1);
        claim({ text: value, value }, posture, base, source);
        continue;
      }
      if (spec.valueFlags?.includes(arg.text)) {
        const value = args[index + 1];
        if (value) {
          if (value.value === undefined) return opaque(`a path argument is computed at runtime (${value.text})`);
          claim(value, posture, base, source);
        }
        index++;
        continue;
      }
      if (arg.text.startsWith("-")) {
        const attached = attachedFlagValue(spec, arg.text);
        if (attached) claim({ text: attached, value: attached }, posture, base, source);
        continue;
      }
      if (index === subIndex) continue;
      if (spec.entryOperands !== undefined) {
        // Only the leading operands can be entry scripts, and an interpreter takes
        // one: in `node /c /e`, /c is the script (a read) and /e is the program's
        // own argument (not a claim). A relative script that exists inside the
        // workspace still resolves inside it, so it costs nothing to name.
        if (entry >= spec.entryOperands) continue;
        entry++;
        if (arg.value === undefined) {
          if (pathShaped(arg.text)) return opaque(`an entry script is computed at runtime (${arg.text})`);
          continue;
        }
        if (!pathShaped(arg.text) && !existing(base, arg.value)) continue;
        claim(arg, "read", base, source);
        continue;
      }
      if (data > 0) {
        data--;
        continue;
      }
      if (!spec.operands) continue;
      if (arg.value === undefined) {
        // A word that computes a path (`$(pwd)/x`, `$DIR/x`) cannot be judged, and
        // dropping it silently is how a real escape would slip through.
        if (pathShaped(arg.text) || /[/\\]/.test(arg.text)) {
          return opaque(`a path argument is computed at runtime (${arg.text})`);
        }
        continue;
      }
      if (!pathShaped(arg.text) && !existing(base, arg.value)) continue;
      claim(arg, posture, base, source);
    }
  }

  return { paths, unknown: false };
}


export interface ClaimOptions {
  cwd: string;
}

/** Map one gated tool call to the paths it claims (or to "unknown"). */
export function claimSetFor(tool: string, input: Record<string, unknown> | undefined, options: ClaimOptions): ClaimSet {
  // Jurisdiction first, before any table lookup, so no future entry can quietly
  // widen it: a tool outside the gated set bypasses the gate entirely.
  if (!GATED_TOOLS.has(tool)) return { paths: [], unknown: false };

  if (tool === "bash") return shellClaim(input?.command, options.cwd);

  // `GATED_TOOLS` is exactly `bash` plus the table's names, so the entry exists.
  const table = PATH_TOOLS[tool]!;
  const paths: PathRequest[] = [];
  for (const field of table.fields) {
    const value = input?.[field];
    if (typeof value !== "string" || !value.trim()) continue;
    paths.push({ raw: value, write: table.write, posture: table.write ? "write" : "read", kind: table.kind, action: tool });
  }
  if (!paths.length && table.fallback === "cwd") {
    paths.push({ raw: options.cwd, write: table.write, posture: table.write ? "write" : "read", kind: table.kind, action: tool });
  }
  return { paths, unknown: false };
}

/** Display helper for the dialog: workspace-relative where possible. */
export function displayPath(cwd: string, absolute: string): string {
  const slashed = toResourceSlash(absolute);
  const base = toResourceSlash(cwd);
  return slashed === base ? "." : slashed.startsWith(`${base}/`) ? slashed.slice(base.length + 1) : slashed;
}
