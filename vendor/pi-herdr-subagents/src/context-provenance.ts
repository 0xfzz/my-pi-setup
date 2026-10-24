// Context provenance for seeded children — the producer half of the contract.
//
// The canonical definition and the validating reader live in the workflow
// companion (`pi-workflow-extensions/lib/subagent-context.ts`, type
// `subagent-context:v1`). This package is installed separately, so it cannot
// import that module; the JSON entry shape is the boundary between them and the
// companion re-validates every field on read. Keep the two in sync by shape, and
// bump `version` if the shape changes.

export const SUBAGENT_CONTEXT_TYPE = "subagent-context:v1";

/** fresh = empty array; digest = parent brief; fork = copy of the parent branch. */
export type ContextMode = "fresh" | "digest" | "fork";

export interface ContextProvenance {
  version: 1;
  mode: ContextMode;
  parentSession: string;
  parentLeafId: string | null;
  parentSessionId: string;
  seededAt: string;
  seededEntries: number;
  seededChars: number;
  estimatedTokens: number;
  truncated: { at: "trailing-user-message"; droppedEntries: number } | null;
  briefSource?: "vcc";
  secretsRedacted?: number;
}

/** chars/4 heuristic, matching the companion's `estimateTokens`. Recorded, never enforced. */
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.ceil((Number.isFinite(chars) ? chars : 0) / 4));
}
