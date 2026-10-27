/**
 * search-engine.ts — how a read-only role searches a codebase without walking it.
 *
 * A JavaScript directory walk is the bottleneck this module exists to avoid. The
 * work is delegated to a native engine, in order of speed:
 *
 *   host ffgrep index → ripgrep → git grep → grep
 *
 * Every engine is spawned with an argv array (`execFile`), never a shell string,
 * so a search pattern cannot become a flag or a command. At most two engines run
 * at once per process; each call has a timeout and a match cap, and a timeout
 * returns partial results instead of an empty list.
 *
 * Pure enough to test: the runner, the engine list and the optional host adapter
 * are injected, so no test needs ripgrep installed.
 */
import { execFile } from "node:child_process";

export type SearchEngineName = "host" | "rg" | "git-grep" | "grep";

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
  before: string[];
  after: string[];
}

export interface SearchRequest {
  patterns: string[];
  cwd: string;
  path?: string;
  exclude?: string | string[];
  context?: number;
  maxMatches?: number;
  regex?: boolean;
  caseSensitive?: boolean;
  timeoutMs?: number;
}

export interface SearchResult {
  engine: SearchEngineName;
  matches: SearchMatch[];
  truncated: boolean;
  warnings: string[];
}

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

export interface SearchDeps {
  runner: CommandRunner;
  /** Commons names the host `ffgrep` adapter uses; absent means no host index. */
  hostSearch?: (request: SearchRequest) => Promise<SearchResult | undefined> | SearchResult | undefined;
  /** Engines known to be available, in preference order. Defaults to rg, git-grep, grep. */
  engines?: SearchEngineName[];
  /** At most this many engine processes at once (default 2). */
  concurrency?: number;
  timeoutMs?: number;
}

export const MAX_ENGINE_PROCESSES = 2;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_PATTERNS = 5;

/** A tiny semaphore: the cap is per process, not per call. */
export function createScheduler(max = MAX_ENGINE_PROCESSES): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function schedule<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((release) => waiting.push(release));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      const next = waiting.shift();
      if (next) next();
    }
  };
}

const processScheduler = createScheduler();

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

function clip(request: SearchRequest): { patterns: string[]; maxMatches: number; context: number } {
  const patterns = request.patterns.map((p) => String(p ?? "")).filter(Boolean).slice(0, MAX_PATTERNS);
  if (!patterns.length) throw new Error("code_search needs at least one pattern");
  return {
    patterns,
    maxMatches: Math.max(1, Math.min(request.maxMatches ?? 40, 100)),
    context: Math.max(0, Math.min(request.context ?? 2, 5)),
  };
}

function rgArgv(request: SearchRequest, patterns: string[], maxMatches: number, context: number): string[] {
  const argv = ["--json", "--line-number", "--color", "never", "--no-config", "--max-count", String(maxMatches)];
  if (context > 0) argv.push("--context", String(context));
  if (!request.regex) argv.push("--fixed-strings");
  if (request.caseSensitive) argv.push("--case-sensitive");
  else argv.push("--ignore-case");
  for (const exclude of [request.exclude ?? []].flat()) {
    if (exclude) argv.push("--glob", `!${exclude}`);
  }
  for (const pattern of patterns) argv.push("--regexp", pattern);
  argv.push("--", request.path ?? ".");
  return argv;
}

/** rg --json emits `begin`, `context` and `match` lines; context wraps the match. */
export function parseRgJson(stdout: string, maxMatches: number): { matches: SearchMatch[]; truncated: boolean } {
  const matches: SearchMatch[] = [];
  let before: string[] = [];
  let current: SearchMatch | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "begin") {
      before = [];
      current = undefined;
    } else if (event.type === "context") {
      const text = String(event.data?.lines?.text ?? "").replace(/\n$/, "");
      if (current) current.after.push(text);
      else before.push(text);
    } else if (event.type === "match") {
      const data = event.data ?? {};
      const sub = Array.isArray(data.submatches) ? data.submatches[0] : undefined;
      current = {
        path: String(data.path?.text ?? ""),
        line: Number(data.line_number ?? 0),
        column: Number(sub?.start ?? 0) + 1,
        text: String(data.lines?.text ?? "").replace(/\n$/, ""),
        before: before.slice(-5),
        after: [],
      };
      matches.push(current);
      before = [];
      if (matches.length >= maxMatches) return { matches, truncated: true };
    }
  }
  return { matches, truncated: false };
}

/** `path:line:column:text` from git grep / grep. Paths may contain colons, so the text is greedy. */
export function parseGrepLines(stdout: string, maxMatches: number): { matches: SearchMatch[]; truncated: boolean } {
  const matches: SearchMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^(.*?):(\d+):(?:(\d+):)?(.*)$/);
    if (!match) continue;
    matches.push({
      path: match[1]!,
      line: Number(match[2]),
      column: Number(match[3] ?? 1),
      text: match[4]!,
      before: [],
      after: [],
    });
    if (matches.length >= maxMatches) return { matches, truncated: true };
  }
  return { matches, truncated: false };
}

function grepArgv(engine: "git-grep" | "grep", request: SearchRequest, pattern: string, maxMatches: number): { bin: string; argv: string[] } {
  const path = request.path ?? ".";
  if (engine === "git-grep") {
    const argv = ["grep", "-n", "--column", "--no-color", "-I", "--max-count", String(maxMatches)];
    if (!request.caseSensitive) argv.push("-i");
    argv.push(request.regex ? "-E" : "-F", "-e", pattern, "--", path);
    return { bin: "git", argv };
  }
  const argv = ["-rn", "-I", "--color=never", "--max-count", String(maxMatches)];
  if (!request.caseSensitive) argv.push("-i");
  argv.push(request.regex ? "-E" : "-F", "-e", pattern, path);
  return { bin: "grep", argv };
}

/**
 * Run one search with the fastest available engine.
 *
 * Throws when no engine is available; a tool wrapper turns that into a capability
 * error rather than an empty result a reviewer could read as "no matches".
 */
export async function runSearch(request: SearchRequest, deps: SearchDeps): Promise<SearchResult> {
  const { patterns, maxMatches, context } = clip(request);
  const schedule = deps.concurrency ? createScheduler(deps.concurrency) : processScheduler;
  const timeoutMs = request.timeoutMs ?? deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const warnings: string[] = [];

  if (deps.hostSearch) {
    const hosted = await deps.hostSearch(request);
    if (hosted && hosted.matches.length) return hosted;
  }

  const engines = (deps.engines ?? ["rg", "git-grep", "grep"]).filter((engine) => engine !== "host");
  if (!engines.length) throw new Error("no search engine is available (rg, git grep or grep)");

  for (const engine of engines) {
    if (engine === "rg") {
      const result = await schedule(() =>
        deps.runner.run("rg", rgArgv(request, patterns, maxMatches, context), { cwd: request.cwd, timeoutMs }),
      );
      if (result.timedOut) {
        warnings.push(`rg timed out after ${timeoutMs} ms; results are partial`);
      }
      if (result.timedOut || result.exitCode === 0 || result.exitCode === 1 || result.stdout.trim()) {
        const parsed = parseRgJson(result.stdout, maxMatches);
        return { engine: "rg", matches: parsed.matches, truncated: parsed.truncated || result.timedOut, warnings };
      }
      warnings.push(`rg failed (exit ${result.exitCode ?? "signal"}): ${result.stderr.trim().split("\n")[0] ?? "no output"}`);
      continue;
    }

    // git grep / grep: one process per pattern, merged and capped.
    const merged: SearchMatch[] = [];
    let truncated = false;
    for (const pattern of patterns) {
      const { bin, argv } = grepArgv(engine, request, pattern, maxMatches);
      const result = await schedule(() => deps.runner.run(bin, argv, { cwd: request.cwd, timeoutMs }));
      if (result.timedOut) warnings.push(`${engine} timed out after ${timeoutMs} ms; results are partial`);
      const parsed = parseGrepLines(result.stdout, maxMatches - merged.length);
      merged.push(...parsed.matches);
      truncated ||= parsed.truncated || result.timedOut;
      if (result.exitCode !== 0 && result.exitCode !== 1 && !result.stdout.trim()) {
        warnings.push(`${engine} failed (exit ${result.exitCode ?? "signal"}): ${result.stderr.trim().split("\n")[0] ?? "no output"}`);
      }
      if (merged.length >= maxMatches) {
        truncated = true;
        break;
      }
    }
    if (!merged.length && engine !== engines[engines.length - 1]) {
      warnings.push(`${engine} returned no matches; trying the next engine`);
      continue;
    }
    return { engine, matches: merged, truncated, warnings };
  }

  throw new Error("every search engine failed; see warnings");
}
