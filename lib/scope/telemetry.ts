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
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
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
  /** Active sandbox status when the decision/call was made. */
  sandbox?: { backend: string; mode: string; degraded?: boolean };
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

/** Read a JSONL file, skipping lines that are corrupt or not a decision record. */
export function readTelemetryRecords(path: string, limit = Number.POSITIVE_INFINITY): StoredDecisionRecord[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const records: StoredDecisionRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<StoredDecisionRecord>;
      if (typeof parsed?.tool === "string" && typeof parsed.effect === "string" && typeof parsed.at === "number") {
        records.push(parsed as StoredDecisionRecord);
      }
    } catch {
      // A truncated final line after a crash is not worth failing a report over.
    }
  }
  const capped = Math.max(1, Math.floor(limit));
  return records.length > capped ? records.slice(records.length - capped) : records;
}

/** The signals worth acting on, already counted. */
export interface TelemetrySummary {
  total: number;
  /** Distinct `cwd` values: the log is global, the records are not. */
  workspaces: number;
  asked: number;
  denied: number;
  automatic: number;
  unknown: number;
  /** Targets the gate asked about, most frequent first. */
  askedTargets: Array<{ target: string; count: number; once: number; denied: number }>;
  /** Targets asked more than once and answered "once": a standing answer would silence them. */
  repeats: Array<{ target: string; count: number; once: number }>;
  /** Constructs the parser could not analyse, most frequent first. */
  gaps: Array<{ construct: string; count: number; tools: string[] }>;
  /** Deny rules that actually fired. */
  deniedRules: Array<{ rule: string; count: number }>;
}

/**
 * One-line key for a target, however long the command that produced it was.
 *
 * An opaque call has no claim, so falling back to `input` would group by a whole
 * heredoc and print a multi-line "target" in the summary. The construct is the
 * thing that repeats there, so that is the key.
 */
function targetKey(record: DecisionRecord): string {
  if (record.claim?.absolute) return record.claim.absolute;
  if (record.opaque) return `[opaque] ${record.opaque}`;
  const oneLine = record.input.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine || record.tool;
}

/**
 * Count the decisions into the questions a person actually asks of them.
 *
 * Three shapes matter: a target that keeps asking is either a missing grant or a
 * false positive; a target that keeps being answered "once" is the same thing
 * with the answer already given; an opaque construct is a detection gap, not a
 * user problem. `deniedRules` is how a too-broad deny rule becomes visible.
 */
export function summarizeTelemetry(
  records: readonly DecisionRecord[],
  options: { top?: number; repeatThreshold?: number } = {},
): TelemetrySummary {
  const top = Math.max(1, Math.floor(options.top ?? 8));
  const repeatThreshold = Math.max(2, Math.floor(options.repeatThreshold ?? 2));
  const workspaces = new Set<string>();
  const byTarget = new Map<string, { target: string; count: number; once: number; denied: number }>();
  const byGap = new Map<string, { construct: string; count: number; tools: Set<string> }>();
  const byRule = new Map<string, { rule: string; count: number }>();
  let asked = 0;
  let denied = 0;
  let automatic = 0;
  let unknown = 0;

  for (const record of records) {
    workspaces.add(record.cwd);
    if (record.effect === "deny") denied++;
    if (record.auto) automatic++;
    if (record.unknown) unknown++;
    if (record.asked) {
      asked++;
      const key = targetKey(record);
      const row = byTarget.get(key) ?? { target: key, count: 0, once: 0, denied: 0 };
      row.count++;
      if (record.answer === "once") row.once++;
      if (record.effect === "deny") row.denied++;
      byTarget.set(key, row);
    }
    if (record.unknown) {
      const construct = record.opaque ?? "unreadable command";
      const row = byGap.get(construct) ?? { construct, count: 0, tools: new Set<string>() };
      row.count++;
      row.tools.add(record.tool);
      byGap.set(construct, row);
    }
    if (record.effect === "deny" && record.rule) {
      const key = `${record.rule.action}:${record.rule.resource}`;
      byRule.set(key, { rule: key, count: (byRule.get(key)?.count ?? 0) + 1 });
    }
  }

  const targets = [...byTarget.values()].sort((left, right) => right.count - left.count);
  return {
    total: records.length,
    workspaces: workspaces.size,
    asked,
    denied,
    automatic,
    unknown,
    askedTargets: targets.slice(0, top),
    repeats: targets.filter(row => row.count >= repeatThreshold && row.once > 0).slice(0, top),
    gaps: [...byGap.values()]
      .sort((left, right) => right.count - left.count)
      .slice(0, top)
      .map(row => ({ construct: row.construct, count: row.count, tools: [...row.tools].sort() })),
    deniedRules: [...byRule.values()].sort((left, right) => right.count - left.count).slice(0, top),
  };
}

/** Render a summary for `/scope telemetry`. */
export function formatTelemetrySummary(summary: TelemetrySummary, path: string): string[] {
  if (!summary.total) return [`Scope telemetry: no records yet in ${path}`];
  const lines = [
    `Scope telemetry: ${summary.total} decisions in ${summary.workspaces} workspace${summary.workspaces === 1 ? "" : "s"}`,
    `  ${summary.asked} asked, ${summary.denied} denied, ${summary.automatic} automatic, ${summary.unknown} detection gap${summary.unknown === 1 ? "" : "s"}`,
  ];
  if (summary.askedTargets.length) {
    lines.push("asked targets (a grant or a rule would silence these):");
    for (const row of summary.askedTargets) {
      lines.push(`  ${String(row.count).padStart(4)}  ${row.target}  (${row.once} once, ${row.denied} denied)`);
    }
  }
  if (summary.repeats.length) {
    lines.push("repeated asks with no standing answer:");
    for (const row of summary.repeats) lines.push(`  ${String(row.count).padStart(4)}  ${row.target}  (${row.once} answered once)`);
  }
  if (summary.gaps.length) {
    lines.push("detection gaps (the parser could not analyse these):");
    for (const row of summary.gaps) lines.push(`  ${String(row.count).padStart(4)}  [${row.tools.join(", ")}] ${row.construct}`);
  }
  if (summary.deniedRules.length) {
    lines.push("deny rules that fired:");
    for (const row of summary.deniedRules) lines.push(`  ${String(row.count).padStart(4)}  ${row.rule}`);
  }
  lines.push(`  log: ${path}`);
  return lines;
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
