import { homedir } from "node:os";

/** A deliberately small shell language for Plan inspection, not a general shell sandbox.
 * Parse and re-quote every argument: no expansion, redirection, scripts or executable pipelines.
 * Unknown commands and unsafe options fail closed; use read/search tools for unsupported inspections. */
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const READ_COMMANDS = new Set(["pwd", "ls", "cat", "head", "tail", "wc", "stat", "du", "df", "readlink", "realpath", "basename", "dirname", "uname", "whoami", "id", "printenv", "echo"]);
const FIND_FLAGS = new Set(["-L", "-P", "-H", "-name", "-iname", "-path", "-ipath", "-regex", "-iregex", "-type", "-size", "-mtime", "-mmin", "-maxdepth", "-mindepth", "-print", "-print0", "-ls", "-empty", "-readable", "-writable", "-executable", "-not", "-and", "-or", "-o", "-a", "-true", "-false", "-follow"]);
const GIT_COMMANDS = new Set(["status", "log", "diff", "show", "ls-files", "ls-tree", "rev-parse"]);

interface CommandSegment {
  words: string[];
  stderrNull?: boolean;
}

export function readOnlyShellCommand(command: unknown): string | undefined {
  if (typeof command !== "string" || !command.trim() || /[\r\n\0$`]/.test(command)) return;
  const parts: (CommandSegment | "|" | "&&" | ";")[] = [];
  let words: string[] = [], word = "", started = false, quoted: string | undefined;
  let currentStderrNull = false;
  const flushWord = () => { if (started) words.push(word); word = ""; started = false; };
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quoted) {
      if (char === quoted) quoted = undefined;
      else if (char === "\\" && quoted === '"') { if (++i >= command.length) return; word += command[i]; }
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quoted = char; started = true; continue; }
    if (char === "\\") { if (++i >= command.length) return; word += command[i]; started = true; continue; }
    if (/\s/.test(char)) { flushWord(); continue; }
    if (char === "|" || char === "&" || char === ";") {
      flushWord();
      const separator = char === "&" && command[i + 1] === "&" ? "&&" : char === "|" && command[i + 1] !== "|" ? "|" : char === ";" ? ";" : undefined;
      if (!separator || !words.length) return;
      if (separator === "&&") i++;
      parts.push({ words, stderrNull: currentStderrNull }, separator);
      words = [];
      currentStderrNull = false;
      continue;
    }
    // Allow ~/ or ~ at start of word (tilde expansion)
    if (char === "~" && !started && (command[i + 1] === "/" || command[i + 1] === undefined || /\s|\||&/.test(command[i + 1]!))) {
      word += homedir();
      started = true;
      continue;
    }
    // Allow 2>/dev/null or 2> /dev/null stderr redirection
    if (char === "2" && !started) {
      if (command.startsWith("2>/dev/null", i)) {
        currentStderrNull = true;
        i += 10;
        continue;
      }
      if (command.startsWith("2> /dev/null", i)) {
        currentStderrNull = true;
        i += 11;
        continue;
      }
    }
    if (/[<>()[\]{}#!~*?]/.test(char)) return; // Quote literal glob/path characters; no shell expansion.
    word += char; started = true;
  }
  if (quoted) return;
  flushWord();
  if (!words.length) return;
  parts.push({ words, stderrNull: currentStderrNull });
  const safe: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (typeof part === "string") { safe.push(part); continue; }
    const { words: segWords, stderrNull } = part;
    const [name, ...args] = segWords;
    let prefix: string[] = [];
    if (name === "cd") {
      // cd in a pipeline cannot affect following commands and has surprising semantics.
      if (args.length !== 1 || args[0]!.startsWith("-") || parts[index - 1] === "|" || (index < parts.length - 1 && parts[index + 1] !== "&&")) return;
    } else if (name === "rg") {
      if (args.some(arg => /^--(?:pre|hostname-bin|search-zip)(?:=|$)/.test(arg) || /^-[^-]*z/.test(arg))) return;
      prefix = ["--no-config"];
    } else if (name === "grep") {
      // GNU grep has no command execution or file-output options.
    } else if (name === "find") {
      if (args.some(arg => arg.startsWith("-") && !FIND_FLAGS.has(arg) && !/^-\d+$/.test(arg))) return;
    } else if (name === "env") {
      // `env` with no arguments prints the environment, exactly like the already-
      // allowed `printenv`. With a non-flag argument it becomes a launcher
      // (`env FOO=1 ./x`), so only flags are accepted.
      if (args.some(arg => !arg.startsWith("-"))) return;
    } else if (name === "git") {
      // `git -C <path> <cmd>` is how a reviewer inspects another worktree or repo;
      // the path stays a quoted literal, so no expansion is introduced.
      let pathFlags: string[] = [];
      while (args.length >= 2 && args[0] === "-C" && !args[1]!.startsWith("-")) { pathFlags = pathFlags.concat(args.slice(0, 2)); args.splice(0, 2); }
      if (!GIT_COMMANDS.has(args[0] ?? "") || args.some(arg => /^(?:--(?:o|ou|out|outp|outpu|output|(?:no-)*(?:ext-diff|textconv)|exec-path|config-env)(?:=|$)|-[cC])/.test(arg))) return;
      prefix = ["--no-pager", "--no-optional-locks", ...pathFlags, "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.hooksPath=/dev/null"];
      if (["diff", "show", "log"].includes(args[0]!)) args.splice(1, 0, "--no-ext-diff", "--no-textconv");
    } else if (!READ_COMMANDS.has(name!)) return;
    const rendered = [name!, ...prefix, ...args].map(quote).join(" ");
    safe.push(stderrNull ? `${rendered} 2>/dev/null` : rendered);
  }
  return safe.join(" ");
}
