import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

export interface TimeoutConfig {
  defaultSeconds: number;
  idleSeconds: number;
  maxSeconds: number;
  /** Seconds between SIGTERM and SIGKILL, so a command can clean up (lock files, temp dirs, containers). */
  killGraceSeconds?: number;
  /** Do not treat a command that is still using CPU as idle (Linux only; other platforms use output alone). */
  activityAware?: boolean;
}
export const DEFAULT_TIMEOUT_CONFIG: Required<TimeoutConfig> = {
  defaultSeconds: 180, idleSeconds: 90, maxSeconds: 1800, killGraceSeconds: 5, activityAware: true,
};
export function validateConfig(value: unknown): TimeoutConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a timeout configuration object");
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(DEFAULT_TIMEOUT_CONFIG, key)) throw new Error(`Unknown timeout setting: ${key}`);
  }
  const config = { ...DEFAULT_TIMEOUT_CONFIG, ...value } as Required<TimeoutConfig>;
  if (typeof config.activityAware !== "boolean") throw new Error("activityAware must be true or false");
  for (const [key, seconds] of Object.entries(config)) {
    if (key === "activityAware") continue;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) {
      throw new Error(`${key} must be a number greater than 0 and at most 86400 seconds`);
    }
  }
  if (config.defaultSeconds > config.maxSeconds || config.idleSeconds > config.defaultSeconds) {
    throw new Error("Require idleSeconds <= defaultSeconds <= maxSeconds");
  }
  return config;
}

export interface TimeoutReport {
  reason: "idle" | "wall";
  elapsedSeconds: number;
  silentSeconds: number;
  limitSeconds: number;
  recommendation: "fix-first" | "inspect-first" | "consider-increase";
  /** How the command ended: it exited after SIGTERM, was SIGKILLed after the grace period, or was killed outright. */
  termination?: "graceful" | "killed";
  /** Times the idle limit was waived because the command was still using CPU. */
  busyExtensions?: number;
}

export function formatTimeoutStamp(timeout: number | undefined, config: TimeoutConfig): string {
  if (timeout !== undefined && Number.isFinite(timeout) && timeout > 0) {
    return `(timeout: ${timeout}s)`;
  }
  return `(timeout: ${config.defaultSeconds}s, idle: ${config.idleSeconds}s)`;
}

export function formatBashCallWithTimeout(
  args: { command?: string; timeout?: number } | undefined,
  config: TimeoutConfig,
  theme?: { fg?: (token: any, text: string) => string; bold?: (text: string) => string },
  prompt: string = "$"
): string {
  const rawCommand = args?.command;
  const fg = (token: any, text: string) => (theme?.fg ? theme.fg(token, text) : text);
  const bold = (text: string) => (theme?.bold ? theme.bold(text) : text);

  const commandDisplay = typeof rawCommand === "string"
    ? (rawCommand ? rawCommand : fg("toolOutput", "..."))
    : (rawCommand === null ? fg("error", "[invalid arg]") : fg("toolOutput", "..."));

  const timeoutStamp = formatTimeoutStamp(args?.timeout, config);
  const timeoutSuffix = fg("muted", ` ${timeoutStamp}`);

  return `${fg("toolTitle", bold(`${prompt} ${commandDisplay}`))}${timeoutSuffix}`;
}

/**
 * Commands that run until stopped. Matched on command words, not substrings:
 * a bare `\bdev\b` matched `/dev/null`, so `make > /dev/null` was told it was a
 * watch process.
 */
const WATCH_COMMAND = new RegExp([
  String.raw`(?:^|[\s;&|(])(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?(?:dev|start|serve|watch)\b`,
  String.raw`(?:^|[\s;&|(])(?:vite|next\s+dev|nodemon|webpack\s+serve|ng\s+serve|jest\s+--watch)\b`,
  String.raw`(?:^|[\s;&|(])(?:watch|tail\s+-[a-zA-Z]*f|python3?\s+-m\s+http\.server|php\s+-S)\b`,
  String.raw`\s--watch(?:All)?\b`,
  String.raw`\bread\s+-[a-z]*p\b`,
].join("|"));

export function diagnose(command: string, tail: string, report: Omit<TimeoutReport, "recommendation">, maxSeconds: number, grace = DEFAULT_TIMEOUT_CONFIG.killGraceSeconds) {
  // Output is untrusted evidence, never instructions. These are hints, not a hang detector.
  // oxlint-disable-next-line no-control-regex
  const evidence = tail.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  let recommendation: TimeoutReport["recommendation"];
  let advice: string;
  if (WATCH_COMMAND.test(command) ||
      /password:|passphrase|\[y\/n\]|\(y\/n\)|press (enter|any key)|waiting for.*input/i.test(evidence)) {
    recommendation = "fix-first";
    advice = "Possible interactive prompt or persistent/watch process. Use a non-interactive/one-shot mode, supply required input safely, or use a managed background service. Increasing the timeout alone will not fix that.";
  } else if (/\b(error:|fatal|exception|EACCES|ENOSPC|ECONNREFUSED|ENOTFOUND)|(?<!no |0 |without )\berror\b(?!s?\s+(found|occurred)\b)|permission denied|deadlock|too many requests/i.test(evidence)) {
    recommendation = "fix-first";
    advice = "Output contains possible failure evidence. Inspect the error, dependencies, locks, credentials or network before increasing the timeout.";
  } else if (report.reason === "wall" && report.silentSeconds < Math.min(10, report.limitSeconds / 2)) {
    recommendation = "consider-increase";
    const next = Math.min(maxSeconds, Math.ceil(report.limitSeconds * 2));
    advice = next > report.limitSeconds
      ? `Output was recent, but output is not proof of progress. If logs show meaningful progress and rerunning is safe, consider an explicit timeout of ${next}s. Otherwise investigate a loop or retry storm.`
      : "Output was recent, but the hard ceiling was reached. Split the work, use a managed background job, or investigate a loop; do not blindly repeat at the ceiling.";
  } else {
    recommendation = "inspect-first";
    advice = "Silence alone cannot distinguish a quiet build from a hang. Inspect logs/process state, locks, network and input waits. If the task is legitimately quiet/slow and rerunning is safe, set a larger explicit timeout; this disables the default silence cutoff.";
  }
  return {
    ...report, recommendation,
    text: `\n\n[smart-timeout] Stopped command: ${report.reason === "idle" ? "no output" : "total runtime"} limit ${report.limitSeconds}s; elapsed ${report.elapsedSeconds}s; silent ${report.silentSeconds}s.\nRecommendation: ${recommendation}. ${advice}\n${report.termination === "graceful" ? "The command exited after SIGTERM." : report.termination === "killed" ? `It ignored SIGTERM for ${grace}s and was SIGKILLed, so cleanup did not run.` : "The command was killed."}\nThe command was terminated, not paused. Check partial side effects before retrying. Never automatically rerun a mutation.\n`,
  };
}

/**
 * CPU time (clock ticks) used by every live process in a process group, or
 * undefined where /proc is unavailable. A command that is silent but burning CPU
 * (a compiler, a linker, a test run with output buffered) is working; one that is
 * silent and idle is the hang the silence limit exists for.
 */
export function groupCpuTicks(pgid: number): number | undefined {
  let total = 0;
  let seen = false;
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      let stat: string;
      try { stat = readFileSync(`/proc/${entry}/stat`, "utf8"); } catch { continue; }
      // `comm` may contain spaces and parentheses: parse from the LAST ")".
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) !== pgid) continue; // fields[2] is pgrp (field 5 overall)
      seen = true;
      // utime, stime, cutime, cstime: fields 14-17 overall, so indexes 11-14 here.
      total += [11, 12, 13, 14].reduce((sum, index) => sum + (Number(fields[index]) || 0), 0);
    }
  } catch {
    return undefined;
  }
  return seen ? total : undefined;
}

/** Ticks of CPU a command must add between two checks to count as working, not idle (about 20ms). */
const BUSY_TICKS = 2;

/**
 * Wrap Pi's local backend, retaining its process-group kill, output streaming and cancellation.
 *
 * Termination follows the GNU `timeout --kill-after` model: SIGTERM to the whole
 * process group first, so the command can remove lock files, temp directories and
 * containers, then SIGKILL (Pi's own kill) if it is still alive after
 * `killGraceSeconds`. Pi's backend only has the immediate SIGKILL.
 *
 * To signal the group we need its id, which Pi's backend does not expose. The
 * command is prefixed with a line that writes the shell's own pid (the group
 * leader, because Pi spawns it detached) to a private temp file. If that file is
 * missing, every step degrades to Pi's behaviour: no grace period, no CPU check.
 */
export function smartOperations(base: BashOperations, config: TimeoutConfig, onTimeout?: (report: TimeoutReport) => void): BashOperations {
  const graceSeconds = config.killGraceSeconds ?? DEFAULT_TIMEOUT_CONFIG.killGraceSeconds;
  const activityAware = config.activityAware ?? DEFAULT_TIMEOUT_CONFIG.activityAware;
  return {
    async exec(command, cwd, options) {
      const explicit = options.timeout;
      if (explicit !== undefined && (!Number.isFinite(explicit) || explicit <= 0 || explicit > config.maxSeconds)) {
        throw new Error(`timeout must be greater than 0 and at most ${config.maxSeconds} seconds`);
      }
      if (options.signal?.aborted) throw new Error("aborted");
      const wallSeconds = explicit ?? config.defaultSeconds;
      const started = performance.now();
      let lastOutput = started;
      let tail = "";
      let stopped: "idle" | "wall" | undefined;
      let stoppedAt = started;
      let silentAtStop = 0;
      let termination: TimeoutReport["termination"];
      let busyExtensions = 0;
      let lastCpu: number | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let baselineTimer: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();
      const pidFile = join(tmpdir(), `pi-smart-timeout-${randomUUID()}.pid`);
      const groupId = (): number | undefined => {
        try {
          const pid = Number(readFileSync(pidFile, "utf8"));
          return Number.isInteger(pid) && pid > 1 ? pid : undefined;
        } catch {
          return undefined;
        }
      };
      const stop = (reason: "idle" | "wall") => {
        if (stopped || controller.signal.aborted) return;
        stopped = reason;
        stoppedAt = performance.now();
        silentAtStop = stoppedAt - lastOutput;
        const pgid = groupId();
        if (pgid !== undefined && graceSeconds > 0) {
          try {
            process.kill(-pgid, "SIGTERM");
            // Escalate: Pi's backend SIGKILLs the group when the signal aborts.
            killTimer = setTimeout(() => { termination = "killed"; controller.abort(); }, graceSeconds * 1000);
            return;
          } catch { /* group already gone: fall through to the abort */ }
        }
        termination = "killed";
        controller.abort();
      };
      const onIdle = () => {
        // Silent is not the same as stuck: a command still spending CPU gets another window.
        if (activityAware) {
          const pgid = groupId();
          const cpu = pgid === undefined ? undefined : groupCpuTicks(pgid);
          if (cpu !== undefined && lastCpu !== undefined && cpu - lastCpu >= BUSY_TICKS) {
            lastCpu = cpu;
            busyExtensions++;
            armIdle();
            return;
          }
        }
        stop("idle");
      };
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (explicit === undefined) idleTimer = setTimeout(onIdle, config.idleSeconds * 1000);
      };
      const abort = () => controller.abort();
      options.signal?.addEventListener("abort", abort, { once: true });
      const wallTimer = setTimeout(() => stop("wall"), wallSeconds * 1000);
      armIdle();
      if (activityAware && explicit === undefined) {
        // The CPU baseline must predate the first idle check, or that check has nothing to compare with.
        baselineTimer = setTimeout(() => {
          const pgid = groupId();
          if (pgid !== undefined) lastCpu = groupCpuTicks(pgid);
        }, Math.min(1000, config.idleSeconds * 500));
      }
      const finish = (): { exitCode: number } => {
        const round = (ms: number) => Math.round(ms / 100) / 10;
        const report = diagnose(command, tail, {
          reason: stopped!, elapsedSeconds: round(stoppedAt - started), silentSeconds: round(silentAtStop),
          limitSeconds: stopped === "idle" ? config.idleSeconds : wallSeconds,
          termination: termination ?? "graceful",
          ...(busyExtensions ? { busyExtensions } : {}),
        }, config.maxSeconds, graceSeconds);
        options.onData(Buffer.from(report.text));
        onTimeout?.(report);
        return { exitCode: 124 };
      };
      try {
        const result = await base.exec(
          `printf '%s' "$$" > '${pidFile}' 2>/dev/null\n${command}`,
          cwd,
          {
            ...options,
            // Our timers own the limits. Pi's own timer stays only as a backstop that
            // cannot fire first: it would report a bare "timeout" with no diagnosis.
            timeout: wallSeconds + graceSeconds + 5,
            signal: controller.signal,
            onData(data) {
              if (stopped) {
                // Output during the grace period is the command cleaning up: keep it.
                options.onData(data);
                return;
              }
              if (data.length) {
                lastOutput = performance.now();
                tail = (tail + data.subarray(-8192).toString("utf8")).slice(-8192);
                armIdle();
              }
              options.onData(data);
            },
          },
        );
        // The command exited on SIGTERM inside the grace period: still a timeout.
        if (stopped && !options.signal?.aborted) return finish();
        return result;
      } catch (error) {
        if (options.signal?.aborted) throw new Error("aborted");
        if (!stopped) throw error;
        return finish();
      } finally {
        clearTimeout(wallTimer);
        if (idleTimer) clearTimeout(idleTimer);
        if (killTimer) clearTimeout(killTimer);
        if (baselineTimer) clearTimeout(baselineTimer);
        options.signal?.removeEventListener("abort", abort);
        rmSync(pidFile, { force: true });
      }
    },
  };
}
