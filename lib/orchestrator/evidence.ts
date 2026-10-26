/**
 * Evidence that a review can actually check.
 *
 * `orch_review` used to take `evidence: string` — prose the orchestrator wrote
 * about itself. That is self-attestation wearing a lab coat: it cannot tell "the
 * child added the retry budget" from "I edited this file five minutes ago and
 * then described it". With the orchestrator restricted to read-only tools the
 * difference did not matter much; once it can write (capability `full`) it is the
 * whole difference.
 *
 * So evidence is a list of references into the repository, and the review gate
 * verifies them before it records a verdict. A reference is one of:
 *
 *   { kind: "file", path, line? }   a file (and optionally a line) that exists
 *   { kind: "cmd",  cmd, exit }     a command the reviewer ran and what it returned
 *   { kind: "test", name, pass }    a test the reviewer observed
 *
 * This module is deliberately dependency-free and pure apart from the file
 * existence checks, so the review gate and its tests share one implementation.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export type EvidenceRef =
  | { kind: "file"; path: string; line?: number }
  | { kind: "cmd"; cmd: string; exit: number }
  | { kind: "test"; name: string; pass: boolean };

export interface EvidenceCheck {
  ok: boolean;
  /** Human-readable reasons, empty when `ok`. */
  problems: string[];
  checked: number;
  counts: { file: number; cmd: number; test: number };
}

/** Largest file we will count lines in for a `line` bound check. */
const MAX_SCANNED_BYTES = 2 * 1024 * 1024;

export function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "");
}

/**
 * Does `lane` (as authored in a handoff) cover `candidate` (a changed file)?
 *
 * Same semantics as the registry's lane-conflict matcher — exact path, directory
 * prefix, plus the glob forms a spec is likely to use — so "in lane" means the
 * same thing when the handoff is authored and when the diff is judged.
 */
export function laneCoversPath(lane: string, candidate: string): boolean {
  const l = normalizePath(lane);
  const c = normalizePath(candidate);
  if (!l || !c) return false;
  if (!/[*?[\]{}]/.test(l)) {
    if (l === c || c.startsWith(`${l}/`)) return true;
    // A bare filename names that file wherever it lives; a path names a location.
    if (!l.includes("/") && c.split("/").pop() === l) return true;
    return false;
  }
  // One scan, not chained replaces: replacing `**/` with `(?:.*/)?` and then
  // replacing `*` rewrote the marker itself, so `**/*.md` matched nothing.
  let pattern = "";
  for (let index = 0; index < l.length; index++) {
    const char = l[index]!;
    if (char === "*") {
      if (l[index + 1] === "*") {
        if (l[index + 2] === "/") {
          pattern += "(?:.*/)?";
          index += 2;
        } else {
          pattern += ".*";
          index += 1;
        }
      } else {
        pattern += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      pattern += "[^/]";
      continue;
    }
    pattern += "\\^$+.(()|[]{}".includes(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${pattern}$`).test(c) || new RegExp(`^${pattern}/`).test(c);
}

export function pathMatchesAnyLane(laneFiles: readonly string[], candidate: string): boolean {
  return laneFiles.some((lane) => laneCoversPath(lane, candidate));
}

function countLines(file: string): number | null {
  try {
    if (statSync(file).size > MAX_SCANNED_BYTES) return null;
    return readFileSync(file, "utf8").split("\n").length;
  } catch {
    return null;
  }
}

/**
 * Verify every reference. Missing files are problems — a review that cites a path
 * it never opened is exactly the failure this replaces.
 */
export function checkEvidenceRefs(
  refs: readonly EvidenceRef[] | undefined,
  options: { cwd?: string },
): EvidenceCheck {
  // A tool context without `cwd` still has to verify something; the process cwd
  // is where the session runs, so it is the honest default rather than "skip".
  const base = options.cwd || process.cwd();
  const counts = { file: 0, cmd: 0, test: 0 };
  const problems: string[] = [];
  for (const ref of refs ?? []) {
    if (ref?.kind === "file") {
      counts.file++;
      const path = String(ref.path ?? "").trim();
      if (!path) {
        problems.push("a file reference has an empty path");
        continue;
      }
      const absolute = resolve(base, path);
      if (!existsSync(absolute)) {
        problems.push(`file reference does not exist: ${path}`);
        continue;
      }
      if (ref.line !== undefined) {
        if (!Number.isInteger(ref.line) || ref.line < 1) {
          problems.push(`file reference has an invalid line: ${path}:${ref.line}`);
          continue;
        }
        const lines = countLines(absolute);
        if (lines !== null && ref.line > lines) {
          problems.push(`file reference points past the end of ${path} (line ${ref.line} of ${lines})`);
        }
      }
      continue;
    }
    if (ref?.kind === "cmd") {
      counts.cmd++;
      if (!String(ref.cmd ?? "").trim()) problems.push("a command reference has an empty command");
      else if (!Number.isInteger(ref.exit)) problems.push(`command reference has no exit code: ${ref.cmd}`);
      continue;
    }
    if (ref?.kind === "test") {
      counts.test++;
      if (!String(ref.name ?? "").trim()) problems.push("a test reference has an empty name");
      else if (typeof ref.pass !== "boolean") problems.push(`test reference has no result: ${ref.name}`);
      continue;
    }
    problems.push(`unrecognized evidence reference: ${JSON.stringify(ref)}`);
  }
  const checked = counts.file + counts.cmd + counts.test;
  return { ok: problems.length === 0, problems, checked, counts };
}

/** Render refs for the review artifact, so the saved review quotes what was checked. */
export function renderEvidence(refs: readonly EvidenceRef[] | undefined): string {
  if (!refs?.length) return "(no references — prose only)";
  return refs
    .map((ref) => {
      if (ref.kind === "file") return `- file: ${ref.path}${ref.line ? `:${ref.line}` : ""}`;
      if (ref.kind === "cmd") return `- cmd: \`${ref.cmd}\` → exit ${ref.exit}`;
      return `- test: ${ref.name} → ${ref.pass ? "pass" : "fail"}`;
    })
    .join("\n");
}
