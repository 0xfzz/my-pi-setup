/**
 * review-artifact-scope.ts — a reviewer's evidence is an artifact, and only its own.
 *
 * The artifact tool is the store; this is the authorization layer around it. A
 * spec reviewer may write only `review:<runId>:<lens>`; a research child only
 * `orch-research:<scope>`. The scope is derived from the environment the launcher
 * already writes, never chosen by the caller, and an edit/recall must resolve to
 * an artifact with that same recorded scope.
 *
 * Unknown ids and foreign ids are refused with the *same* message, so the guard
 * cannot be used as an existence oracle for another run's artifacts.
 */
import { sanitizeArtifactId } from "../artifact-state.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface ArtifactScopeRule {
  scope: string;
  idPrefix: string;
  allowedTypes: readonly string[];
  maxChars: number;
}

export interface ArtifactRef {
  id?: string;
  scope?: string;
  type?: string;
}

const EVIDENCE_MAX_CHARS = 60_000;
const EVIDENCE_TYPES = ["scratchpad", "review"] as const;

const ARTIFACT_TOOLS = new Set(["artifact_save", "artifact_edit", "artifact_recall"]);

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The scope this session may write into, or `undefined` for an ordinary child
 * (which has no narrowed artifact surface at all).
 */
export function artifactScopeFor(env: Env): ArtifactScopeRule | undefined {
  const runId = clean(env.PI_SUBAGENT_REVIEW_RUN);
  // A document reviewer is scoped by lens, a chunk reviewer by its chunk id. They
  // are the same boundary: evidence for THIS assignment, never a sibling's.
  const assignment = clean(env.PI_SUBAGENT_REVIEW_LENS) ?? clean(env.PI_SUBAGENT_REVIEW_CHUNK);
  if (runId && assignment) {
    return {
      scope: `review:${runId}:${assignment}`,
      idPrefix: `review-${runId}-${assignment}-`,
      allowedTypes: EVIDENCE_TYPES,
      maxChars: EVIDENCE_MAX_CHARS,
    };
  }
  const scope = clean(env.PI_SUBAGENT_SCOPE);
  if (scope) {
    return {
      scope: `orch-research:${scope}`,
      idPrefix: `research-${scope}-`,
      allowedTypes: EVIDENCE_TYPES,
      maxChars: EVIDENCE_MAX_CHARS,
    };
  }
  return undefined;
}

export function isArtifactScopeTool(name: string): boolean {
  return ARTIFACT_TOOLS.has(name);
}

/**
 * The refusal, or `undefined` when the call is inside the session's scope.
 *
 * `lookup` resolves an existing artifact by id (the extension reads the branch);
 * tests pass a plain map function.
 */
export function artifactGuardProblem(
  name: string,
  input: any,
  options: { rule: ArtifactScopeRule; lookup?: (id: string) => ArtifactRef | undefined },
): string | undefined {
  if (!isArtifactScopeTool(name)) return undefined;
  const { rule } = options;

  if (name === "artifact_save") {
    const scope = String(input?.scope ?? "").trim();
    if (scope !== rule.scope) {
      return `artifact_save: scope must be "${rule.scope}" for this session (got ${scope ? `"${scope}"` : "none"}). `
        + `Your evidence is scoped to this review; it is not a user artifact.`;
    }
    const type = String(input?.type ?? "").trim();
    if (!rule.allowedTypes.includes(type)) {
      return `artifact_save: type must be one of ${rule.allowedTypes.join(", ")} (got "${type || "none"}").`;
    }
    const id = sanitizeArtifactId(String(input?.id ?? "").trim());
    if (!id || !id.startsWith(rule.idPrefix) || id.length > 64) {
      return `artifact_save: id must start with "${rule.idPrefix}" and be at most 64 characters.`;
    }
    const content = String(input?.content ?? "");
    if (content.length > rule.maxChars) {
      return `artifact_save: content is ${content.length} characters; the limit is ${rule.maxChars}.`;
    }
    return undefined;
  }

  // `sanitizeArtifactId("")` returns a fallback id, so check the raw input first.
  const rawId = String(input?.id ?? "").trim();
  if (!rawId) {
    return `${name}: pass an explicit artifact id from this session's scope (discovery is not allowed for a reviewer).`;
  }
  const id = sanitizeArtifactId(rawId);
  const found = options.lookup?.(id);
  // Foreign and unknown ids get the same answer: no existence oracle.
  if (!found || found.scope !== rule.scope) {
    return `${name}: that artifact is not in this session's scope (only your own evidence is visible).`;
  }
  return undefined;
}
