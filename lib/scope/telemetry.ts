/**
 * Append-only JSONL of every decision the scope gate made.
 *
 * `/scope log` answers "what happened in this session"; it is bounded and dies
 * with the process. This file is the other question — "is the gate asking about
 * things it should not, and missing things it should?" — and it has to outlive
 * the session to be answerable at all. One JSON object per line, one line per
 * claim, so a later analysis can group by tool, resource, rule and answer
 * without replaying a transcript.
 *
 * Three rules keep it from becoming a liability:
 *
 * 1. **Best effort.** A read-only home directory, a full disk or an unexpected
 *    `EACCES` must never change a verdict: every write is wrapped and dropped.
 * 2. **Bounded.** The file rotates at `maxBytes` (one `.1` predecessor), so an
 *    idle gate in a long-lived project cannot grow without limit.
 * 3. **Narrow.** Only the decision vocabulary is stored — never file contents,
 *    never a tool's full payload — and command text is redacted and truncated.
 */
import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ScopeEffect, ScopePosture } from "./types.ts";

/** Bumped when a field changes meaning; a reader can skip what it does not know. */
export const TELEMETRY_VERSION = 1;

/** Rotate at 4 MiB, keeping one predecessor. ~10k decisions per file. */
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/** What the user answered, when the gate had to ask. */
export type DecisionAnswer =
  | "once"
  | "allow-session"
  | "allow-workspace"
  | "rule"
  | "deny"
  | "deny-feedback"
  /** A parent's answer, applied by a delegated child through `scope_answer`. */
  | "allow-once"
  | "allow-folder"
  /** The dialog closed, threw or never appeared: no answer is not consent. */
  | "no-answer"
  /** A delegated child was told to escalate instead of asking the user. */
  | "escalated";

/** Where a record came from: a judged tool call, or a consent change. */
export type DecisionSource = "gate" | "scope_answer" | "command";

/** The path claim, flattened so a record needs no schema knowledge to read. */
export interface ClaimSnapshot {
  action: string;
  absolute: string;
  resource: string;
  write: boolean;
  posture: ScopePosture;
  external: boolean;
  kind: "file" | "directory" | "unknown";
  /** The shell segment the claim came from, when the tool was `bash`. */
  command?: string;
  /** Directory a relative claim resolved against, when the shell prefix moved it. */
  base?: string;
}

/** The scope state in force at decision time: config drift explains a false positive. */
export interface StateSnapshot {
  roots: number;
  rules: number;
  yolo?: string;
  external: ScopeEffect;
  readExternal: ScopeEffect;
}

/**
 * One decision.
 *
 * `effect` is the final verdict for this claim; `asked` plus `answer` say how it
 * was reached. A record with `asked: true` is a candidate false positive ("the
 * gate bothered me"); `unknown: true` is a detection gap ("the parser gave up").
 */
export interface DecisionRecord {
  /** Epoch ms. Filled by the sink when absent. */
  at?: number;
  source?: DecisionSource;
  tool: string;
  /** The raw command or path the model asked for, before sanitizing. */
  input: string;
  /** The directory the claim was judged against (after the shell prefix). */
  cwd: string;
  effect: ScopeEffect;
  asked: boolean;
  answer?: DecisionAnswer;
  /** A yolo arm, not the user, answered. */
  auto?: boolean;
  /** yolo strength in force, when it changed the outcome. */
  yolo?: string;
  /** A delegated child session: the question went up the ladder, not to a user. */
  child?: boolean;
  /** The claim set could not be analysed (an opaque shell construct). */
  unknown?: boolean;
  /** The construct that made the claim opaque, e.g. `bash -c`. */
  opaque?: string;
  reason: string;
  claim?: ClaimSnapshot;
  rule?: { action: string; resource: string; effect: ScopeEffect; source?: string };
  root?: { path: string; access: string; source: string };
  state?: StateSnapshot;
}

/** A stored record is the record plus the version and timestamp it was written with. */
export type StoredDecisionRecord = DecisionRecord & { v: number; at: number };

const MAX_INPUT = 2000;
const MAX_REASON = 500;

/**
 * Common credential spellings, replaced before anything is written.
 *
 * This is not a promise of secret detection — the file is local and the point is
 * diagnosis, not audit — but a command like `export API_KEY=…` should not turn
 * the telemetry into the place the key is written down.
 */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // Header form first: it swallows the whole value, so the Bearer rule below
  // cannot redact half of it twice.
  [/\b(Authorization\s*:\s*)(?:[A-Za-z]+\s+)?[^\s"',;]+/gi, "$1[redacted]"],
  [/\b(Proxy-Authorization\s*:\s*)(?:[A-Za-z]+\s+)?[^\s"',;]+/gi, "$1[redacted]"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]"],
  [
    /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY)[A-Za-z0-9_]*\s*[=:]\s*)(["']?)[^\s"',;]+\2/gi,
    "$1[redacted]",
  ],
  [/(--?(?:token|password|passwd|secret|api-key|apikey|auth)\s*[= ]\s*)(["']?)[^\s"',;]+\2/gi, "$1[redacted]"],
];

/** Redact credential-shaped text, then cap it so one command cannot fill the file. */
export function sanitizeTelemetryText(value: string, limit = MAX_INPUT): string {
  let text = value;
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit))}…(+${text.length - limit} chars)`;
}

/** Op state: telemetry is on unless the user turned it off. */
export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env.PI_SCOPE_TELEMETRY ?? "").trim().toLowerCase();
  return !(flag === "0" || flag === "off" || flag === "false" || flag === "no");
}

/** `~/.pi/agent/scope-telemetry.jsonl`, overridable for tests and per-machine setups. */
export function defaultTelemetryPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_SCOPE_TELEMETRY_FILE?.trim();
  if (override) return override;
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || env.PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(agentDir, "scope-telemetry.jsonl");
}

export interface ScopeTelemetryOptions {
  /** Destination. Defaults to `defaultTelemetryPath()`. */
  path?: string;
  /** Defaults to `telemetryEnabled()`. */
  enabled?: boolean;
  /** Rotation threshold. Defaults to `DEFAULT_MAX_BYTES`. */
  maxBytes?: number;
}

/** Flatten a record to exactly the fields worth storing, redacting long text. */
function normalize(record: DecisionRecord, at: number): StoredDecisionRecord {
  return {
    v: TELEMETRY_VERSION,
    at,
    ...(record.source ? { source: record.source } : {}),
    tool: record.tool,
    input: sanitizeTelemetryText(record.input),
    cwd: record.cwd,
    effect: record.effect,
    asked: record.asked,
    ...(record.answer ? { answer: record.answer } : {}),
    ...(record.auto ? { auto: true } : {}),
    ...(record.yolo ? { yolo: record.yolo } : {}),
    ...(record.child ? { child: true } : {}),
    ...(record.unknown ? { unknown: true } : {}),
    ...(record.opaque ? { opaque: record.opaque } : {}),
    reason: sanitizeTelemetryText(record.reason, MAX_REASON),
    ...(record.claim ? { claim: { ...record.claim, ...(record.claim.command ? { command: sanitizeTelemetryText(record.claim.command) } : {}) } } : {}),
    ...(record.rule ? { rule: record.rule } : {}),
    ...(record.root ? { root: record.root } : {}),
    ...(record.state ? { state: record.state } : {}),
  };
}

/**
 * The sink. Construct once per extension instance; `record` never throws.
 *
 * Writes are synchronous so a denial is on disk before the tool call is blocked.
 * A line is small (a few hundred bytes), which keeps the append atomic enough
 * for the concurrent children that share the same file.
 */
export class ScopeTelemetry {
  readonly path: string;
  readonly enabled: boolean;
  private readonly maxBytes: number;
  /** Bytes seen in the current file; `measured` says whether they are known. */
  private written = 0;
  private measured = false;

  constructor(options: ScopeTelemetryOptions = {}) {
    this.path = options.path ?? defaultTelemetryPath();
    this.enabled = options.enabled ?? telemetryEnabled();
    this.maxBytes = Math.max(1024, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES));
  }

  /** Append one line. Any failure is swallowed: telemetry must not gate anything. */
  record(record: DecisionRecord): void {
    if (!this.enabled) return;
    let line: string;
    try {
      line = `${JSON.stringify(normalize(record, record.at ?? Date.now()))}\n`;
    } catch {
      return;
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      this.measure();
      if (this.written >= this.maxBytes) this.rotate();
      appendFileSync(this.path, line, { encoding: "utf8" });
      this.written += Buffer.byteLength(line, "utf8");
    } catch {
      // A read-only home, a full disk or a permission error is not a scope verdict.
    }
  }

  /** Measure once so a pre-existing file counts toward the rotation budget. */
  private measure(): void {
    if (this.measured) return;
    this.measured = true;
    try {
      this.written = statSync(this.path).size;
    } catch {
      this.written = 0;
    }
  }

  private rotate(): void {
    const previous = `${this.path}.1`;
    try {
      unlinkSync(previous);
    } catch {
      // No predecessor yet, which is the normal first rotation.
    }
    try {
      renameSync(this.path, previous);
    } catch {
      // Keep appending to the current file rather than losing the record.
    }
    this.written = 0;
  }
}
