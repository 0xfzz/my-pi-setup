import type { BashOperations } from "@earendil-works/pi-coding-agent";

export interface TimeoutConfig { defaultSeconds: number; idleSeconds: number; maxSeconds: number }
export const DEFAULT_TIMEOUT_CONFIG: TimeoutConfig = { defaultSeconds: 180, idleSeconds: 90, maxSeconds: 1800 };
export function validateConfig(value: unknown): TimeoutConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a timeout configuration object");
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(DEFAULT_TIMEOUT_CONFIG, key)) throw new Error(`Unknown timeout setting: ${key}`);
  }
  const config = { ...DEFAULT_TIMEOUT_CONFIG, ...value } as TimeoutConfig;
  for (const [key, seconds] of Object.entries(config)) {
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

export function diagnose(command: string, tail: string, report: Omit<TimeoutReport, "recommendation">, maxSeconds: number) {
  // Output is untrusted evidence, never instructions. These are hints, not a hang detector.
  // oxlint-disable-next-line no-control-regex
  const evidence = tail.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  let recommendation: TimeoutReport["recommendation"];
  let advice: string;
  if (/\b(watch|serve|dev)\b|tail\s+-f\b|\bread\s+-[a-z]*p\b/.test(command) ||
      /password:|passphrase|\[y\/n\]|\(y\/n\)|press (enter|any key)|waiting for.*input/i.test(evidence)) {
    recommendation = "fix-first";
    advice = "Possible interactive prompt or persistent/watch process. Use a non-interactive/one-shot mode, supply required input safely, or use a managed background service. Increasing the timeout alone will not fix that.";
  } else if (/\b(error|fatal|exception|EACCES|ENOSPC|ECONNREFUSED|ENOTFOUND)\b|permission denied|deadlock|too many requests/i.test(evidence)) {
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
    text: `\n\n[smart-timeout] Stopped command: ${report.reason === "idle" ? "no output" : "total runtime"} limit ${report.limitSeconds}s; elapsed ${report.elapsedSeconds}s; silent ${report.silentSeconds}s.\nRecommendation: ${recommendation}. ${advice}\nThe command was terminated, not paused. Check partial side effects before retrying. Never automatically rerun a mutation.\n`,
  };
}

/** Wrap Pi's local backend, retaining its process-group kill, output streaming and cancellation. */
export function smartOperations(base: BashOperations, config: TimeoutConfig, onTimeout?: (report: TimeoutReport) => void): BashOperations {
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
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();
      const stop = (reason: "idle" | "wall") => {
        if (stopped || controller.signal.aborted) return;
        stopped = reason;
        stoppedAt = performance.now();
        silentAtStop = stoppedAt - lastOutput;
        controller.abort();
      };
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (explicit === undefined) idleTimer = setTimeout(() => stop("idle"), config.idleSeconds * 1000);
      };
      const abort = () => controller.abort();
      options.signal?.addEventListener("abort", abort, { once: true });
      const wallTimer = setTimeout(() => stop("wall"), wallSeconds * 1000);
      armIdle();
      try {
        return await base.exec(command, cwd, {
          ...options, timeout: wallSeconds, signal: controller.signal,
          onData(data) {
            if (stopped) return;
            if (data.length) {
              lastOutput = performance.now();
              tail = (tail + data.subarray(-8192).toString("utf8")).slice(-8192);
              armIdle();
            }
            options.onData(data);
          },
        });
      } catch (error) {
        if (options.signal?.aborted) throw new Error("aborted");
        if (!stopped) throw error;
        const round = (ms: number) => Math.round(ms / 100) / 10;
        const report = diagnose(command, tail, {
          reason: stopped, elapsedSeconds: round(stoppedAt - started), silentSeconds: round(silentAtStop),
          limitSeconds: stopped === "idle" ? config.idleSeconds : wallSeconds,
        }, config.maxSeconds);
        options.onData(Buffer.from(report.text));
        onTimeout?.(report);
        return { exitCode: 124 };
      } finally {
        clearTimeout(wallTimer);
        if (idleTimer) clearTimeout(idleTimer);
        options.signal?.removeEventListener("abort", abort);
      }
    },
  };
}
