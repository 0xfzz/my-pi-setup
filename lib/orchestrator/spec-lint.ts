/**
 * spec-lint.ts — the machine-checkable part of "is this spec reviewable?".
 *
 * A readiness judgement is a judgement, and a judgement cannot be calibrated by
 * another judgement. These checks are the part of the rubric that a computer can
 * decide: does a path the spec depends on actually exist, and does the spec say
 * anything observable at all. They are fed to reviewers as *pre-computed findings
 * to confirm or refute*, not as a verdict, so a reviewer that ignores them is
 * still free to be right — but the cheap defects stop depending on attention.
 *
 * Deliberately narrow. Contradictions between sections, missing migrations and
 * "this will not scale" are not machine-checkable here, and pretending otherwise
 * would turn a calibration aid into a rubber stamp.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type LintSeverity = "blocker" | "major" | "nit";

export interface SpecLintFinding {
  id: string;
  severity: LintSeverity;
  location: string;
  discrepancy: string;
  rationale: string;
  suggestion?: string;
}

export interface LintSpecInput {
  content: string;
  references?: readonly string[];
  createdPaths?: readonly string[];
  cwd: string;
}

/** Path-shaped tokens: a slash, or a known source/document extension. */
const PATH_TOKEN = /`([^`]+)`/g;
const PATHLIKE = /(^|\/)[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|toml|yaml|yml|sql|sh)$|^[\w.-]+\/[\w./-]+$/i;
const OBSERVABLE = /\b(test|tests|assert|verify|command|exit code|curl|grep|snapshot|benchmark|log line|metric)\b/i;

function cleanPath(raw: string): string {
  return raw
    .replace(/#.*$/, "")
    .trim()
    .replace(/^[`"']+|[`"']+$/g, "")
    .trim()
    .replace(/^(?:path|file):\s*/i, "")
    .trim()
    .replace(/^(\.\/)+/, "")
    .replace(/\\/g, "/");
}

function lineOf(content: string, needle: string): number {
  const index = content.indexOf(needle);
  if (index < 0) return 1;
  return content.slice(0, index).split("\n").length;
}

function pathTokens(content: string): string[] {
  const found: string[] = [];
  for (const match of content.matchAll(PATH_TOKEN)) {
    let token = match[1]!.trim();
    if (!token || token.includes("*") || /^https?:/i.test(token) || token.startsWith("-")) continue;
    if (/\s/.test(token)) {
      const newMatch = token.match(/^([^\s`]+)\s+(?:\(\s*)?#\s*new\b/i);
      if (newMatch) {
        token = newMatch[1]!;
      } else {
        continue;
      }
    }
    if (!PATHLIKE.test(token)) continue;
    found.push(token);
  }
  return [...new Set(found)];
}

/**
 * Extract unambiguous declarations of created / new paths from spec content
 * and explicit createdPaths input.
 *
 * Supported document declarations:
 * 1. `creates:` YAML lists (block style or flow `[a, b]` style)
 * 2. `path # new` (inline code, list items, or plain text)
 *
 * Note: A lane declaration alone does NOT exempt missing references.
 */
export function extractCreatedPaths(input: {
  content?: string;
  createdPaths?: readonly string[];
  cwd?: string;
}): string[] {
  const result = new Set<string>();

  // 1. Explicit input
  for (const raw of input.createdPaths ?? []) {
    const cleaned = cleanPath(String(raw ?? ""));
    if (cleaned && PATHLIKE.test(cleaned)) {
      result.add(cleaned);
    }
  }

  const content = String(input.content ?? "");
  if (!content) return [...result];

  const lines = content.split("\n");

  // 2. `creates:` YAML lists
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Flow style: creates: [a, b, c]
    const flowMatch = line.match(/^\s*(?:-\s*)?creates?:\s*\[(.*?)\]/i);
    if (flowMatch) {
      const items = flowMatch[1]!.split(",");
      for (const item of items) {
        const cleaned = cleanPath(item);
        if (cleaned && PATHLIKE.test(cleaned)) {
          result.add(cleaned);
        }
      }
      continue;
    }

    // Block style: creates:\n  - a\n  - b
    const blockMatch = line.match(/^(\s*)(?:-\s*)?creates?:\s*(?:#.*)?$/i);
    if (blockMatch) {
      const baseIndent = blockMatch[1]!.length;
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j]!;
        if (/^\s*$/.test(nextLine)) {
          j++;
          continue;
        }
        const itemMatch = nextLine.match(/^(\s*)-\s*([^#\n]+)(?:#.*)?$/);
        if (!itemMatch) break;
        const itemIndent = itemMatch[1]!.length;
        if (baseIndent > 0 && itemIndent <= baseIndent) break;

        const rawItem = itemMatch[2]!;
        // Avoid treating a subsequent YAML mapping key like "lane: foo" as a list item
        if (/^\w+:\s/.test(rawItem.trim()) && !/^(?:path|file):\s*/i.test(rawItem.trim())) {
          break;
        }
        const cleaned = cleanPath(rawItem);
        if (cleaned && PATHLIKE.test(cleaned)) {
          result.add(cleaned);
        }
        j++;
      }
    }
  }

  // 3. `path # new` declarations
  // Inside backticks: `path # new`
  for (const match of content.matchAll(/`([^`\s]+)\s+(?:\(\s*)?#\s*new\b[^`]*`/gi)) {
    const cleaned = cleanPath(match[1]!);
    if (cleaned && PATHLIKE.test(cleaned)) {
      result.add(cleaned);
    }
  }

  // Backticks followed by # new: `path` # new or `path` (# new)
  for (const match of content.matchAll(/`([^`\s]+)`\s*(?:\(\s*)?#\s*new\b/gi)) {
    const cleaned = cleanPath(match[1]!);
    if (cleaned && PATHLIKE.test(cleaned)) {
      result.add(cleaned);
    }
  }

  // List item or line with path # new: - path # new or * path # new
  for (const match of content.matchAll(/^\s*[-*]\s*([^\s`]+)\s+(?:\(\s*)?#\s*new\b/gmi)) {
    const cleaned = cleanPath(match[1]!);
    if (cleaned && PATHLIKE.test(cleaned)) {
      result.add(cleaned);
    }
  }

  return [...result];
}

function buildCreatedLookup(paths: readonly string[], cwd: string): Set<string> {
  const set = new Set<string>();
  for (const p of paths) {
    const cleaned = cleanPath(p);
    if (!cleaned) continue;
    set.add(cleaned);
    set.add(resolve(cwd, cleaned));
    set.add(resolve(cwd, cleaned).replace(/\\/g, "/"));
  }
  return set;
}

function isCreated(token: string, lookup: Set<string>, cwd: string): boolean {
  const cleaned = cleanPath(token);
  if (lookup.has(cleaned)) return true;
  if (lookup.has(resolve(cwd, token))) return true;
  if (lookup.has(resolve(cwd, token).replace(/\\/g, "/"))) return true;
  if (lookup.has(resolve(cwd, cleaned))) return true;
  if (lookup.has(resolve(cwd, cleaned).replace(/\\/g, "/"))) return true;
  return false;
}

/**
 * Findings a computer can make about a spec. Empty means "nothing machine-detectable",
 * never "the spec is good".
 */
export function lintSpec(input: LintSpecInput): SpecLintFinding[] {
  const content = String(input.content ?? "");
  const findings: SpecLintFinding[] = [];

  const createdList = extractCreatedPaths({
    content,
    createdPaths: input.createdPaths,
    cwd: input.cwd,
  });
  const createdLookup = buildCreatedLookup(createdList, input.cwd);

  for (const token of pathTokens(content)) {
    // A spec may deliberately name a file it CREATES. Only a missing path that is
    // also not described as new is a defect, and that distinction is prose — so
    // this is a major, not a blocker, and the reviewer decides.
    if (existsSync(resolve(input.cwd, token))) continue;
    if (isCreated(token, createdLookup, input.cwd)) continue;
    findings.push({
      id: `L-path-${findings.length + 1}`,
      severity: "major",
      location: `line ${lineOf(content, token)}`,
      discrepancy: `the spec names \`${token}\`, which does not exist in the repository`,
      rationale: "a criterion or instruction anchored to a path that is neither present nor created cannot be verified as written",
      suggestion: "name the file that exists, or state explicitly that this path is created by the plan",
    });
  }

  for (const reference of input.references ?? []) {
    const path = String(reference ?? "").trim();
    if (!path || path.includes("*")) continue;
    if (existsSync(resolve(input.cwd, path))) continue;
    findings.push({
      id: `L-ref-${findings.length + 1}`,
      severity: "major",
      location: "permitted reference paths",
      discrepancy: `the review was allowed to consult \`${path}\`, which does not exist`,
      rationale: "a reviewer told to consult a missing file either reports a spurious blocker or silently skips the check",
    });
  }

  if (!OBSERVABLE.test(content)) {
    findings.push({
      id: "L-observable",
      severity: "nit",
      location: "acceptance criteria",
      discrepancy: "the document never names a way to observe that it worked (a test, command, metric or log line)",
      rationale: "an unobservable requirement cannot be reviewed, implemented against, or verified afterwards",
      suggestion: "state the command or test that would fail if this were implemented wrongly",
    });
  }

  return findings;
}

/** Render for a reviewer ticket: a prompt to confirm or refute, never a verdict. */
export function renderLintForReviewer(findings: readonly SpecLintFinding[]): string {
  if (!findings.length) return "";
  return [
    "",
    "## Machine-detected defects (confirm or refute)",
    "These were computed from the document and the repository, not judged. Treat them as",
    "questions you must answer: confirm each one you agree with (cite it in your findings)",
    "and say plainly in your summary which ones you checked and found adequate. Do not",
    "invent agreement, and do not treat this list as complete — it cannot see intent.",
    ...findings.map(
      (finding) =>
        `- [${finding.severity}] ${finding.location}: ${finding.discrepancy} (${finding.rationale})`,
    ),
    "",
  ].join("\n");
}
