/**
 * The review packet and the deterministic check.
 *
 * Both exist for one reason: the parent pays for every token it reads, and the
 * expensive part of a review is not deciding — it is *finding out*. A reviewer
 * that reads a 400-line file to learn that 30 lines changed spends most of its
 * attention budget on code it is not judging, and attention is quadratic in
 * context length, so the noise actively degrades the judgement it was meant to
 * serve.
 *
 * So the fork happens here, in code, before the model sees anything:
 *
 *   - `buildReviewPacket` keeps the decision inputs (criteria, lane, hunks,
 *     what the child last said) and drops everything else, with the truncation
 *     stated rather than implied.
 *   - `buildCheckReport` runs the checks a reviewer would otherwise run by hand
 *     and returns `evidenceRefs` already in the shape `orch_review` verifies, so
 *     the model cites a result instead of transcribing one.
 *
 * Everything in this file is pure except `runVerifyCommand`, which is injected.
 * That is deliberate: the packet's budget and the check's refs are contracts, and
 * a contract that can only be tested by running a real agent is not a contract.
 */
import { pathMatchesAnyLane, type EvidenceRef } from "./evidence.ts";

/** ~1,200 tokens at ~4 chars/token. Stated as chars because no tokeniser is exact. */
export const PACKET_CHAR_BUDGET = 4_800;
/** ~600 tokens: a check report is a table, not a document. */
export const CHECK_CHAR_BUDGET = 2_400;

export interface PacketHandoff {
  id?: string;
  revision?: number;
  acceptanceCriteria: string[];
  laneFiles: string[];
  verifyCommand?: string;
}

export interface PacketChild {
  id: string;
  name: string;
  status: string;
  startedAt?: number;
  budgetMs?: number;
  lastTail?: string | null;
  /** Criteria as they were when this child spawned; judged instead of the current spec. */
  frozenCriteria?: string[];
  handoffRevision?: number;
  laneFiles?: string[];
}

export interface PacketInput {
  scope: string;
  handoff?: PacketHandoff;
  child?: PacketChild;
  /** `git status --porcelain` results, or null when it could not be computed. */
  changed: string[] | null;
  /** Unified diff text, or null when unavailable. */
  diff?: string | null;
  /** Incremental cursor: files already sent for this scope are omitted. */
  previousFiles?: readonly string[];
  /** Wall clock, injected so elapsed time is deterministic in tests. */
  now?: number;
}

export interface DiffHunk {
  file: string;
  header: string;
  lines: string[];
  added: number;
  removed: number;
}

export interface ReviewPacket {
  scope: string;
  handoffId?: string;
  revision?: number;
  /** True when the criteria came from the frozen spawn-time copy. */
  frozen: boolean;
  criteria: string[];
  laneFiles: string[];
  changed: string[] | null;
  outOfLane: string[];
  hunks: DiffHunk[];
  omittedHunks: number;
  omittedFiles: string[];
  child?: { name: string; id: string; status: string; elapsed?: string; budget?: string; lastTail?: string };
  lastReport?: string;
}

/**
 * Split a unified diff into hunks.
 *
 * The file for a hunk comes from the `+++ b/<path>` header, because a hunk header
 * alone (`@@ -1,2 +1,3 @@`) does not say which file it belongs to and a reviewer
 * that guesses will cite the wrong one.
 */
export function parseDiff(diff: string | null | undefined): DiffHunk[] {
  if (!diff) return [];
  const hunks: DiffHunk[] = [];
  let file = "";
  let current: DiffHunk | null = null;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim();
      file = target === "/dev/null" ? file : target.replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("diff --git ")) {
      current = null;
      const match = raw.match(/ b\/(.+)$/);
      if (match) file = match[1]!;
      continue;
    }
    if (raw.startsWith("@@")) {
      current = { file, header: raw.trim(), lines: [], added: 0, removed: 0 };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("+")) current.added++;
    else if (raw.startsWith("-")) current.removed++;
    current.lines.push(raw);
  }
  return hunks;
}

function elapsed(startedAt?: number, now?: number): string | undefined {
  if (!startedAt || !now) return undefined;
  return `${Math.max(0, Math.round((now - startedAt) / 60_000))}m`;
}

function budget(budgetMs?: number): string | undefined {
  return budgetMs ? `${Math.round(budgetMs / 60_000)}m` : undefined;
}

export function buildReviewPacket(input: PacketInput): ReviewPacket {
  const child = input.child;
  const criteria = child?.frozenCriteria?.length ? child.frozenCriteria : (input.handoff?.acceptanceCriteria ?? []);
  const laneFiles = child?.laneFiles?.length ? child.laneFiles : (input.handoff?.laneFiles ?? []);
  const changed = input.changed;
  // An unknown diff is reported as unknown: "no violations" and "could not look"
  // are different facts, and only one of them licenses an approval.
  const outOfLane = changed ? changed.filter((file) => !pathMatchesAnyLane(laneFiles, file)) : [];
  const previous = new Set(input.previousFiles ?? []);
  const allHunks = parseDiff(input.diff);
  const fresh = previous.size ? allHunks.filter((hunk) => !previous.has(hunk.file)) : allHunks;
  const omittedFiles = previous.size
    ? [...new Set(allHunks.filter((hunk) => previous.has(hunk.file)).map((hunk) => hunk.file))].sort()
    : [];

  return {
    scope: input.scope,
    handoffId: input.handoff?.id,
    revision: child?.handoffRevision ?? input.handoff?.revision,
    frozen: Boolean(child?.frozenCriteria?.length),
    criteria,
    laneFiles,
    changed,
    outOfLane,
    hunks: fresh,
    omittedHunks: 0,
    omittedFiles,
    child: child
      ? {
          name: child.name,
          id: child.id,
          status: child.status,
          elapsed: elapsed(child.startedAt, input.now),
          budget: budget(child.budgetMs),
          lastTail: child.lastTail ?? undefined,
        }
      : undefined,
    lastReport: child?.lastTail ?? undefined,
  };
}

/** Trim a tail to one short paragraph: the parent needs the child's claim, not its log. */
function oneLine(text: string | null | undefined, max = 320): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Render the packet under a character budget.
 *
 * Truncation is always *stated* (`+N hunks omitted (budget)`), never silent: an
 * agent that cannot tell a short diff from a clipped one reports "no problems
 * found" about code it never saw.
 */
export function renderReviewPacket(packet: ReviewPacket, budgetChars = PACKET_CHAR_BUDGET): string {
  // Body hunks are budgeted against a reserve, because the trailing lines (the
  // omission notice and the child's report) are appended afterwards. Without the
  // reserve the packet could end one line over budget, which is exactly the kind
  // of off-by-a-header overflow a budget test is supposed to catch.
  const reserve = 90 + (packet.omittedFiles.length ? packet.omittedFiles.join(", ").length : 0);
  const bodyBudget = Math.max(400, budgetChars - reserve);
  const lines: string[] = [];
  const head = [packet.scope];
  if (packet.handoffId) head.push(`handoff ${packet.handoffId} rev ${packet.revision ?? "?"}${packet.frozen ? " (frozen)" : ""}`);
  if (packet.child) {
    head.push(`${packet.child.name} [${packet.child.id}] ${packet.child.status}${packet.child.elapsed ? ` ${packet.child.elapsed}` : ""}${packet.child.budget ? `/${packet.child.budget}` : ""}`);
  }
  lines.push(head.join(" · "));

  const criteria = packet.criteria.map((criterion, index) => `${index + 1}) ${criterion}`);
  lines.push(`criteria (${criteria.length}): ${criteria.join("  ") || "(none declared)"}`);

  const changed = packet.changed
    ? `changed ${packet.changed.length}`
    : "changed: unknown (git unavailable — lane NOT verified)";
  const violations = packet.outOfLane.length ? ` · OUT OF LANE ${packet.outOfLane.length}: ${packet.outOfLane.join(", ")}` : "";
  lines.push(`lane: ${packet.laneFiles.join(", ") || "(none)"} — ${changed}${violations}`);

  const added = packet.hunks.reduce((total, hunk) => total + hunk.added, 0);
  const removed = packet.hunks.reduce((total, hunk) => total + hunk.removed, 0);
  lines.push(`diff: +${added} −${removed} in ${packet.hunks.length + packet.omittedHunks} hunk(s)`);
  if (packet.omittedFiles.length) lines.push(`unchanged since last brief: ${packet.omittedFiles.join(", ")}`);

  let used = lines.join("\n").length;
  let omitted = 0;
  for (const hunk of packet.hunks) {
    const block = [`  ${hunk.file} ${hunk.header} +${hunk.added} −${hunk.removed}`, ...hunk.lines.slice(0, 12)];
    const size = block.join("\n").length + 1;
    if (used + size > bodyBudget) {
      omitted++;
      continue;
    }
    used += size;
    lines.push(...block);
  }
  if (omitted) lines.push(`+${omitted} hunk(s) omitted (budget) — inspect with read/grep if they matter`);

  const report = oneLine(packet.lastReport);
  if (report) {
    const line = `child report: ${report}`;
    const room = budgetChars - (lines.join("\n").length + 1) - 1;
    lines.push(room > 20 ? `child report: ${report.slice(0, Math.max(0, room - 14))}${report.length > room - 14 ? "…" : ""}` : "child report: (omitted — budget)");
  }
  const rendered = lines.join("\n");
  return rendered.length <= budgetChars ? rendered : `${rendered.slice(0, budgetChars - 1)}…`;
}

/** Runners the check may call: a test runner or a typechecker, nothing else. */
const ALLOWED_VERIFY_PREFIXES = [
  "npm test",
  "npm run test",
  "npm run tsc",
  "npx tsc",
  "npx vitest",
  "npx jest",
  "bun test",
  "bun run test",
  "bun x tsc",
  "node --test",
  "node --experimental-strip-types --test",
  "pytest",
  "python -m pytest",
  "go test",
  "cargo test",
  "deno test",
  "make test",
];

/**
 * Why a command may be refused.
 *
 * `orch_check` runs in a reviewer that cannot write. A general shell would be a
 * write primitive wearing a test's name, so the grammar is a fixed set of test
 * runners and no shell metacharacters — the same reasoning as the read-only bash
 * narrowing in supervise mode, applied to the one command that has to run.
 */
export function verifyCommandProblem(command: string | undefined): string | undefined {
  const cmd = (command ?? "").trim();
  if (!cmd) return "no command given";
  if (/[;&|<>`$(){}]|&&|\|\|/.test(cmd)) return "shell metacharacters are not allowed in a verification command";
  if (!ALLOWED_VERIFY_PREFIXES.some((prefix) => cmd === prefix || cmd.startsWith(`${prefix} `))) {
    return `only test/typecheck runners are allowed (${ALLOWED_VERIFY_PREFIXES.slice(0, 4).join(", ")}, …)`;
  }
  return undefined;
}

export interface CommandResult {
  exit: number;
  output: string;
  timedOut?: boolean;
}

export interface CheckInput {
  scope: string;
  laneFiles: readonly string[];
  changed: string[] | null;
  criteria: readonly string[];
  command?: string;
  run?: (command: string) => CommandResult;
  timeoutMs?: number;
}

export interface CheckReport {
  scope: string;
  lane: { state: "pass" | "fail" | "unknown"; violations: string[]; changed: number };
  tests: { state: "pass" | "fail" | "not-run"; command?: string; exit?: number; failed: string[]; reason?: string };
  refs: EvidenceRef[];
  lines: string[];
}

const FAILURE_LINE = /^(?:not ok \d+ - |✗ |× |FAILED )(.+)$/;
const FAILURE_COUNT = /^# fail (\d+)/m;

function failedNames(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split("\n")) {
    const match = line.trim().match(FAILURE_LINE);
    if (match?.[1]) names.push(match[1].trim());
  }
  return [...new Set(names)].slice(0, 5);
}

/**
 * Run the review's deterministic half.
 *
 * The returned `refs` are the point: `orch_review` refuses an approval without
 * verifiable evidence, so returning refs in that shape removes the transcription
 * step where a model can quietly cite a result it did not see.
 */
export function buildCheckReport(input: CheckInput): CheckReport {
  const changed = input.changed;
  const violations = changed ? changed.filter((file) => !pathMatchesAnyLane(input.laneFiles, file)) : [];
  const lane = {
    state: changed ? (violations.length ? "fail" : "pass") as "pass" | "fail" : "unknown" as const,
    violations,
    changed: changed?.length ?? 0,
  };

  const refs: EvidenceRef[] = [];
  for (const file of (changed ?? []).filter((file) => !violations.includes(file)).slice(0, 5)) {
    refs.push({ kind: "file", path: file } as EvidenceRef);
  }

  let tests: CheckReport["tests"] = { state: "not-run", failed: [], reason: undefined };
  const problem = verifyCommandProblem(input.command);
  if (input.command && problem) {
    tests = { state: "not-run", command: input.command, failed: [], reason: problem };
  } else if (input.command && input.run) {
    const result = input.run(input.command);
    const failed = failedNames(result.output);
    const countMatch = result.output.match(FAILURE_COUNT);
    const failedCount = countMatch ? Number(countMatch[1]) : failed.length;
    const state = result.timedOut ? "not-run" : result.exit === 0 ? "pass" : "fail";
    tests = {
      state,
      command: input.command,
      exit: result.exit,
      failed,
      reason: result.timedOut ? `timed out after ${Math.round((input.timeoutMs ?? 300_000) / 1000)}s` : undefined,
    };
    if (!result.timedOut) refs.push({ kind: "cmd", cmd: input.command, exit: result.exit } as EvidenceRef);
    if (failedCount > 0 && failed[0]) refs.push({ kind: "test", name: failed[0], pass: false } as EvidenceRef);
    else if (result.exit === 0) refs.push({ kind: "test", name: `${input.command} (suite)`, pass: true } as EvidenceRef);
  }

  const lines = [
    `${input.scope} · check`,
    `lane: ${lane.state.toUpperCase()}${changed ? ` (${lane.changed} changed${violations.length ? `, ${violations.length} out of lane: ${violations.join(", ")}` : ""})` : " (git unavailable — not verified)"}`,
    `tests: ${tests.state === "not-run" ? `NOT RUN${tests.reason ? ` — ${tests.reason}` : ""}` : `${tests.state.toUpperCase()} [${tests.command} exit ${tests.exit}]${tests.failed.length ? ` failing: ${tests.failed.join(", ")}` : ""}`}`,
    `criteria (${input.criteria.length}): judge each against the refs below`,
    `refs: ${refs.length ? refs.map((ref) => ref.kind === "file" ? `file:${(ref as any).path}` : ref.kind === "cmd" ? `cmd:${(ref as any).cmd} exit ${(ref as any).exit}` : `test:${(ref as any).name} ${(ref as any).pass ? "pass" : "fail"}`).join(" · ") : "(none)"}`,
  ];
  return { scope: input.scope, lane, tests, refs, lines };
}

export function renderCheckReport(report: CheckReport, budgetChars = CHECK_CHAR_BUDGET): string {
  const text = report.lines.join("\n");
  return text.length <= budgetChars ? text : `${text.slice(0, budgetChars - 1)}…`;
}
