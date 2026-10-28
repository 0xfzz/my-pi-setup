/**
 * handoff-document.ts — read the worker-facing spec back into fields.
 *
 * A spec review judges the DOCUMENT a worker will read (`renderHandoffForChild`),
 * so a fix must edit that document. Editing the text without being able to read
 * it back would fork the record and the artifact: the worker reads one, the spawn
 * gate hashes the other, and the audit trail claims a revision nobody applied.
 *
 * The parser is strict on purpose. It accepts only this format, requires the
 * sections a work unit cannot do without (goal, lane, acceptance criteria, report
 * shape), and refuses duplicates. A fix that would corrupt the document is
 * refused before any write, not discovered by the worker.
 *
 * The structural guard lives in `wave.ts` (`structuralChanges`); this module only
 * turns bytes into the fields that guard compares.
 */
import type { HandoffContractFields } from "./wave.ts";
import type { HandoffRecord } from "./handoff.ts";

export interface ParsedHandoffDocument {
  scope: string;
  goal: string;
  vision?: string;
  outOfLaneFiles: string[];
  interfaces: string[];
  guidance?: string;
  laneFiles: string[];
  acceptanceCriteria: string[];
  reportShape: string;
}

export type HandoffParseResult =
  | { ok: true; doc: ParsedHandoffDocument }
  | { ok: false; problems: string[] };

/** Heading prefixes the renderer emits. Order in the document is not significant. */
const HEADINGS = {
  goal: "Goal",
  vision: "Project vision",
  outOfLane: "Do NOT touch",
  interfaces: "Interfaces you must conform to",
  guidance: "Notes from the orchestrator",
  lane: "Files you own",
  criteria: "Acceptance criteria",
  reportShape: "What to report back",
} as const;

type SectionKey = keyof typeof HEADINGS;

function splitSections(lines: string[]): { scope: string; sections: Map<SectionKey, string[]>; problems: string[] } {
  const problems: string[] = [];
  const sections = new Map<SectionKey, string[]>();
  let scope = "";
  let current: SectionKey | undefined;

  for (const line of lines) {
    const h1 = /^#\s+Work handoff:\s*(.+?)\s*$/.exec(line);
    if (h1) {
      if (scope) problems.push("the document declares more than one work-handoff title");
      scope = h1[1]!;
      current = undefined;
      continue;
    }
    if (line.startsWith("# ")) {
      problems.push(`unsupported top-level heading: ${line.trim()}`);
      current = undefined;
      continue;
    }
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      const title = h2[1]!;
      const key = (Object.keys(HEADINGS) as SectionKey[]).find((candidate) =>
        title.toLowerCase().startsWith(HEADINGS[candidate].toLowerCase()),
      );
      if (!key) {
        // Unknown sections are ignored rather than fatal: a project may add its
        // own prose, and refusing that would make every local convention a bug.
        current = undefined;
        continue;
      }
      if (sections.has(key)) problems.push(`the document has two "${HEADINGS[key]}" sections`);
      sections.set(key, []);
      current = key;
      continue;
    }
    if (current) sections.get(current)!.push(line);
  }

  if (!scope) problems.push("the document has no `# Work handoff: <scope>` title");
  return { scope, sections, problems };
}

const body = (lines: string[] | undefined): string => (lines ?? []).join("\n").trim();

/** Bullet list of backticked paths: `- \`src/a.ts\``. Prose lead-ins are ignored. */
function pathBullets(key: SectionKey, lines: string[] | undefined, problems: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines ?? []) {
    const line = raw.trim();
    if (!line) continue;
    // The renderer (and a project's own prose) may put a sentence above the
    // list. Only bullet lines are the list.
    if (!/^[-*]\s+/.test(line)) continue;
    const match = /^[-*]\s+`([^`]+)`\s*$/.exec(line);
    if (!match) {
      problems.push(`${HEADINGS[key]}: expected "- \`path\`", got: ${line.slice(0, 80)}`);
      continue;
    }
    out.push(match[1]!.trim());
  }
  return out;
}

/** Numbered list: `1. ...`; continuation lines belong to the previous item. */
function numbered(lines: string[] | undefined, problems: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines ?? []) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^(\d+)\.\s+(.*)$/.exec(line);
    if (match) {
      out.push(match[2]!.trim());
    } else if (out.length) {
      out[out.length - 1] = `${out[out.length - 1]} ${line}`.trim();
    } else {
      problems.push(`Acceptance criteria: expected "1. ...", got: ${line.slice(0, 80)}`);
    }
  }
  return out;
}

/** Plain bullets, for interfaces: `- RetryPolicy.bound: number`. Prose is ignored. */
function plainBullets(lines: string[] | undefined): string[] {
  return (lines ?? [])
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

/**
 * Parse the exact document the renderer produces.
 *
 * Required: scope, goal, a non-empty lane, at least one acceptance criterion, and
 * a report shape. Those are the parts the spawn gate and QA rely on; a handoff
 * missing one was never a handoff.
 */
export function parseHandoffDocument(text: string): HandoffParseResult {
  const { scope, sections, problems } = splitSections(String(text ?? "").split("\n"));
  if (!scope && problems.length) return { ok: false, problems };

  const goal = body(sections.get("goal"));
  if (!goal) problems.push("the Goal section is empty");

  const laneFiles = pathBullets("lane", sections.get("lane"), problems);
  if (!laneFiles.length) problems.push("the lane section names no files");

  const acceptanceCriteria = numbered(sections.get("criteria"), problems);
  if (!acceptanceCriteria.length) problems.push("the acceptance criteria section names no criteria");

  const reportShape = body(sections.get("reportShape"));
  if (!reportShape) problems.push("the report-shape section is empty");

  const vision = body(sections.get("vision"));
  const guidance = body(sections.get("guidance"));

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    doc: {
      scope,
      goal,
      ...(vision ? { vision } : {}),
      outOfLaneFiles: pathBullets("outOfLane", sections.get("outOfLane"), problems),
      interfaces: plainBullets(sections.get("interfaces")),
      ...(guidance ? { guidance } : {}),
      laneFiles,
      acceptanceCriteria,
      reportShape,
    },
  };
}

/** The fields a fix may not change, as the guard compares them. */
export function contractFieldsOf(doc: ParsedHandoffDocument): HandoffContractFields {
  return {
    scope: doc.scope,
    acceptanceCriteria: doc.acceptanceCriteria,
    laneFiles: doc.laneFiles,
    outOfLaneFiles: doc.outOfLaneFiles,
    interfaces: doc.interfaces,
    reportShape: doc.reportShape,
    ...(doc.vision ? { vision: doc.vision } : {}),
  };
}

export function contractFieldsOfRecord(record: HandoffRecord): HandoffContractFields {
  return {
    scope: record.scope,
    acceptanceCriteria: record.acceptanceCriteria,
    laneFiles: record.laneFiles,
    outOfLaneFiles: record.outOfLaneFiles ?? [],
    interfaces: record.interfaces ?? [],
    reportShape: record.reportShape ?? "",
    ...(record.vision ? { vision: record.vision } : {}),
  };
}

/**
 * Merge the parsed prose back into the record.
 *
 * Only fields that live in the document are replaced. `dependsOn`,
 * `verifyCommand`, `designRef` and the scope are record-only (they are not
 * rendered), so a text patch cannot silently rewrite them.
 */
export function mergeHandoffDocument(record: HandoffRecord, doc: ParsedHandoffDocument): HandoffRecord {
  const next: HandoffRecord = {
    ...record,
    goal: doc.goal,
    laneFiles: [...doc.laneFiles],
    acceptanceCriteria: [...doc.acceptanceCriteria],
    reportShape: doc.reportShape,
    ...(doc.outOfLaneFiles.length ? { outOfLaneFiles: [...doc.outOfLaneFiles] } : {}),
    ...(doc.interfaces.length ? { interfaces: [...doc.interfaces] } : {}),
    ...(doc.vision ? { vision: doc.vision } : {}),
    ...(doc.guidance ? { guidance: doc.guidance } : {}),
  };
  for (const key of ["outOfLaneFiles", "interfaces", "vision", "guidance"] as const) {
    if (!doc[`${key}` as keyof ParsedHandoffDocument]) delete (next as any)[key];
  }
  return next;
}
