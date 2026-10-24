/**
 * Context provenance contract for delegated children.
 *
 * A child is launched in exactly one of three context shapes:
 *
 * - `fresh`  — empty array + self-contained ticket (the default; protects the
 *              parent's working memory, see harness-engineering-101 §7).
 * - `digest` — empty array + a zero-LLM VCC brief of the parent branch.
 * - `fork`   — a copy of the parent's active branch + the ticket.
 *
 * Producers live outside this package (the Herdr launch patch writes the record
 * both into the child session file and into the spawn tool result). This module
 * is the single reader/validator, so the companion never guesses a child's shape
 * from `header.parentSession` alone: Pi sets that field for `/fork`, `/clone` and
 * `SessionManager.forkFrom()`, and Herdr sets it for empty `digest` seeds too.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export const SUBAGENT_CONTEXT_TYPE = "subagent-context:v1";

export type ContextMode = "fresh" | "digest" | "fork";

export interface ContextTruncation {
  /** Why the parent branch was cut: only ever a trailing delegated user turn. */
  at: "trailing-user-message";
  droppedEntries: number;
}

export interface ContextProvenance {
  version: 1;
  mode: ContextMode;
  /** Absolute path of the parent session file the child was seeded from. */
  parentSession: string;
  /** Parent branch leaf at seed time, or null when the parent branch was empty. */
  parentLeafId: string | null;
  /** Parent session header id (files are reused, ids are not). */
  parentSessionId: string;
  seededAt: string;
  /** Parent entries written into the child (0 for fresh/digest). */
  seededEntries: number;
  /** Bytes of copied transcript (0 for fresh/digest). */
  seededChars: number;
  /** chars/4 estimate of the inherited context, recorded for cost visibility only. */
  estimatedTokens: number;
  truncated: ContextTruncation | null;
  /** Digest briefs are compiled by pi-vcc (no inference). */
  briefSource?: "vcc";
  /** High-confidence secret patterns replaced in the copy (fork only). */
  secretsRedacted?: number;
}

/**
 * A fork always copies the parent branch in full. There is deliberately no size
 * cap that swaps the copy for a brief: Pi's compaction summarizes an oversized
 * branch on the child's first request but never deletes session entries, so the
 * raw parent transcript stays reachable through parent_recall. Pre-emptively
 * seeding a digest instead would discard detail the child can still summarize
 * and then pull on demand.
 */
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.ceil((Number.isFinite(chars) ? chars : 0) / 4));
}

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Validate an untrusted provenance record. Unknown modes are rejected, not coerced. */
export function provenanceOf(value: unknown): ContextProvenance | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return;
  const mode = v.mode;
  if (mode !== "fresh" && mode !== "digest" && mode !== "fork") return;
  if (typeof v.parentSession !== "string" || !v.parentSession) return;
  if (typeof v.parentSessionId !== "string" || !v.parentSessionId) return;
  if (typeof v.seededAt !== "string" || !Number.isFinite(Date.parse(v.seededAt))) return;
  const rawTruncation = v.truncated as Record<string, unknown> | null | undefined;
  const truncated: ContextTruncation | null =
    rawTruncation && rawTruncation.at === "trailing-user-message"
      ? { at: "trailing-user-message", droppedEntries: nonNegativeInt(rawTruncation.droppedEntries) }
      : null;
  const provenance: ContextProvenance = {
    version: 1,
    mode,
    parentSession: v.parentSession,
    parentLeafId: typeof v.parentLeafId === "string" && v.parentLeafId ? v.parentLeafId : null,
    parentSessionId: v.parentSessionId,
    seededAt: v.seededAt,
    seededEntries: nonNegativeInt(v.seededEntries),
    seededChars: nonNegativeInt(v.seededChars),
    estimatedTokens: nonNegativeInt(v.estimatedTokens),
    truncated,
  };
  if (v.briefSource === "vcc") provenance.briefSource = "vcc";
  if (typeof v.secretsRedacted === "number" && v.secretsRedacted > 0) provenance.secretsRedacted = nonNegativeInt(v.secretsRedacted);
  return provenance;
}

/** Human label for a mode, used by the sidebar, the popup, and the model snapshot. */
export function contextModeLabel(provenance: ContextProvenance): string {
  const inherited = provenance.estimatedTokens >= 1000
    ? `${Math.round(provenance.estimatedTokens / 1000)}k inherited`
    : provenance.estimatedTokens > 0 ? `${provenance.estimatedTokens} tokens inherited` : "no inherited context";
  if (provenance.mode === "fork") {
    return provenance.truncated ? `fork · ${inherited} · trailing turn dropped` : `fork · ${inherited}`;
  }
  if (provenance.mode === "digest") return "digest · parent brief";
  return "fresh";
}

/**
 * One compact line for the child's ticket and the parent's checkpoint snapshot.
 * Data, not instructions: the child is told the shape of what it inherited.
 */
export function provenanceLine(provenance: ContextProvenance): string {
  const facts = [
    `context: ${provenance.mode}`,
    provenance.mode === "fork"
      ? `inherited ${provenance.seededEntries} parent entr${provenance.seededEntries === 1 ? "y" : "ies"} (~${provenance.estimatedTokens} tokens) from ${provenance.parentSession}`
      : `parent brief from ${provenance.parentSession}`,
    provenance.parentLeafId ? `seed leaf: ${provenance.parentLeafId}` : "seed leaf: empty parent branch",
  ];
  if (provenance.truncated) facts.push(`the parent's in-flight turn was not copied (${provenance.truncated.droppedEntries} entry)`);
  if (provenance.secretsRedacted) facts.push(`${provenance.secretsRedacted} secret-shaped value(s) redacted`);
  return facts.join("; ");
}

/** Provenance declared in a session header (producers may also write a branch entry). */
export function provenanceFromHeader(header: unknown): ContextProvenance | undefined {
  if (!header || typeof header !== "object") return;
  return provenanceOf((header as Record<string, unknown>).contextProvenance);
}

/** Latest `subagent-context:v1` entry on a branch. Later entries win, like other append-only state. */
export function provenanceFromBranch(branch: readonly any[] | undefined): ContextProvenance | undefined {
  for (let index = (branch?.length ?? 0) - 1; index >= 0; index--) {
    const entry = branch![index];
    if (entry?.type !== "custom" || entry.customType !== SUBAGENT_CONTEXT_TYPE) continue;
    const provenance = provenanceOf(entry.data);
    if (provenance) return provenance;
  }
}

/**
 * The parent this session was seeded from, when the record is trustworthy:
 * a recorded provenance wins over the header, and a header pointing at the
 * session's own file is ignored rather than producing a self-referential read.
 */
export function parentSessionOf(
  provenance: ContextProvenance | undefined,
  header: unknown,
): string | undefined {
  const headerParent = header && typeof header === "object"
    ? (header as Record<string, unknown>).parentSession
    : undefined;
  const candidate = provenance?.parentSession ?? (typeof headerParent === "string" ? headerParent : undefined);
  if (!candidate) return;
  const self = header && typeof header === "object" ? (header as Record<string, unknown>).id : undefined;
  if (provenance && typeof self === "string" && provenance.parentSessionId === self) return;
  return candidate;
}

/** Compact one-line mode badge for records that may predate provenance. */
export function contextBadge(provenance: ContextProvenance | undefined): string | undefined {
  return provenance ? clip(contextModeLabel(provenance), 80) : undefined;
}

/**
 * The parent's copied entries, ending just before the seed marker.
 *
 * Strict by design: with no marker there is no trustworthy boundary, so this
 * returns `[]` rather than claiming a `fresh` child inherited its own work.
 */
export function seededPrefixEntries(entries: readonly any[] | undefined): any[] {
  const prefix: any[] = [];
  for (const entry of entries ?? []) {
    if (entry?.type === "session") continue;
    if (entry?.type === "custom" && entry.customType === SUBAGENT_CONTEXT_TYPE) return prefix;
    prefix.push(entry);
  }
  return [];
}

export interface ChildContextState {
  /** This process is a Herdr child (`PI_SUBAGENT_SESSION` present). */
  isChild: boolean;
  provenance?: ContextProvenance;
  /** Parent entries present on this child's own branch. */
  inheritedEntries: number;
  /** This child started from a copy of its parent's branch. */
  seeded: boolean;
}

/**
 * Entry ids that belong to this session's seed rather than its own work:
 * the copied parent prefix plus the provenance marker that delimits it.
 *
 * Returns an empty set when no marker exists, because without the marker there
 * is no trustworthy boundary and guessing would strip a session's own history.
 */
export function inheritedEntryIds(entries: readonly any[] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries ?? []) {
    if (entry?.type === "session") continue;
    if (entry?.type === "custom" && entry.customType === SUBAGENT_CONTEXT_TYPE) {
      // The marker is seed metadata, not work this session did.
      if (typeof entry.id === "string") ids.add(entry.id);
      return ids;
    }
    if (typeof entry?.id === "string") ids.add(entry.id);
  }
  return new Set<string>();
}

/**
 * Entries this session produced itself, with the whole seed removed.
 *
 * Used to keep a seeded child from adopting its parent's branch-local policy
 * (Plan mode tool snapshots, deferred tool names) or its parent's registry of
 * delegates: those entries describe the parent's session, and Pi has already
 * restored the child's own loadout from its transcript and `--tools` allowlist.
 * A session with no seed marker is returned unchanged.
 */
export function ownEntries(entries: readonly any[] | undefined): any[] {
  const all = [...(entries ?? [])];
  const inherited = inheritedEntryIds(all);
  if (!inherited.size) return all;
  return all.filter((entry) => !inherited.has(entry?.id));
}

/**
 * The `--session <path>` argument Pi was started with, if any.
 *
 * Herdr launches every child as `pi --session <childSessionFile>` (launch and
 * resume alike), so this argument is what ties the process to the session file
 * the environment claims.
 */
export function argvSessionFile(argv: readonly string[] = process.argv): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--session") {
      const value = argv[index + 1];
      if (value && !value.startsWith("-")) return value;
    } else if (arg.startsWith("--session=")) {
      const value = arg.slice("--session=".length);
      if (value) return value;
    }
  }
}

/** Compare two paths for identity, tolerating symlinks and missing files. */
function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = resolve(value);
    try { return realpathSync(resolved); } catch { return resolved; }
  };
  return normalize(left) === normalize(right);
}

export interface ChildProcessEvidence {
  env?: Record<string, string | undefined>;
  argv?: readonly string[];
  /** This session's own file, when the caller has a context to read it from. */
  sessionFile?: string | null;
}

/**
 * Whether THIS process is a subagent child, not merely whether it inherited the
 * environment of one.
 *
 * `PI_SUBAGENT_SESSION` alone is not evidence. Herdr exports it into the child's
 * pane, and that environment is inherited by anything started from that pane's
 * shell — so a plain `pi` launched there would otherwise believe it is a child,
 * lose its sidebar and `/provider`, and be told to answer the parent instead of
 * the user. Observed exactly that: the env named one file while the session
 * being started was another.
 *
 * A real child is identifiable because Herdr always starts it with
 * `--session <that same file>` — for a fresh launch and for a resume alike — so
 * the file this process was *launched* with must be the file the environment
 * names. That launch argument is the stable evidence, and it is preferred.
 *
 * The session a process is *currently* on is deliberately NOT used to deny
 * childness. A real child legitimately changes its own session file at runtime
 * via `/new` or `/fork`; comparing the current file would flip that child to
 * "not a child" mid-life, which is the false negative that matters most here
 * (a child mistaken for a parent opens user UI in a pane nobody is watching).
 * The current file is therefore only consulted when no launch argument exists,
 * which is exactly the case that catches the stale-environment bug: a plain `pi`
 * has no `--session` and its own fresh session file, so it cannot be the child
 * the inherited environment names.
 *
 * Absence of evidence is treated as absence of childness, never as presence:
 * because Herdr passes `--session` unconditionally, a process with no session
 * file at all (a plain `pi`, or `pi --no-session`) was not launched as a child.
 */
export function isSubagentChildProcess(evidence: ChildProcessEvidence = {}): boolean {
  const env = evidence.env ?? process.env;
  const claimed = env.PI_SUBAGENT_SESSION;
  if (!claimed) return false;
  const launchFile = argvSessionFile(evidence.argv ?? process.argv);
  if (launchFile) return samePath(launchFile, claimed);
  const currentFile = evidence.sessionFile;
  if (!currentFile) return false;
  return samePath(currentFile, claimed);
}

/**
 * Child identity for a session, resolved from that session's own file.
 *
 * The one-liner every extension should use: it needs the context, because the
 * context is what proves which session is actually running.
 */
export function isSubagentChildSession(
  context: { sessionManager?: { getSessionFile?(): string | undefined } } | undefined,
): boolean {
  return isSubagentChildProcess({ sessionFile: context?.sessionManager?.getSessionFile?.() });
}

/**
 * Describe this session's relationship to its seed, from its own branch.
 *
 * `seeded` is derived from the branch, NOT from the environment: a branch that
 * carries a `subagent-context:v1` marker was seeded by construction, so isolation
 * cannot depend on when `PI_SUBAGENT_SESSION` happened to be visible. Callers
 * should therefore branch on `seeded` alone; `isChild` only answers "am I a child
 * process", which is a weaker and later-bound fact.
 *
 * Replaces the old `PI_SUBAGENT_SESSION && header.parentSession` guess, which was
 * true for every Herdr child including `digest` seeds that inherit no entries at
 * all, and for anything Pi created with a `parentSession` linkage.
 */
export function childContextState(
  entries: readonly any[] | undefined,
  header?: any,
  isChild = isSubagentChildProcess(),
): ChildContextState {
  const provenance = provenanceFromBranch(entries);
  // Copied parent entries only: the seed marker is metadata, not a parent entry.
  const inheritedEntries = seededPrefixEntries(entries).length;
  if (provenance) {
    return { isChild, provenance, inheritedEntries, seeded: provenance.mode === "fork" };
  }
  // No marker: a child that still declares a parent linkage predates this
  // contract (legacy fork seed), so isolate it on the conservative signal.
  const legacyLinked = typeof header?.parentSession === "string" && header.parentSession.length > 0;
  return { isChild, provenance, inheritedEntries, seeded: isChild && legacyLinked };
}
