import { scanShell } from "../shell-syntax.ts";
import { planBwrap } from "./bwrap.ts";
import type { SandboxBackendId } from "./config.ts";
import type { SandboxPolicy } from "./policy.ts";
import { planSeatbelt } from "./seatbelt.ts";

/**
 * Escapes an argument for a POSIX shell command line using standard single-quote escaping:
 * replaces ' with '\''.
 */
export function quoteArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export interface WrapResult {
  command: string;
  argv: string[];
  env: Record<string, string>;
}

export type WrapOutcome = WrapResult | { block: string };

/**
 * Validates that the generated argv and command string pass self-checking:
 * 1. No NUL bytes anywhere.
 * 2. Shell parser can parse the produced command line.
 * 3. The parsed binary matches argv[0].
 * 4. Contains /bin/sh -c with the exact target command.
 */
export function formatAndValidateCommand(
  argv: readonly string[],
  originalCommand: string,
  env: Record<string, string> = {},
): WrapOutcome {
  for (const arg of argv) {
    if (arg.includes("\0")) {
      return { block: "command argument contains forbidden NUL character" };
    }
  }

  const wrappedCommand = argv.map(quoteArg).join(" ");
  const scan = scanShell(wrappedCommand);
  if (scan.reason) {
    return { block: `sandbox quoting self-check failed: ${scan.reason}` };
  }

  if (scan.commands.length === 0) {
    return { block: "sandbox quoting self-check failed: no command parsed" };
  }

  const firstCmd = scan.commands[0]!;
  const parsedBinary = firstCmd.words[0]?.value ?? firstCmd.words[0]?.text;
  if (parsedBinary !== argv[0]) {
    return { block: `sandbox quoting self-check failed: binary mismatch (${parsedBinary} !== ${argv[0]})` };
  }

  // Ensure /bin/sh -c appears in argv
  const shIndex = argv.indexOf("/bin/sh");
  if (shIndex < 0 || argv[shIndex + 1] !== "-c" || argv[shIndex + 2] !== originalCommand) {
    return { block: "sandbox quoting self-check failed: /bin/sh -c payload mismatch" };
  }

  return {
    command: wrappedCommand,
    argv: [...argv],
    env,
  };
}

/**
 * Wrap a bash command using the given policy, backend, and environment.
 */
export function wrapBashCommand(
  command: string,
  policy: SandboxPolicy,
  backend: SandboxBackendId,
  env: Record<string, string> = {},
): WrapOutcome {
  if (policy.mode === "off" || backend === "none") {
    return {
      command,
      argv: ["/bin/sh", "-c", command],
      env,
    };
  }

  let planned: { argv: string[] } | { block: string };
  switch (backend) {
    case "bwrap":
      planned = planBwrap(policy, command, env);
      break;
    case "seatbelt":
      planned = planSeatbelt(policy, command, env);
      break;
    case "landlock":
      return { block: "landlock backend not installed yet" };
    default:
      return { block: `unsupported sandbox backend: ${String(backend)}` };
  }

  if ("block" in planned) {
    return planned;
  }

  return formatAndValidateCommand(planned.argv, command, env);
}
