/**
 * result-check.ts — the mechanical receipt for a finished child.
 *
 * "The parent is responsible for the result" used to mean the parent was TOLD it
 * was responsible. Nothing compared the result with the handoff: a child that
 * ended its turn without writing the report, edited outside its lane, never
 * opened the handoff, or died on a provider error was reported as `completed`
 * and could be accepted on attested prose alone.
 *
 * This module checks what is checkable from artifacts the child cannot fake
 * away — the report sidecar on disk and the child's own transcript — and
 * returns issues in two tiers:
 *
 *   blocking — the result cannot match the handoff (no report, out-of-lane
 *              write, ended on an error). `agent_accept_result` refuses
 *              `accepted` unless the parent names each code it overrides.
 *   advisory — likely mismatch a human must read (criterion not mentioned in the
 *              report, handoff never opened).
 *
 * Whether the work is *correct* stays the parent's judgment; this only proves
 * the result is the kind of thing that could match.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

import { artifactSidecarPath } from "../artifact-state.ts";
import { reportArtifactId } from "./handoff-artifact.ts";
import { laneCoversPath, normalizePath } from "./lane.ts";
import { readChildHealth } from "./child-health.ts";

export type ResultIssueCode =
  | "report-missing"
  | "lane-violation"
  | "unowned-change"
  | "ended-on-error"
  | "no-clean-exit"
  | "criterion-not-reported"
  | "handoff-not-opened";

export interface ResultIssue {
  code: ResultIssueCode;
  blocking: boolean;
  detail: string;
}

export interface ResultReceipt {
  checkedAt: string;
  reportId: string;
  reportFound: boolean;
  /** Paths written outside the lane (workers) — empty when clean. */
  outOfLane: string[];
  issues: ResultIssue[];
}

export interface ResultCheckInput {
  sessionFile: string;
  scope: string;
  handoffId?: string;
  laneFiles: readonly string[];
  frozenCriteria?: readonly string[];
  /** Working directory, to relativise absolute write paths against the lane. */
  cwd: string;
  /** How the watcher saw the child end. */
  outcome: "completed" | "completed-user-exit" | "failed";
  now?: () => number;
  /**
   * Working-tree findings (see git-changes.ts), which see writes made by ANY tool,
   * `bash` included. Absent when the directory is not a git repository.
   */
  tree?: { unowned: string[]; ambiguous: boolean };
}

const WRITE_TOOLS = new Set(["write", "edit", "multi_edit", "multiedit", "apply_patch", "applypatch", "patch"]);

/** `handoff-api-2` → 2. A missing/odd id means round 1. */
export function roundOfHandoff(handoffId: string | undefined): number {
  const match = /-(\d+)$/.exec(handoffId ?? "");
  return match ? Math.max(1, Number(match[1])) : 1;
}

function toolCalls(sessionFile: string): Array<{ name: string; args: any }> {
  const calls: Array<{ name: string; args: any }> = [];
  let raw = "";
  try {
    raw = readFileSync(sessionFile, "utf8");
  } catch {
    return calls;
  }
  for (const line of raw.split("\n")) {
    if (!line.includes('"toolCall"')) continue;
    try {
      const entry = JSON.parse(line);
      const content = entry?.message?.content;
      if (entry?.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === "toolCall" && typeof block.name === "string") {
          calls.push({ name: block.name, args: block.arguments ?? {} });
        }
      }
    } catch {
      // a half-written line is not a call
    }
  }
  return calls;
}

function writtenPaths(args: any): string[] {
  const paths: string[] = [];
  for (const key of ["path", "file_path", "filePath"]) {
    if (typeof args?.[key] === "string" && args[key].trim()) paths.push(args[key]);
  }
  if (Array.isArray(args?.paths)) paths.push(...args.paths.filter((p: unknown): p is string => typeof p === "string"));
  if (Array.isArray(args?.edits)) {
    for (const edit of args.edits) if (typeof edit?.path === "string") paths.push(edit.path);
  }
  return paths;
}

/** Scratch and control-plane locations a child legitimately writes outside its lane. */
function isHarnessPath(path: string): boolean {
  return /^(\.pi\/|\.git\/)/.test(path) || /^\/(tmp|var\/tmp)\//.test(path) || path.startsWith("..");
}

const STOPWORDS = new Set(["that", "this", "with", "from", "have", "must", "should", "when", "then", "into", "will", "each", "every", "does", "than", "they", "there", "their"]);

function words(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z0-9_./-]{4,}/g) ?? []).filter((w) => !STOPWORDS.has(w)))];
}

/** A criterion is "reported" when most of its distinctive words appear in the report. */
export function criterionMentioned(criterion: string, report: string): boolean {
  const key = words(criterion);
  if (key.length === 0) return true;
  const haystack = report.toLowerCase();
  const hit = key.filter((word) => haystack.includes(word)).length;
  return hit / key.length >= 0.5;
}

function readReport(sessionFile: string, reportId: string): string | null {
  const path = artifactSidecarPath(sessionFile, reportId);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const content = typeof raw?.content === "string" ? raw.content.trim() : "";
    return content || null;
  } catch {
    return null;
  }
}

export function checkResult(input: ResultCheckInput): ResultReceipt {
  const issues: ResultIssue[] = [];
  const reportId = reportArtifactId(input.scope, roundOfHandoff(input.handoffId));
  const report = readReport(input.sessionFile, reportId);

  if (input.outcome === "completed-user-exit") {
    issues.push({
      code: "no-clean-exit",
      blocking: true,
      detail: "the pane exited without agent_done — the child never declared it was finished",
    });
  }
  if (report === null) {
    issues.push({
      code: "report-missing",
      blocking: true,
      detail: `the handoff requires \`${reportId}\` and none was written; there is nothing to compare with the handoff`,
    });
  } else {
    const unreported = (input.frozenCriteria ?? []).filter((criterion) => !criterionMentioned(criterion, report));
    for (const criterion of unreported) {
      issues.push({
        code: "criterion-not-reported",
        blocking: false,
        detail: `criterion not addressed in ${reportId}: "${criterion.slice(0, 160)}"`,
      });
    }
  }

  const calls = toolCalls(input.sessionFile);
  if (input.handoffId && !calls.some((c) => c.name === "artifact_recall" && String(c.args?.id ?? "") === input.handoffId)) {
    issues.push({
      code: "handoff-not-opened",
      blocking: false,
      detail: `no artifact_recall of \`${input.handoffId}\` in the child's transcript — it may have worked from the ticket alone`,
    });
  }

  const outOfLane = new Set<string>();
  for (const call of calls) {
    if (!WRITE_TOOLS.has(call.name.toLowerCase())) continue;
    for (const raw of writtenPaths(call.args)) {
      const path = normalizePath(isAbsolute(raw) ? relative(input.cwd, raw) : raw);
      if (!path || isHarnessPath(path)) continue;
      if (!input.laneFiles.some((lane) => laneCoversPath(lane, path))) outOfLane.add(path);
    }
  }
  if (outOfLane.size > 0) {
    issues.push({
      code: "lane-violation",
      blocking: true,
      detail: input.laneFiles.length
        ? `wrote outside its lane (${input.laneFiles.join(", ")}): ${[...outOfLane].slice(0, 8).join(", ")}`
        : `no lane was declared, yet it wrote: ${[...outOfLane].slice(0, 8).join(", ")}`,
    });
  }

  if (input.tree && input.tree.unowned.length > 0) {
    issues.push({
      code: "unowned-change",
      // The parent ran shell commands in the window, so the change may be its own.
      blocking: !input.tree.ambiguous,
      detail: `the working tree changed outside this child's lane (any tool, bash included): ${input.tree.unowned.slice(0, 8).join(", ")}`
        + (input.tree.ambiguous ? " — the parent also ran shell commands meanwhile, so this may not be the child's doing" : ""),
    });
  }

  const health = readChildHealth(input.sessionFile);
  if (input.outcome !== "failed" && health.error && health.error.verdict.class !== "aborted") {
    issues.push({
      code: "ended-on-error",
      blocking: true,
      detail: `the last assistant turn failed (${health.error.verdict.class}): ${health.error.message.slice(0, 200)}`,
    });
  }

  return {
    checkedAt: new Date((input.now ?? Date.now)()).toISOString(),
    reportId,
    reportFound: report !== null,
    outOfLane: [...outOfLane],
    issues,
  };
}

/** Blocking codes the parent has not named as overridden. */
export function unresolvedBlockers(receipt: ResultReceipt | undefined, overrides: readonly string[] = []): ResultIssue[] {
  if (!receipt) return [];
  const named = new Set(overrides.map((o) => o.trim().toLowerCase()));
  return receipt.issues.filter((issue) => issue.blocking && !named.has(issue.code));
}

export function renderReceipt(receipt: ResultReceipt): string {
  if (receipt.issues.length === 0) {
    return `Receipt (mechanical): report \`${receipt.reportId}\` present, no out-of-lane writes, every criterion mentioned. Correctness is still YOUR judgment.`;
  }
  return [
    `Receipt (mechanical) — ${receipt.issues.filter((i) => i.blocking).length} blocking, ${receipt.issues.filter((i) => !i.blocking).length} advisory:`,
    ...receipt.issues.map((i) => `- [${i.blocking ? "BLOCKING" : "advisory"}] ${i.code}: ${i.detail}`),
    "A blocking issue means the result cannot match the handoff: record changes-requested (or abandoned), "
    + "or accept only with `overrides` naming the code and why.",
  ].join("\n");
}
