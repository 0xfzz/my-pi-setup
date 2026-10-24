/**
 * Child-side view of the parent session — the pull half of the fork contract.
 *
 * A fork child inherits a *snapshot*. This module resolves the live parent file
 * so the child can pull what the snapshot cannot contain: turns the parent wrote
 * after the seed, detail that VCC-compressed, and anything a `fresh`/`digest`
 * child never received at all.
 *
 * Read-only by construction: the parent file is only ever parsed, never opened
 * for writing, so a parent that is still mid-turn cannot be mutated by a child.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_CONTEXT_TYPE,
  parentSessionOf,
  provenanceFromBranch,
  provenanceFromHeader,
  type ContextProvenance,
} from "./subagent-context.ts";

/** Bound for any single pull result, so a child cannot flood its own context. */
export const PARENT_RECALL_MAX_CHARS = 18_000;

/**
 * Request-local brief message for `digest` children.
 *
 * Digest mode promises a parent brief but seeds an empty transcript, so the
 * brief is compiled and attached by the child on demand rather than stored.
 * Injecting it per request (like the checkpoint snapshot) keeps it correct after
 * compaction and avoids appending a copy to the child's transcript.
 */
export const PARENT_BRIEF_TYPE = "parent-brief:v1";

export interface ParentContext {
  /** The child session doing the pulling. */
  childSessionFile: string;
  /** The parent session file being read. */
  sessionFile: string;
  provenance?: ContextProvenance;
  /**
   * Entry ids already present in the child because the seed copied them.
   * Used to answer "what happened since my snapshot" as a delta.
   */
  seededEntryIds: Set<string>;
}

export interface ChildSeed {
  header: any;
  provenance?: ContextProvenance;
  seededEntryIds: Set<string>;
}

/**
 * Read a child's own header, provenance, and the ids it inherited.
 *
 * The seed writes `header, copied entries, provenance entry` in that order, so
 * everything before the provenance entry is exactly the inherited prefix. This
 * holds after the child appends more entries, and is independent of Pi version.
 */
export function readChildSeed(childSessionFile: string): ChildSeed | undefined {
  if (!existsSync(childSessionFile)) return;
  let entries: any[];
  try {
    entries = parseSessionEntries(readFileSync(childSessionFile, "utf8")) as any[];
  } catch {
    return;
  }
  const header = entries.find((entry) => entry?.type === "session");
  const seededEntryIds = new Set<string>();
  for (const entry of entries) {
    if (entry?.type === "session") continue;
    if (entry?.type === "custom" && entry.customType === SUBAGENT_CONTEXT_TYPE) break;
    if (typeof entry?.id === "string") seededEntryIds.add(entry.id);
  }
  const provenance = provenanceFromHeader(header) ?? provenanceFromBranch(entries);
  return { header, provenance, seededEntryIds };
}

/**
 * Resolve the parent a child may pull from, or undefined when there is none.
 *
 * Precedence is deliberate: `PI_SUBAGENT_PARENT` is authoritative because Herdr
 * exports it for every child (including `fresh`, whose session has no
 * `parentSession` header) and it points at the parent *process* that is running
 * now. Recorded provenance is the fallback and additionally describes how this
 * child was seeded.
 *
 * A missing parent file yields undefined rather than an error: the parent may
 * have been moved or deleted, and a child must keep working with its snapshot.
 */
export function resolveParentContext(
  childSessionFile: string | undefined,
  envParent: string | undefined = process.env.PI_SUBAGENT_PARENT,
): ParentContext | undefined {
  if (!childSessionFile) return;
  const seed = readChildSeed(childSessionFile);
  if (!seed) return;
  const recorded = parentSessionOf(seed.provenance, seed.header);
  const candidates = [envParent, recorded].filter((p): p is string => Boolean(p));
  const sessionFile = candidates.find((candidate) => existsSync(candidate));
  if (!sessionFile) return;
  return {
    childSessionFile,
    sessionFile,
    provenance: seed.provenance,
    seededEntryIds: seed.seededEntryIds,
  };
}

/** A fork's snapshot is stale by definition, so default to reporting the delta. */
export function defaultNewerThanSeed(parent: ParentContext): boolean {
  return parent.provenance?.mode === "fork";
}

/** One-line orientation prepended to every pull result. */
export function parentPullHeader(parent: ParentContext, newerThanSeed: boolean): string {
  const mode = parent.provenance?.mode ?? "unknown (no provenance record)";
  const facts = [
    `Parent session: ${parent.sessionFile}`,
    `Your context: ${mode}${parent.provenance?.parentLeafId ? ` · snapshot leaf ${parent.provenance.parentLeafId}` : ""}`,
  ];
  if (newerThanSeed && parent.seededEntryIds.size) {
    facts.push(`Showing only entries the parent added AFTER your ${parent.seededEntryIds.size}-entry snapshot.`);
  } else if (parent.seededEntryIds.size) {
    facts.push(`Including the ${parent.seededEntryIds.size} entries your snapshot already contains.`);
  }
  facts.push("Read-only: this never modifies the parent session.");
  return facts.join("\n");
}

/** Bounded result assembly shared by both pull tools. */
export function boundPull(text: string, maxChars = PARENT_RECALL_MAX_CHARS): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n\n--- Output reached the ${maxChars}-character cap. Narrow the query, use page:, or expand: specific indices. ---`,
    truncated: true,
  };
}
