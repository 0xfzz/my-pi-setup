/**
 * exec-runner.ts — lightweight command runner using child_process.execFile.
 *
 * Runs binaries directly with an argv array (no shell interpolation), returning
 * stdout, stderr, exit code and timedOut status.
 */
import { execFile } from "node:child_process";

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CommandRunner {
  run(
    bin: string,
    argv: string[],
    options: { cwd?: string; timeoutMs?: number; maxBytes?: number },
  ): Promise<CommandResult>;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

/** `execFile` argv only — no shell, so metacharacters stay data. */
export function createExecRunner(): CommandRunner {
  return {
    run(bin, argv, options) {
      return new Promise<CommandResult>((resolve) => {
        execFile(
          bin,
          argv,
          { cwd: options.cwd, timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: options.maxBytes ?? 4 * 1024 * 1024 },
          (error: any, stdout, stderr) => {
            resolve({
              exitCode: typeof error?.code === "number" ? error.code : error ? null : 0,
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? ""),
              timedOut: Boolean(error?.killed),
            });
          },
        );
      });
    },
  };
}
