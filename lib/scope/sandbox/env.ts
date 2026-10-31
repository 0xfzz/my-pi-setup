import { join } from "node:path";

export interface SandboxEnvOptions {
  scratchDir?: string;
  extraEnv?: Record<string, string>;
}

/**
 * Build the sanitized environment variables for sandboxed command execution.
 *
 * Incidental writes from tools (like python bytecode, git optional locks, shell history,
 * and caches) are redirected or suppressed so read-only / workspace-scoped commands
 * do not fail spuriously.
 */
export function buildSandboxEnv(options: SandboxEnvOptions = {}): Record<string, string> {
  const env: Record<string, string> = {
    GIT_OPTIONAL_LOCKS: "0",
    PYTHONDONTWRITEBYTECODE: "1",
    HISTFILE: "/dev/null",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };

  if (options.scratchDir) {
    const dir = options.scratchDir;
    env.TMPDIR = dir;
    env.XDG_CACHE_HOME = join(dir, "cache");
    env.npm_config_cache = join(dir, "npm");
    env.PIP_CACHE_DIR = join(dir, "pip");
  }

  if (options.extraEnv) {
    Object.assign(env, options.extraEnv);
  }

  return env;
}
