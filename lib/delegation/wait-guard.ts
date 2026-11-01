/**
 * wait-guard.ts — the parent may not wait; it ends its turn and is re-triggered.
 *
 * The failure this addresses was observed, not theorised: a parent session spent
 * six minutes in `bash sleep` waiting for a child, which is the one thing the
 * delegation contract forbids. `RETRIGGER_CONTRACT` said "do not sleep" in prose
 * on every result that started asynchronous work, and the parent did it anyway.
 * Prose is a request; this module is the rule.
 *
 * Two decisions shape it:
 *
 *   1. It refuses a command whose PURPOSE is to wait, not a command that happens
 *      to take time. `npm test` may run for a minute; `sleep 60 && npm test` is a
 *      wait wearing a build as a hat. Wrapping a wait in a pipeline, a subshell or
 *      an `&&` chain does not hide it, because each segment is segmented first.
 *
 *   2. It applies to the PARENT only. A child waiting on its own build is doing
 *      the work it was given; a parent waiting on a child is polling a channel
 *      that already pushes. The caller decides which side it is on, and the guard
 *      says so in its own name rather than inferring it.
 *
 * Deliberately NOT refused: `pnpm install`, `cargo build`, `npm test`,
 * `docker compose up -d`, long `git` operations. Those are work. The refusal
 * names the re-trigger contract so the parent is told what to do instead, which
 * is the difference between a guard and an obstacle.
 */

export const WAIT_GUARD_SETTING = "delegation.suppressWaitGuard";

/** The sentence the parent gets instead of the wait. Kept here so tests pin it. */
export const WAIT_GUARD_REASON =
  "Refused: the parent must not wait. A child's completion, its question and its budget/stall all arrive as "
  + "messages that re-trigger this session, so end your turn and act when one arrives. "
  + "Delegate the wait to a child if something really must block, or ask the user.";

/**
 * Commands whose whole purpose is to block for a while.
 *
 * Matched as the FIRST word of a segment, after leading assignments and wrapper
 * words are stripped (`env FOO=1 sleep 5` is still a sleep).
 */
const WAIT_COMMANDS: ReadonlySet<string> = new Set([
  "sleep",
  "wait",
  "watch",
  "tail",       // only with -f; checked below
  "ping",       // only with a count that is absent/unbounded; checked below
]);

/** Shell builtins that run a command, so `timeout 60 sleep 5` is still a wait. */
const WRAPPERS: ReadonlySet<string> = new Set([
  "sudo", "env", "nohup", "time", "command", "exec", "timeout", "xargs", "stdbuf",
]);

/** Loops that never terminate on their own. */
const UNBOUNDED_LOOP = /^\s*(?:while\s+(?:true|:|1)\b|until\s+(?:false|0)\b|for\s*\(\s*\(\s*;\s*;\s*\))/;

/**
 * Split a command line into the segments that would each run on their own.
 *
 * Segmentation is deliberately crude: `;`, `&&`, `||`, `|`, newline and `&`. It
 * only needs to be good enough to find a waiting segment; it is not a shell
 * parser and must not be relied on for anything but this guard.
 */
export function commandSegments(command: string): string[] {
  return String(command ?? "")
    .split(/;|&&|\|\||\||\n|&(?!&)/)
    .map(segment => segment.trim())
    .filter(Boolean);
}

/** `sudo`/`/usr/bin/env`/`nohup` all name the same wrapper; compare basenames. */
function commandBasename(word: string): string {
  return word.split("/").pop() ?? word;
}

/** The leading command word of a segment, with assignments and wrappers stripped. */
export function leadingCommand(segment: string): string {
  const words = segment.trim().split(/\s+/);
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    // A leading VAR=value assignment says nothing about which command runs.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    if (WRAPPERS.has(commandBasename(word))) continue;
    // A wrapper's own argument that is a number (timeout 60 …) is not the command.
    if (/^\d+[smhd]?$/.test(word)) continue;
    return word;
  }
  return "";
}

/**
 * A shell that was handed a command string: `bash -c '…'`, `sh -c "…"`.
 *
 * Without descending into it, `bash -c 'sleep 60'` reads as "a bash invocation",
 * which is technically work and practically the exact wait this guard exists to
 * refuse. Only `-c` is followed; an interactive shell or a script file is left
 * alone, because its body is not in the command line.
 */
function shellInlineScript(segment: string): string | undefined {
  const match = /(?:^|\s)(?:bash|sh|zsh|dash)\s+(?:-[a-zA-Z]*c[a-zA-Z]*\s+)?(['"])([\s\S]*)\1/.exec(segment);
  return match?.[2];
}

/** Is this segment a command that exists to wait? */
function segmentWaits(segment: string): string | undefined {
  if (UNBOUNDED_LOOP.test(segment)) {
    return "an unbounded loop";
  }
  const command = leadingCommand(segment);
  if (!command) return undefined;
  const base = command.split("/").pop() ?? command;
  if (!WAIT_COMMANDS.has(base)) return undefined;

  // `tail -f file` follows forever; `tail -n 20 file` is a read.
  if (base === "tail") {
    return /(?:^|\s)-[a-zA-Z]*f/.test(segment) || /--follow/.test(segment) ? "tail -f" : undefined;
  }
  // `ping host` with no count pings forever; `ping -c 3 host` is a probe.
  if (base === "ping") {
    return /(?:^|\s)-c\s*\d+|--count[= ]\d+/.test(segment) ? undefined : "an unbounded ping";
  }
  return base;
}

/**
 * The refusal text, or undefined when the command is allowed to run.
 *
 * `undefined` for a non-string command: this guard only understands shell text,
 * and guessing at a structured invocation is how a guard starts blocking work it
 * cannot see.
 */
export function waitCommandProblem(command: unknown): string | undefined {
  if (typeof command !== "string" || !command.trim()) return undefined;
  for (const segment of commandSegments(command)) {
    const wait = segmentWaits(segment);
    if (wait) return `${WAIT_GUARD_REASON} (blocked: ${wait})`;
    // `bash -c 'sleep 60'` is a wait with a shell in front of it.
    const inline = shellInlineScript(segment);
    if (inline) {
      const nested = waitCommandProblem(inline);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** Is this tool invocation the one the guard governs? */
export function isWaitGuardTool(toolName: string): boolean {
  // `bash` is Pi's shell. The MCP/codemode gateways are not governed here: they
  // are already refused for a parent that cannot judge what they run, and adding
  // a second, weaker opinion about their arguments would hide that.
  return toolName === "bash";
}
