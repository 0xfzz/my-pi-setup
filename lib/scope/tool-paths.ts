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
import { readOnlyShellCommand } from "../plan-shell.ts";
import { toResourceSlash } from "./paths.ts";

export interface PathRequest {
  /** Path as typed by the model; the gate resolves it against the cwd. */
  raw: string;
  write: boolean;
  kind: "file" | "directory" | "unknown";
  /** Rule action: the tool name, so per-tool rules keep working. */
  action: string;
}

export interface ClaimSet {
  paths: PathRequest[];
  unknown: boolean;
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

/** The program each `|`/`&&`/`;` segment runs, with wrappers and `VAR=1` skipped. */
function segmentBinaries(tokens: readonly string[]): string[] {
  const binaries: string[] = [];
  let expectBinary = true;
  for (const token of tokens) {
    if (/^[|&;]+$/.test(token)) {
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
      // Keep redirection targets as their own marker so the next word is a path.
      if (char === ">" || char === "<") out.push(char);
      continue;
    }
    word += char;
    started = true;
  }
  if (started) out.push(word);
  return out;
}

/** Does this word look like a filesystem path rather than a flag or a bare name? */
function looksLikePath(word: string): boolean {
  if (!word || word.startsWith("-")) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(word)) return false; // URL
  return word.startsWith("~") || word.startsWith("/") || word.startsWith("./")
    || word.startsWith("../") || word === ".." || word.includes("/") || word.includes("\\");
}

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
    return { paths: [{ raw: cwd, write: true, kind: "directory", action: "bash" }], unknown: false };
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
  // inspection. Anything else is treated as capable of writing.
  const write = readOnlyShellCommand(command) === undefined;
  const tokens = words(command);
  const paths: PathRequest[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const afterRedirect = tokens[index - 1] === ">" || tokens[index - 1] === "<";
    if (!afterRedirect && !looksLikePath(token)) continue;
    // A quoted flag-looking word after a redirect is still a path; skip only
    // obvious separators.
    if (/^[<>|&;]+$/.test(token) || token === "-") continue;
    const raw = token.replace(/^["']|["']$/g, "");
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    paths.push({ raw, write, kind: "unknown", action: "bash" });
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
      paths.push({ raw: value, write: table.write, kind: table.kind, action: tool });
    }
    if (!paths.length && table.fallback === "cwd") {
      paths.push({ raw: options.cwd, write: table.write, kind: table.kind, action: tool });
    }
    if (!paths.length) return { paths, unknown: false };
    return { paths, unknown: false };
  }

  if (isMcpTool(tool)) {
    const field = options.mcpPathFields?.[tool];
    const value = field ? input?.[field] : undefined;
    if (typeof value === "string" && value.trim()) {
      return { paths: [{ raw: value, write: true, kind: "unknown", action: tool }], unknown: false };
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
