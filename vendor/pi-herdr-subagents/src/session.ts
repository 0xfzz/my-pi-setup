// Session seeding (fork/lineage modes) and summary extraction.
//
// Verbatim port of pi-interactive-subagents (MIT, HazAT)
// pi-extension/subagents/session.ts @ fix/launch-verify-retry. Transport-independent
// and battle-tested; the entry shapes are the version-3 session file format the
// child pi must accept — do not refactor. Summary extraction is crash-safe because
// the child session file is written incrementally.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_CONTEXT_TYPE,
  estimateTokens,
  type ContextProvenance,
} from "./context-provenance.ts";

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string | null;
  [key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
}

/** digest = parent brief only; fork = full copy of the parent's active branch. */
export type SeededSubagentSessionMode = "digest" | "fork";

/**
 * High-confidence secret shapes. This is a seatbelt for the new copy on disk,
 * not a data-loss-prevention policy: semantic secrets are inherited verbatim.
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{20,}/g,
];

/** Replace high-confidence secrets with a marker. Returns how many were replaced. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, () => {
      count++;
      return "[REDACTED by fork seed]";
    });
  }
  return { text: result, count };
}

/**
 * Reconstruct the parent's ACTIVE branch from parsed file entries.
 *
 * Walks `parentId` back from the active leaf, which is what Pi's own `getBranch()`
 * does. If `parentLeafId` is specified, starts traversal from that entry (or
 * returns an empty branch if null). If `parentLeafId` is not found, throws an
 * invalid boundary error. If omitted, falls back to the file order disk tail.
 *
 * Read-only by construction: the parent file is never opened for writing, so a
 * live parent that is still appending cannot be initialized or rewritten.
 */
export function readParentBranch(
  parentSessionFile: string,
  parentLeafId?: string | null,
): {
  entries: SessionEntry[];
  parentSessionId: string;
  parentCwd: string;
} {
  const fileEntries = parseSessionEntries(readFileSync(parentSessionFile, "utf8")) as any[];
  const header = fileEntries.find((entry) => entry?.type === "session");
  const parentSessionId = typeof header?.id === "string" ? header.id : "";
  const parentCwd = typeof header?.cwd === "string" ? header.cwd : process.cwd();

  const byId = new Map<string, SessionEntry>();
  for (const entry of fileEntries) {
    if (entry?.type === "session") continue;
    if (typeof entry?.id === "string") byId.set(entry.id, entry as SessionEntry);
  }

  if (parentLeafId === null) {
    return { entries: [], parentSessionId, parentCwd };
  }

  let cursor: SessionEntry | undefined;
  if (typeof parentLeafId === "string") {
    cursor = byId.get(parentLeafId);
    if (!cursor) {
      throw new Error(`Invalid boundary: parent leaf "${parentLeafId}" not found in session`);
    }
  } else {
    // Pi treats the last entry in file order as the leaf when not explicitly provided.
    cursor = [...byId.values()].at(-1);
  }

  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    path.push(cursor);
    const parentId = (cursor as any).parentId;
    cursor = typeof parentId === "string" ? byId.get(parentId) : undefined;
  }
  path.reverse();
  return { entries: path, parentSessionId, parentCwd };
}

/**
 * Ensure any tool calls in assistant messages have matching tool results so
 * that downstream providers (Anthropic, OpenAI, Bedrock, etc.) do not reject
 * incomplete turns or unclosed tool calls, while preserving the assistant's
 * analysis and findings.
 */
export function closeOutstandingToolCalls(
  entries: SessionEntry[],
  timestamp: string,
): SessionEntry[] {
  const resolvedToolCallIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "message") {
      const msg = (entry as any).message;
      if (msg?.role === "toolResult" && typeof msg.toolCallId === "string") {
        resolvedToolCallIds.add(msg.toolCallId);
      }
    }
  }

  const result: SessionEntry[] = [];
  let currentParentId: string | null = null;

  for (const entry of entries) {
    // The input is already one active path. Rechain every subsequent entry to
    // the output leaf: one or several inserted results must remain reachable
    // when a real parent result or metadata entry follows them.
    const clonedEntry: SessionEntry = result.length > 0 && entry.parentId !== currentParentId
      ? { ...entry, parentId: currentParentId }
      : entry;

    result.push(clonedEntry);
    currentParentId = clonedEntry.id;

    if (clonedEntry.type === "message") {
      const msg = (clonedEntry as any).message;
      if (msg?.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (
            block?.type === "toolCall" &&
            typeof block.id === "string" &&
            !resolvedToolCallIds.has(block.id)
          ) {
            const syntheticId = randomBytes(4).toString("hex");
            const syntheticResult: SessionEntry = {
              type: "message",
              id: syntheticId,
              parentId: currentParentId,
              timestamp,
              message: {
                role: "toolResult",
                toolCallId: block.id,
                toolName: block.name ?? "unknown",
                content: [{ type: "text", text: "[Inherited parent tool call had no result at fork time; not executed by this child.]" }],
                isError: true,
                timestamp: Date.parse(timestamp),
              },
            } as any;
            result.push(syntheticResult);
            resolvedToolCallIds.add(block.id);
            currentParentId = syntheticId;
          }
        }
      }
    }
  }

  return result;
}

/**
 * Trailing user messages are retained so the child inherits the user's latest
 * prompt, findings, and instructions.
 */
export function dropTrailingParentTurn(entries: SessionEntry[]): {
  entries: SessionEntry[];
  droppedEntries: number;
} {
  return { entries, droppedEntries: 0 };
}

/**
 * Seed a child session file and return the provenance record describing it.
 *
 * Written layout: header, copied parent entries, then one `subagent-context:v1`
 * entry parented to the last copied entry so it sits on the child's active
 * branch and reaches the model through the companion's context snapshot.
 */
export function seedSubagentSessionFile(params: {
  mode: SeededSubagentSessionMode;
  parentSessionFile: string;
  childSessionFile: string;
  childCwd: string;
  parentLeafId?: string | null;
}): ContextProvenance {
  const header = {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: params.childCwd,
    parentSession: params.parentSessionFile,
  };

  const parent = readParentBranch(params.parentSessionFile, params.parentLeafId);
  const rawParentLeafId = typeof params.parentLeafId !== "undefined"
    ? params.parentLeafId
    : ((parent.entries[parent.entries.length - 1] as any)?.id ?? null);

  const kept = params.mode === "fork"
    ? { entries: closeOutstandingToolCalls(parent.entries, header.timestamp), droppedEntries: 0 }
    : { entries: [] as SessionEntry[], droppedEntries: 0 };

  let secretsRedacted = 0;
  const contentLines = kept.entries.map((entry) => {
    const raw = JSON.stringify(entry);
    const redacted = redactSecrets(raw);
    secretsRedacted += redacted.count;
    return redacted.text;
  });
  const seededChars = contentLines.reduce((total, line) => total + line.length + 1, 0);

  const provenance: ContextProvenance = {
    version: 1,
    mode: params.mode,
    parentSession: params.parentSessionFile,
    parentLeafId: rawParentLeafId,
    parentSessionId: parent.parentSessionId,
    seededAt: header.timestamp,
    seededEntries: params.mode === "fork" ? kept.entries.length : 0,
    seededChars: params.mode === "fork" ? seededChars : 0,
    estimatedTokens: params.mode === "fork" ? estimateTokens(seededChars) : 0,
    truncated: null,
  };
  if (params.mode === "digest") provenance.briefSource = "vcc";
  if (secretsRedacted) provenance.secretsRedacted = secretsRedacted;

  const lastCopiedId = (kept.entries[kept.entries.length - 1] as any)?.id ?? null;
  const provenanceEntry = {
    type: "custom",
    id: randomBytes(4).toString("hex"),
    parentId: lastCopiedId,
    timestamp: header.timestamp,
    customType: SUBAGENT_CONTEXT_TYPE,
    data: provenance,
  };

  const lines = [JSON.stringify(header), ...contentLines, JSON.stringify(provenanceEntry)];
  mkdirSync(dirname(params.childSessionFile), { recursive: true });
  writeFileSync(params.childSessionFile, lines.join("\n") + "\n", "utf8");
  return provenance;
}

/**
 * Name prefix for stamped child sessions. Read back by `lib/session-stamp.ts`.
 */
export const CHILD_SESSION_NAME_PREFIX = "child";

/**
 * Birth stamp for a child session that is NOT seeded from the parent transcript.
 *
 * A child session is otherwise an ordinary session in the same per-project
 * directory, so `pi --resume` lists it beside real conversations with nothing to
 * tell them apart. Two facts fix that, and this writes both:
 *
 *   - `parentSession` in the header — what the picker groups on.
 *   - a `session_info` name — exactly what the picker displays (and what the
 *     rename key writes), so the row reads `child · <agent> · <task>`.
 *
 * Refuses to touch an existing file: `pi --session <file>` resumes what is there,
 * and clobbering a session to label it would be the worst trade in the system.
 */
export function stampNewChildSessionFile(params: {
  sessionFile: string;
  sessionId: string;
  childCwd: string;
  parentSessionFile: string;
  label?: string;
}): boolean {
  if (existsSync(params.sessionFile)) return false;
  const timestamp = new Date().toISOString();
  const label = (params.label ?? "").replace(/\s+/g, " ").trim().slice(0, 64);
  const header = {
    type: "session",
    version: 3,
    id: params.sessionId,
    timestamp,
    cwd: params.childCwd,
    parentSession: params.parentSessionFile,
  };
  const info = {
    type: "session_info",
    id: randomBytes(4).toString("hex"),
    parentId: null,
    timestamp,
    name: label ? `${CHILD_SESSION_NAME_PREFIX} · ${label}` : CHILD_SESSION_NAME_PREFIX,
  };
  mkdirSync(dirname(params.sessionFile), { recursive: true });
  writeFileSync(params.sessionFile, `${[header, info].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return true;
}

function readEntries(sessionFile: string): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Return the id of the last entry in the session file (current branch point / leaf).
 */
export function getLeafId(sessionFile: string): string | null {
  const entries = readEntries(sessionFile);
  return entries.length > 0 ? entries[entries.length - 1].id : null;
}

/**
 * Return the canonical pi session UUID from the session file's header line.
 *
 * The filename's id segment is not always the session UUID (it may be a hash),
 * so the header is the reliable source. Used to offer a short, copy-pasteable
 * `pi --session <uuid>` instead of a ~135-char absolute path that hard-wraps in
 * the result widget. Best-effort: returns null for a missing/empty/mangled file.
 */
export function getSessionId(sessionFile: string): string | null {
  try {
    const raw = readFileSync(sessionFile, "utf8");
    const firstLine = raw.split("\n").find((line) => line.trim());
    if (!firstLine) return null;
    const id = (JSON.parse(firstLine) as { id?: unknown }).id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * Return entries added after `afterLine` (1-indexed count of existing entries).
 */
export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  return lines.slice(afterLine).map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Find the last assistant message text in a list of entries.
 */
export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;

    const texts = msg.message.content
      .filter(
        (block) =>
          block.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
      )
      .map((block) => block.text as string);

    if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");
  }
  return null;
}

/**
 * Append a branch_summary entry to the session file.
 * Returns the new entry's id.
 */
export function appendBranchSummary(
  sessionFile: string,
  branchPointId: string,
  fromId: string | null,
  summary: string,
): string {
  const id = randomBytes(4).toString("hex");
  const entry = {
    type: "branch_summary",
    id,
    parentId: branchPointId,
    timestamp: new Date().toISOString(),
    fromId: fromId ?? branchPointId,
    summary,
  };
  appendFileSync(sessionFile, JSON.stringify(entry) + "\n", "utf8");
  return id;
}

/**
 * Copy the session file to destDir for parallel worker isolation.
 * Returns the path of the copy.
 */
export function copySessionFile(sessionFile: string, destDir: string): string {
  const id = randomBytes(4).toString("hex");
  const dest = join(destDir, `subagent-${id}.jsonl`);
  copyFileSync(sessionFile, dest);
  return dest;
}

/**
 * Read new entries from sourceFile (after afterLine), append them to targetFile.
 * Returns the appended entries.
 */
export function mergeNewEntries(
  sourceFile: string,
  targetFile: string,
  afterLine: number,
): SessionEntry[] {
  const entries = getNewEntries(sourceFile, afterLine);
  for (const entry of entries) {
    appendFileSync(targetFile, JSON.stringify(entry) + "\n", "utf8");
  }
  return entries;
}
