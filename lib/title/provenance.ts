/**
 * Provenance for generated session titles. Pure: branch in, record out.
 *
 * A generated title is written to the session name, and Pi reports that name
 * change like any other rename. The record below is appended to the branch
 * before the name is applied, so anyone reading the branch can tell a name the
 * title generator wrote from one a person chose.
 */

export const TITLE_RECORD_ENTRY = "workflow-title:v1";

export interface TitleRecord {
  v: 1;
  ownerSessionId: string;
  title: string;
  /** `auto` from the automatic path, `manual` from `/title now` or the web action. */
  source: "auto" | "manual";
  /** 1-based count of generations recorded for this session. */
  generation: number;
  /** `provider/id` of the model that produced the title. */
  model?: string;
  usage?: { input: number; output: number };
}

/** The newest title record this session wrote on the branch, if any. */
export function latestTitleRecord(branch: readonly any[], ownerSessionId: string): TitleRecord | undefined {
  let latest: TitleRecord | undefined;
  for (const entry of branch) {
    if (entry?.type !== "custom" || entry.customType !== TITLE_RECORD_ENTRY) continue;
    const data = entry.data;
    if (data?.v !== 1 || data.ownerSessionId !== ownerSessionId) continue;
    if (typeof data.title !== "string" || typeof data.generation !== "number") continue;
    if (data.source !== "auto" && data.source !== "manual") continue;
    latest = data as TitleRecord;
  }
  return latest;
}

/** Number of generations this session has recorded, the basis for the cap. */
export function generationCount(branch: readonly any[], ownerSessionId: string): number {
  return latestTitleRecord(branch, ownerSessionId)?.generation ?? 0;
}

/**
 * True when `name` is the title the generator last wrote. A name that differs
 * from the latest record was set by a person (or another extension) and is not
 * generated, even if the generator wrote something earlier.
 */
export function isGeneratedName(branch: readonly any[], ownerSessionId: string, name: string | undefined): boolean {
  const record = latestTitleRecord(branch, ownerSessionId);
  return Boolean(record && name !== undefined && name === record.title);
}

/** A title try that did not land: it still spends the automatic cap. */
export const TITLE_ATTEMPT_ENTRY = "workflow-title-attempt:v1";

export interface TitleAttempt {
  v: 1;
  ownerSessionId: string;
  source: "auto" | "manual";
  kind: "provisional" | "refine" | "manual";
  /** `kept`: a refinement answered KEEP, so no name was written but the pass is spent. */
  outcome: "failed" | "superseded" | "kept";
  reason: string;
}

/** Every successful generation recorded for this session, automatic or manual. */
export function successCount(branch: readonly any[], ownerSessionId: string): number {
  return branch.filter((entry) => entry?.type === "custom"
    && entry.customType === TITLE_RECORD_ENTRY
    && entry.data?.ownerSessionId === ownerSessionId).length;
}

/**
 * Automatic tries so far: automatic successes plus automatic tries that failed
 * or were superseded. Manual regenerates are not counted against the cap.
 */
export function automaticAttempts(branch: readonly any[], ownerSessionId: string): number {
  return branch.filter((entry) => {
    if (entry?.type !== "custom" || entry.data?.ownerSessionId !== ownerSessionId) return false;
    if (entry.customType === TITLE_RECORD_ENTRY) return entry.data?.source === "auto";
    if (entry.customType === TITLE_ATTEMPT_ENTRY) return entry.data?.source === "auto";
    return false;
  }).length;
}

/** A refinement pass has run, whether it rewrote the name or kept it. */
export function refinementTried(branch: readonly any[], ownerSessionId: string): boolean {
  return branch.some((entry) => entry?.type === "custom"
    && entry.customType === TITLE_ATTEMPT_ENTRY
    && entry.data?.ownerSessionId === ownerSessionId
    && entry.data?.kind === "refine");
}
