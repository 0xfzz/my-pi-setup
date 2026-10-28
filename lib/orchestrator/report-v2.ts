/**
 * report-v2.ts — one reviewer, several specifications, one report.
 *
 * A chunk reviewer judges a group of work-unit specs (2–3 of them). The v1 report
 * could not express that safely: it had one `coverage[]` and one `findings[]` for
 * the whole target, so a reviewer handed three specs could satisfy it by reading
 * one and saying nothing about the other two. "Nothing found" and "nothing looked
 * at" were already the same thing at the document level; at the chunk level they
 * were indistinguishable from "read a third of your assignment".
 *
 * So v2 makes the member block the unit of evidence:
 *
 *   - EVERY pinned member must appear exactly once. A report that skips a member
 *     is incomplete, never clean.
 *   - `coverage[]` is required per member with zero findings.
 *   - a finding lives inside its member's block; a payload cannot move it to a
 *     sibling by claiming a different `memberId`.
 *
 * Findings are still the v1 shape, so dispositions, patches, clustering and the
 * readiness rules keep working unchanged.
 */
import { createHash } from "node:crypto";

import {
  parseFindingEntry,
  type ReviewFinding,
  type Severity,
} from "./spec-review.ts";
import type { MemberReportFacts } from "./wave.ts";
import { renderLintForReviewer, type SpecLintFinding } from "./spec-lint.ts";

/** One spec as the reviewer sees it: pinned text, never a live document. */
export interface ChunkMemberPin {
  scope: string;
  artifactId: string;
  contentHash: string;
  content: string;
  title?: string;
}

export interface MemberReportBlock {
  memberId: string;
  verdict: "clean" | "findings" | "blocked";
  coverage: string[];
  findings: ReviewFinding[];
}

export interface ChunkReport {
  version: 2;
  runId: string;
  chunkId: string;
  /** Hash of the whole chunk content, so a report cannot be stitched to another pin. */
  targetHash: string;
  summary: string;
  members: MemberReportBlock[];
  missingContext?: string[];
  submittedAt: string;
}

export interface ChunkParseResult {
  ok: boolean;
  report?: ChunkReport;
  problems: string[];
}

/** Canonical bytes of a chunk: members sorted by scope, so order cannot fork the hash. */
export function renderChunkContent(members: readonly ChunkMemberPin[]): string {
  return JSON.stringify(
    [...members]
      .sort((a, b) => a.scope.localeCompare(b.scope))
      .map((member) => ({ scope: member.scope, artifactId: member.artifactId, content: member.content })),
  );
}

export function chunkContentHash(members: readonly ChunkMemberPin[]): string {
  return createHash("sha256").update(renderChunkContent(members), "utf8").digest("hex");
}

function cleanStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim())
    : [];
}

/**
 * Validate a chunk report against the exact member set it was asked to judge.
 *
 * Identity is checked from the run, not trusted from the payload. A reviewer that
 * reports on another chunk, another revision, or three of four members fails here
 * rather than being stitched into this run.
 */
export function parseChunkReport(
  raw: unknown,
  expected: { runId: string; chunkId: string; targetHash: string; memberIds: readonly string[] },
): ChunkParseResult {
  let value: any = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch (error: any) {
      return { ok: false, problems: [`report is not valid JSON: ${error?.message ?? error}`] };
    }
  }
  if (!value || typeof value !== "object") return { ok: false, problems: ["report is not an object"] };

  const problems: string[] = [];
  if (value.version !== 2) problems.push(`unsupported report version: ${String(value.version)} (this chunk needs version 2)`);
  if (value.runId !== expected.runId) problems.push(`report runId "${String(value.runId)}" does not match ${expected.runId}`);
  if (value.chunkId !== expected.chunkId) {
    problems.push(`report chunkId "${String(value.chunkId)}" does not match ${expected.chunkId}`);
  }
  if (value.targetHash !== expected.targetHash) {
    problems.push("report targetHash does not match the pinned chunk — it reviews different content");
  }
  const summary = String(value.summary ?? "").trim();
  if (!summary) problems.push("report has no summary");
  if (!Array.isArray(value.members)) problems.push("report has no members array");

  const expectedIds = [...new Set(expected.memberIds.map((id) => String(id).trim()).filter(Boolean))];
  const rawMembers: any[] = Array.isArray(value.members) ? value.members : [];
  const seen = new Set<string>();
  const blocks: MemberReportBlock[] = [];
  const findingIds = new Set<string>();

  for (const [index, rawMember] of rawMembers.entries()) {
    if (!rawMember || typeof rawMember !== "object") {
      problems.push(`members[${index}] is not an object`);
      continue;
    }
    const memberId = String(rawMember.memberId ?? "").trim();
    if (!memberId) {
      problems.push(`members[${index}] has no memberId`);
      continue;
    }
    if (!expectedIds.includes(memberId)) {
      problems.push(`members[${index}] names "${memberId}", which is not in this chunk`);
      continue;
    }
    if (seen.has(memberId)) {
      problems.push(`member "${memberId}" is reported twice`);
      continue;
    }
    seen.add(memberId);

    const rawFindings: any[] = Array.isArray(rawMember.findings) ? rawMember.findings : [];
    const findings: ReviewFinding[] = [];
    rawFindings.forEach((entry: any, position: number) => {
      const parsed = parseFindingEntry(entry, memberId, position, { memberId });
      if (parsed.problem) problems.push(`${memberId}: ${parsed.problem}`);
      else if (parsed.finding) findings.push(parsed.finding);
    });
    for (const finding of findings) {
      if (findingIds.has(finding.id)) problems.push(`duplicate finding id: ${finding.id}`);
      findingIds.add(finding.id);
    }

    const verdict = rawMember.verdict;
    if (verdict !== undefined && !["clean", "findings", "blocked"].includes(verdict)) {
      problems.push(`${memberId}: invalid verdict ${String(verdict)}`);
    }
    const coverage = cleanStrings(rawMember.coverage);
    // Same anti-rubber-stamp rule as v1, now per member: a clean member block has
    // to say what was checked, or it is indistinguishable from a skipped one.
    if (rawFindings.length === 0 && verdict !== "blocked" && coverage.length === 0) {
      problems.push(
        `${memberId}: an empty findings array needs coverage[] — state what you checked, `
          + `otherwise "nothing found" is indistinguishable from "nothing looked at"`,
      );
    }
    blocks.push({
      memberId,
      verdict: (verdict as MemberReportBlock["verdict"]) ?? (findings.length ? "findings" : "clean"),
      coverage,
      findings,
    });
  }

  for (const memberId of expectedIds) {
    if (!seen.has(memberId)) {
      problems.push(`no block for member "${memberId}" — a chunk reviewer judges every spec in its chunk`);
    }
  }

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    problems: [],
    report: {
      version: 2,
      runId: expected.runId,
      chunkId: expected.chunkId,
      targetHash: expected.targetHash,
      summary,
      members: blocks,
      ...(cleanStrings(value.missingContext).length ? { missingContext: cleanStrings(value.missingContext) } : {}),
      submittedAt: typeof value.submittedAt === "string" && value.submittedAt ? value.submittedAt : new Date().toISOString(),
    },
  };
}

/**
 * What the wave needs to know about each member.
 *
 * `covered` is false when the block is missing OR when it carries no coverage and
 * no findings: the reviewer produced no evidence about that member.
 */
export function chunkMemberFacts(report: ChunkReport): Record<string, MemberReportFacts> {
  const facts: Record<string, MemberReportFacts> = {};
  for (const block of report.members) {
    facts[block.memberId] = {
      submitted: true,
      covered: block.coverage.length > 0 || block.findings.length > 0,
      ...(block.verdict ? { verdict: block.verdict } : {}),
      ...(report.missingContext?.length ? { missingContext: report.missingContext } : {}),
    };
  }
  return facts;
}

export function chunkFindings(report: ChunkReport): ReviewFinding[] {
  return report.members.flatMap((block) => block.findings);
}

export function chunkCounts(findings: readonly ReviewFinding[]): { blocker: number; major: number; nit: number } {
  const counts = { blocker: 0, major: 0, nit: 0 };
  for (const finding of findings) counts[finding.severity as Severity] += 1;
  return counts;
}

/** The rubric for a chunk reviewer: the gate rubric plus the cross-member checks. */
export const CHUNK_RUBRIC = `Judge whether a competent engineer who has never spoken to the author could implement each of these work units as written, and whether the result could be verified.
Flag every term, service, file, interface or prerequisite that is not defined in the member document or reachable from the permitted repository paths.
Flag hand-waving ("the system handles it"), assumed workflow steps, and any requirement whose acceptance cannot be observed.
Check that named paths, modules, functions and interfaces exist or are created by this plan; that dependencies and migrations are named; and that a verification command could plausibly fail.
Report contradictions between sections as findings, not as questions.`;

export const CROSS_MEMBER_CHECKS = `You judge these work units TOGETHER as well as individually. Also report:
- two members that assume different shapes for the same interface;
- a member that needs a file another member owns, with no line saying so;
- duplicated work, or a step split so that neither member can finish alone;
- an ordering assumption that the declared dependencies do not express.
A cross-member defect is filed against the member that must change, with the sibling named in \`rationale\`.`;

export function renderChunkTicket(input: {
  runId: string;
  chunkId: string;
  members: readonly ChunkMemberPin[];
  focus?: string;
  lint?: Record<string, readonly SpecLintFinding[]>;
  roots: string[];
}): string {
  const { chunkId, members } = input;
  const scopes = members.map((member) => member.scope);
  const blocks = members
    .map(
      (member) => `### Member: ${member.scope}
Artifact: \`${member.artifactId}\` · version: ${member.contentHash.slice(0, 12)}
The text between the markers is the exact revision under review. Any difference from
the live document is out of scope; if you find one, report it as a finding.

<<<PINNED_MEMBER_START ${member.scope} ${member.contentHash}>>>
${member.content}
<<<PINNED_MEMBER_END ${member.scope}>>>
${renderLintForReviewer(input.lint?.[member.scope] ?? [])}`,
    )
    .join("\n");

  return `# Independent specification review — ${chunkId}

You are reviewing ${members.length} work-unit specification${members.length === 1 ? "" : "s"} you did not write.
You did not inherit any parent conversation and you cannot ask the author anything.
A gap you cannot close from the documents or the permitted files below is a finding.

## Your chunk
${chunkId} judges: ${scopes.join(", ")}. Judge EVERY member. A member you skip is
reported as incomplete and blocks the whole chunk.

## Rubric
${CHUNK_RUBRIC}

## Cross-member checks
${CROSS_MEMBER_CHECKS}

## Permitted reference paths
${input.roots.length ? input.roots.map((root) => `- \`${root}\``).join("\n") : "- (none)"}
${input.focus ? `\n## Focus requested by the orchestrator\n${input.focus}\n` : ""}
## Members
${blocks}

## How to report
Call \`orch_spec_review_submit\` exactly once, with a version 2 report:

\`\`\`json
{
  "version": 2,
  "runId": "${input.runId}",
  "chunkId": "${chunkId}",
  "targetHash": "<the hash printed above for this chunk>",
  "summary": "2-4 sentences, plain English, no praise",
  "members": [
    { "memberId": ${JSON.stringify(scopes[0])}, "verdict": "findings",
      "coverage": ["goal", "acceptance criteria", "lane", "interfaces"],
      "findings": [ { "id": "F-${scopes[0]}-1", "severity": "blocker | major | nit",
                      "location": "section heading or line in this member",
                      "discrepancy": "what is wrong", "rationale": "why it blocks an implementer",
                      "suggestion": "optional", "references": ["optional path"],
                      "patch": { "oldText": "literal member text", "newText": "replacement" } } ] }
  ],
  "missingContext": ["anything you needed and could not find"]
}
\`\`\`

Rules:
- every member listed above appears exactly once, with its own block;
- \`coverage[]\` is REQUIRED for a member with no findings;
- a finding belongs to its own member block — do not name a sibling;
- patch \`oldText\` must be the literal text of THAT member, not JSON-escaped;
- blockers are for defects that make implementation unsafe or impossible, never style.

Blocks that change acceptance criteria, lane files, interfaces, the report shape or
the vision are not patches the orchestrator can apply automatically: report them as
findings and say so in the summary.
`;
}
