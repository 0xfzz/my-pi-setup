/**
 * verdict-check.ts — bind an acceptance verdict to the handoff it judges.
 *
 * `agent_accept_result` used to take free-form evidence strings: "ran the tests"
 * was as good as a file path, and no criterion had to be mentioned. A verdict that
 * names no criterion cannot be "the result matches the handoff". So:
 *
 *   1. Every criterion frozen in the handoff must receive its own verdict
 *      (`met` true/false plus evidence) — matched by 1-based index or exact text.
 *   2. A criterion that is not met cannot be accepted; that is `changes-requested`.
 *   3. Evidence is checked where it can be: a path must exist (and stay inside the
 *      working directory), an artifact id must exist. A reference that cannot be
 *      checked offline (a command, a URL, a measurement) is recorded as ATTESTED and
 *      is never mistaken for verified. Every criterion needs at least one verified
 *      reference unless the parent overrides `evidence-unverifiable`.
 *
 * The checks are domain-neutral: a research child's evidence is its report
 * artifact and source URLs, a coding child's is files, and both go through the
 * same gate.
 */
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export interface CriterionVerdict {
  /** 1-based index into the frozen criteria, or the criterion's exact text. */
  criterion: string;
  met: boolean;
  evidence: string[];
}

export type EvidenceKind = "verified" | "attested" | "failed";

export interface EvidenceCheck {
  ref: string;
  kind: EvidenceKind;
  why: string;
}

const ARTIFACT_ID = /^(?:artifact:)?((?:report|handoff|rework|plan|spec|notes?|findings?|summary)-[\w.-]+|[\w.-]+@v\d+)$/i;
const URL = /^https?:\/\//i;
const COMMAND = /^(?:cmd:|ran |run |\$ |npm |node |pnpm |yarn |cargo |go |pytest |git |make )/i;

/** `src/a.ts:12`, `src/a.ts#L12`, `./a.md` → the path part; undefined if it is not path-shaped. */
export function pathOfRef(ref: string): string | undefined {
  const text = ref.trim().replace(/^file:/i, "").replace(/[`'"]/g, "");
  const match = /^((?:\.{0,2}\/)?[\w@.+-]+(?:\/[\w@.+-]+)*\.[A-Za-z0-9]{1,8}|(?:\.{0,2}\/)?[\w@.+-]+(?:\/[\w@.+-]+)+\/?)(?::\d+(?::\d+)?|#L\d+)?(?:\s.*)?$/.exec(text);
  return match?.[1];
}

export function checkEvidence(
  refs: readonly string[],
  options: { cwd: string; artifactExists: (id: string) => boolean },
): EvidenceCheck[] {
  return refs.map((raw) => {
    const ref = raw.trim();
    if (!ref) return { ref, kind: "failed", why: "empty reference" };
    if (URL.test(ref)) return { ref, kind: "attested", why: "a URL cannot be fetched during acceptance; cite the artifact that captured it to make it verifiable" };
    if (COMMAND.test(ref)) return { ref, kind: "attested", why: "a command's outcome is the parent's own observation" };

    const artifact = ARTIFACT_ID.exec(ref);
    if (artifact) {
      const id = artifact[1]!.replace(/@v\d+$/i, "");
      return options.artifactExists(id)
        ? { ref, kind: "verified", why: `artifact ${id} exists` }
        : { ref, kind: "failed", why: `artifact ${id} does not exist` };
    }

    const path = pathOfRef(ref);
    if (path) {
      const absolute = resolve(options.cwd, path);
      const rel = relative(options.cwd, absolute);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        return { ref, kind: "failed", why: `${path} is outside the working directory` };
      }
      return existsSync(absolute)
        ? { ref, kind: "verified", why: `${path} exists` }
        : { ref, kind: "failed", why: `${path} does not exist` };
    }
    return { ref, kind: "attested", why: "free text; nothing to check mechanically" };
  });
}

export interface VerdictProblem {
  code: "criteria-uncovered" | "criterion-unmet" | "evidence-failed" | "evidence-unverifiable" | "criterion-unknown";
  detail: string;
}

/** Resolve a verdict's `criterion` to a 0-based index into the frozen list. */
function resolveCriterion(frozen: readonly string[], key: string): number {
  const trimmed = String(key ?? "").trim();
  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed) - 1;
    return index >= 0 && index < frozen.length ? index : -1;
  }
  const exact = frozen.findIndex((criterion) => criterion.trim() === trimmed);
  return exact;
}

/**
 * Judge a set of per-criterion verdicts against the frozen criteria.
 *
 * Returns every problem rather than the first, so the parent fixes the whole
 * verdict in one round instead of discovering refusals one at a time.
 */
export function checkVerdicts(input: {
  frozen: readonly string[];
  verdicts: readonly CriterionVerdict[];
  cwd: string;
  artifactExists: (id: string) => boolean;
  overrides?: readonly string[];
}): { problems: VerdictProblem[]; checks: Array<{ index: number; criterion: string; met: boolean; evidence: EvidenceCheck[] }> } {
  const problems: VerdictProblem[] = [];
  const named = new Set((input.overrides ?? []).map((code) => code.trim().toLowerCase()));
  const seen = new Set<number>();
  const checks: Array<{ index: number; criterion: string; met: boolean; evidence: EvidenceCheck[] }> = [];

  for (const verdict of input.verdicts) {
    const index = resolveCriterion(input.frozen, verdict.criterion);
    if (index < 0) {
      problems.push({
        code: "criterion-unknown",
        detail: `verdict names "${String(verdict.criterion).slice(0, 80)}", which is not one of the ${input.frozen.length} frozen criteria (use its 1-based number or exact text)`,
      });
      continue;
    }
    seen.add(index);
    const criterion = input.frozen[index]!;
    const evidence = checkEvidence(verdict.evidence ?? [], { cwd: input.cwd, artifactExists: input.artifactExists });
    checks.push({ index: index + 1, criterion, met: verdict.met, evidence });

    if (!verdict.met) {
      problems.push({ code: "criterion-unmet", detail: `criterion ${index + 1} is not met ("${criterion.slice(0, 100)}") — a result that misses its handoff is changes-requested, not accepted` });
      continue;
    }
    for (const check of evidence.filter((e) => e.kind === "failed")) {
      problems.push({ code: "evidence-failed", detail: `criterion ${index + 1}: "${check.ref}" — ${check.why}` });
    }
    if (!evidence.some((e) => e.kind === "verified") && !named.has("evidence-unverifiable")) {
      problems.push({
        code: "evidence-unverifiable",
        detail: `criterion ${index + 1} has no VERIFIED reference (${evidence.length ? "all attested" : "none given"}). Cite a file, or the report artifact; or override \`evidence-unverifiable\` and say why in summary`,
      });
    }
  }

  input.frozen.forEach((criterion, index) => {
    if (!seen.has(index)) {
      problems.push({ code: "criteria-uncovered", detail: `criterion ${index + 1} has no verdict: "${criterion.slice(0, 100)}"` });
    }
  });
  return { problems, checks };
}
