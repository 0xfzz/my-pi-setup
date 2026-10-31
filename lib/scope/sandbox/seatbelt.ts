import type { SandboxPolicy } from "./policy.ts";

function escapeSchemeString(str: string): string {
  return str.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * Build the macOS Seatbelt (sandbox-exec) argv for the given policy and command.
 *
 * Invariants:
 * - Default allow (reads and network permitted)
 * - Deny file-write* universally
 * - Allow file-write* on /dev, /tmp, scratchDir, and declared writable directories
 * - Allow file-write-data on /dev/fd
 * - Deny file-write* explicitly on declared deny directories
 */
export function planSeatbelt(
  policy: SandboxPolicy,
  command: string,
  _env: Record<string, string> = {},
): { argv: string[] } | { block: string } {
  if (policy.mode === "off") {
    return { argv: ["/bin/sh", "-c", command] };
  }

  const rules: string[] = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    '(allow file-write* (subpath "/dev"))',
    '(allow file-write-data (subpath "/dev/fd"))',
    '(allow file-write* (subpath "/tmp"))',
  ];

  if (policy.scratchDir) {
    rules.push(`(allow file-write* (subpath "${escapeSchemeString(policy.scratchDir)}"))`);
  }

  for (const path of policy.writable) {
    if (path.startsWith("/dev") || path === "/tmp") continue;
    rules.push(`(allow file-write* (subpath "${escapeSchemeString(path)}"))`);
  }

  for (const denied of policy.deny) {
    rules.push(`(deny file-write* (subpath "${escapeSchemeString(denied)}"))`);
  }

  const profile = rules.join("\n");

  const argv: string[] = [
    "sandbox-exec",
    "-p", profile,
    "--",
    "/bin/sh", "-c", command,
  ];

  return { argv };
}
