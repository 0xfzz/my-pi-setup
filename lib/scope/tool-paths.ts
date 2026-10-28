/**
 * Which paths a tool call claims to touch.
 *
 * The gate can only judge what it can see, so this file is explicit about the
 * three answers it can give:
 *
 *   - `paths`   — the tool declares path inputs we understand (`read`, `write`,
 *                 `edit`, `grep`, `find`, `ls`) or it is a shell command whose
 *                 path-like arguments we can extract.
 *   - *nothing* — the tool is session state (`todo_*`, `artifact_*`, `ask_user`,
 *                 delegation) or declares `readOnlyHint` without path inputs.
 *   - `unknown` — the tool might touch anything (an unmapped MCP server, a
 *                 dispatcher, `bash -c`, `find -exec`). Policy answers this with
 *                 `defaults.unknown`, which is `ask` unless a team says otherwise.
 *
 * The important failure mode is a silent fourth answer: assuming "no path inputs"
 * means "no filesystem access". Anything that is neither tabled nor annotated is
 * `unknown`, never a pass.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { readOnlyShellCommand } from "../plan-shell.ts";
import { expandHome, toResourceSlash } from "./paths.ts";
import type { ScopePosture } from "./types.ts";

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
 * Tools that provably do not touch the filesystem, or whose filesystem work is
 * gated elsewhere. Delegation verbs are listed because the CHILD session runs its
 * own gate; the parent spawn call only starts a process.
 */
const NO_FS_CLAIM: ReadonlySet<string> = new Set([
  "ask_user", "session_goal", "workflow_todo", "todo_plan", "todo_act", "todo_next",
  "artifact_list", "artifact_recall", "artifact_save", "artifact_edit", "artifact_search",
  "web_read", "web_fetch", "google_search", "generate_image",
  "agent_spawn", "agent_running", "agent_steer", "agent_interrupt", "agent_close", "agent_escalate",
  "agent_history", "agent_progress", "agent_done", "agent_ping", "agent_handoff", "agent_resume",
  "agent_plan", "agent_review", "agent_parent_recall", "agent_parent_digest",
]);

const NO_FS_PREFIXES = ["vcc_", "todo_", "artifact_", "dashboard_", "subagent_", "workflow_"];

/** Constructs that make a command's real effect unknowable to a tokenizer. */
/**
 * Constructs that hide code from the token scan: the code runs at runtime, so the
 * paths in the text are not the paths the command touches.
 */
const CODE_HIDING = ["$(", "`", "<(", ">(", "xargs ", "-exec", "-execdir", "eval ", "exec "];

/** Inline code passed as a flag value: the flag *is* the program. */
const INLINE_CODE = [
  "bash -c", "sh -c", "zsh -c", "fish -c", "python -c", "python3 -c",
  "node -e", "node -p", "perl -e", "ruby -e", "php -r", "deno eval", "bun -e",
];

/**
 * Binaries whose heredoc body is *code*, not data. `git commit -F - <<EOF` feeds
 * data and must keep working; `python3 <<EOF` feeds a program and must not be
 * mistaken for a harmless redirect.
 */
const INTERPRETERS = new Set([
  "python", "python3", "node", "deno", "bun", "perl", "ruby", "php",
  "bash", "sh", "zsh", "fish", "osascript",
]);

const WRAPPERS = new Set(["sudo", "env", "time", "nice", "nohup", "command", "exec"]);

/** Shell operators that end one command segment and start the next. */
const OPERATORS: ReadonlySet<string> = new Set(["|", "&", ";"]);

/** The program each `|`/`&&`/`;` segment runs, with wrappers and `VAR=1` skipped. */
function segmentBinaries(tokens: readonly string[]): string[] {
  const binaries: string[] = [];
  let expectBinary = true;
  for (const token of tokens) {
    if (OPERATORS.has(token) || /^[|&;()]+$/.test(token)) {
      expectBinary = true;
      continue;
    }
    if (!expectBinary) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    const bare = token.replace(/^["']|["']$/g, "");
    if (WRAPPERS.has(bare)) continue;
    expectBinary = false;
    binaries.push(bare.split("/").pop() ?? bare);
  }
  return binaries;
}

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
   * Positional operands. `true` claims every one; `"lazy"` claims only the
   * path-shaped or existing ones, so `grep foo` and `git checkout origin/main`
   * claim nothing at all.
   */
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
  // A reader that writes when told to.
  sed: { operands: true, posture: READ, writeFlags: ["-i", "--in-place"] },
  sort: { operands: true, posture: READ, writeFlags: ["-o", "--output"] },
  patch: { operands: true, posture: WRITE, valueFlags: ["-i", "-o", "-d", "--directory"] },
  tar: { operands: true, posture: WRITE, valueFlags: ["-f", "-C", "-T", "--file", "--directory", "--files-from"] },
  rsync: { operands: true, posture: WRITE, valueFlags: ["--exclude-from", "--include-from", "--files-from", "--log-file", "-e"] },
  // Fetching writes a file when asked to.
  curl: { posture: READ, valueFlags: ["-o", "--output", "-T", "--upload-file", "-K", "--config", "--cacert", "--cert", "--key"], inlineFlags: ["--output", "--upload-file", "--config"] },
  wget: { posture: WRITE, valueFlags: ["-O", "--output-document", "-P", "--directory-prefix", "-i", "--input-file"] },
  // Dispatchers: a sub-command decides the posture, a flag names the directory.
  git: {
    operands: true,
    posture: EITHER,
    valueFlags: ["-C", "--git-dir", "--work-tree", "--exec-path"],
    inlineFlags: ["--git-dir", "--work-tree"],
    subcommands: GIT_POSTURE,
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
  python: { operands: true, posture: EITHER },
  python3: { operands: true, posture: EITHER },
  node: { operands: true, posture: EITHER },
};

/** Split a token list into one segment per `|` / `&` / `;`. */
function segments(tokens: readonly string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (OPERATORS.has(token)) {
      if (current.length) out.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length) out.push(current);
  return out;
}

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

function isNoClaim(tool: string): boolean {
  return NO_FS_CLAIM.has(tool) || NO_FS_PREFIXES.some(prefix => tool.startsWith(prefix));
}

function isMcpTool(tool: string): boolean {
  return tool === "mcp" || tool.startsWith("mcp__") || tool.startsWith("mcp_");
}

/** Split a shell command into words, keeping quoted segments intact. */
function words(command: string): string[] {
  const out: string[] = [];
  let word = "";
  let quoted: string | undefined;
  let started = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quoted) {
      if (char === quoted) quoted = undefined;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quoted = char;
      started = true;
      continue;
    }
    if (char === "\\") {
      if (++index < command.length) word += command[index];
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) out.push(word);
      word = "";
      started = false;
      continue;
    }
    if (char === ">" || char === "<" || char === "|" || char === "&" || char === ";" || char === "(" || char === ")") {
      if (started) out.push(word);
      word = "";
      started = false;
      // Keep redirection and list operators as their own tokens: the first marks
      // the next word as a path, the rest mark a segment boundary.
      if (char === ">" || char === "<" || char === "|" || char === "&" || char === ";") out.push(char);
      continue;
    }
    word += char;
    started = true;
  }
  if (started) out.push(word);
  return out;
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
  const lowered = command.toLowerCase();
  const marker = [...CODE_HIDING, ...INLINE_CODE].find(candidate => lowered.includes(candidate));
  // A heredoc is only opaque when its body is code. `git commit -F - <<EOF` is a
  // data pipe and used to be denied as "paths cannot be determined".
  const codeHeredoc = lowered.includes("<<") && segmentBinaries(words(command)).some(binary => INTERPRETERS.has(binary));
  if (marker || codeHeredoc) {
    return {
      paths: [],
      unknown: true,
      reason: marker
        ? `bash command contains "${marker}", so its paths cannot be determined`
        : "bash feeds a heredoc to an interpreter, so its paths cannot be determined",
    };
  }

  // `readOnlyShellCommand` is the project's existing conservative judgement: it
  // returns a normalized command only when every segment is a known read-only
  // inspection. It now sets the *posture* of a binary with no table entry instead
  // of turning the whole command into a write, which is what made `npm test`
  // reading `../shared/x` look like a mutation.
  const commandReads = readOnlyShellCommand(command) !== undefined;
  const paths: PathRequest[] = [];
  const seen = new Set<string>();

  const push = (word: string, posture: ScopePosture, kind?: PathRequest["kind"]): void => {
    const raw = stripQuotes(word);
    if (!raw || raw === "-" || /^[<>|&;()]+$/.test(raw) || seen.has(raw)) return;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) return;
    seen.add(raw);
    paths.push({ raw, write: posture === "write", posture, kind: kind ?? kindOf(cwd, raw), action: "bash" });
  };

  for (const segment of segments(words(command))) {
    // Redirection targets first: `>` writes, `<` reads. `2>/dev/null` leaves the `2`
    // as an ordinary word, which is not path-shaped and is dropped.
    for (let index = 0; index < segment.length; index++) {
      const token = segment[index]!;
      if (token !== ">" && token !== "<") continue;
      let next = index + 1;
      while (next < segment.length && (segment[next] === ">" || segment[next] === "<")) next++;
      const target = segment[next];
      if (target) push(target, token === ">" ? "write" : "read");
    }

    const argv = segment.filter(token => token !== ">" && token !== "<");
    let start = 0;
    while (start < argv.length) {
      const token = argv[start]!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        start++;
        continue;
      }
      if (!WRAPPERS.has(stripQuotes(token))) break;
      start++;
      while (start < argv.length && (argv[start]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[start]!))) start++;
    }
    const binaryToken = argv[start];
    if (!binaryToken) continue;
    const binary = stripQuotes(binaryToken).split("/").pop() ?? "";
    const spec = SPECS[binary];
    const args = argv.slice(start + 1);

    const writes = spec?.writeFlags?.some(flag => args.some(arg => arg === flag || arg.startsWith(`${flag}=`))) ?? false;
    const subIndex = spec?.subcommands ? subcommandIndex(args, spec) : -1;
    const sub = subIndex >= 0 ? stripQuotes(args[subIndex]!) : undefined;
    const posture: ScopePosture = writes
      ? "write"
      : (sub ? spec?.subcommands?.[sub] : undefined) ?? spec?.posture ?? (commandReads ? "read" : "unknown");

    if (!spec) {
      // No table entry: only a word we can trust is a claim.
      for (const arg of args) if (pathShaped(arg) || existing(cwd, arg)) push(arg, posture);
      continue;
    }

    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      const inline = spec.inlineFlags?.find(flag => arg.startsWith(`${flag}=`));
      if (inline) {
        push(arg.slice(inline.length + 1), posture);
        continue;
      }
      if (spec.valueFlags?.includes(arg)) {
        const value = args[index + 1];
        if (value) push(value, posture);
        index++;
        continue;
      }
      if (arg.startsWith("-")) {
        const attached = attachedFlagValue(spec, arg);
        if (attached) push(attached, posture);
        continue;
      }
      if (index === subIndex) continue;
      if (spec.operands && (pathShaped(arg) || existing(cwd, arg))) push(arg, posture);
    }
  }

  return { paths, unknown: false };
}

export interface ClaimOptions {
  /** Path field overrides for MCP servers, keyed by tool name. */
  mcpPathFields?: Readonly<Record<string, string>>;
  /** Annotations from the registered tool, when pi knows them. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  cwd: string;
}

/** Map one tool call to the paths it claims (or to "unknown"). */
export function claimSetFor(tool: string, input: Record<string, unknown> | undefined, options: ClaimOptions): ClaimSet {
  if (tool === "bash") return shellClaim(input?.command, options.cwd);
  if (isNoClaim(tool)) return { paths: [], unknown: false };

  const table = PATH_TOOLS[tool];
  if (table) {
    const paths: PathRequest[] = [];
    for (const field of table.fields) {
      const value = input?.[field];
      if (typeof value !== "string" || !value.trim()) continue;
      paths.push({ raw: value, write: table.write, posture: table.write ? "write" : "read", kind: table.kind, action: tool });
    }
    if (!paths.length && table.fallback === "cwd") {
      paths.push({ raw: options.cwd, write: table.write, posture: table.write ? "write" : "read", kind: table.kind, action: tool });
    }
    if (!paths.length) return { paths, unknown: false };
    return { paths, unknown: false };
  }

  if (isMcpTool(tool)) {
    const field = options.mcpPathFields?.[tool];
    const value = field ? input?.[field] : undefined;
    if (typeof value === "string" && value.trim()) {
      return { paths: [{ raw: value, write: true, posture: "unknown", kind: "unknown", action: tool }], unknown: false };
    }
    return { paths: [], unknown: true, reason: `${tool} does not declare which paths it touches` };
  }

  // A read-only annotation with no path inputs is the only silent pass: the tool
  // promises it cannot modify anything, and it declared no path for us to check.
  if (options.annotations?.readOnlyHint === true && options.annotations.destructiveHint !== true) {
    return { paths: [], unknown: false };
  }
  return { paths: [], unknown: true, reason: `${tool} does not declare the paths it touches` };
}

/** Display helper for the dialog: workspace-relative where possible. */
export function displayPath(cwd: string, absolute: string): string {
  const slashed = toResourceSlash(absolute);
  const base = toResourceSlash(cwd);
  return slashed === base ? "." : slashed.startsWith(`${base}/`) ? slashed.slice(base.length + 1) : slashed;
}
