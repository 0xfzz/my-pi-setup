/**
 * Stamping sessions: which files are subagent (child) sessions, which are not.
 *
 * Why this exists: a child session is a normal pi session. It lives in the same
 * per-project directory as its parent, so `pi --resume` lists it beside real
 * conversations and the picker fills with runs the user never started. In
 * `~/.pi/agent/sessions` that was 107 children out of 342 sessions, and only 35
 * of them carried `parentSession` in their header — the rest were top-level
 * entries, indistinguishable from a session the user opened themselves.
 *
 * Two independent facts, deliberately not conflated:
 *
 *   - **Kind** — child or main. Proven by evidence, never inferred from mood:
 *     `header.parentSession`, the spawn ticket text this package writes into the
 *     child's first user message, or a `subagent-context:v1` provenance entry.
 *   - **Label** — a `session_info` name, which is exactly what pi's picker shows
 *     (`session.name ?? session.firstMessage`) and what the rename key writes.
 *
 * A label is a convenience; the kind is the contract. Anything that cannot prove
 * a child from evidence is reported as main rather than guessed.
 */

export type SessionKind = "child" | "main";

/** Where the child determination came from. `none` means "no child evidence". */
export type StampEvidence = "header" | "ticket" | "header+ticket" | "none";

/** Name prefixes. The picker is a narrow column, so they are one short word. */
export const CHILD_PREFIX = "child";
export const MAIN_PREFIX = "main";

/**
 * Text this package's launcher writes into a child's first user message.
 *
 * Kept in sync with `vendor/pi-herdr-subagents/src/launch.ts` (the ticket
 * wrapper). A child always receives one of these; a main session almost never
 * does, and when a user pastes one it is a false positive that costs nothing but
 * a label.
 */
const TICKET_MARKERS = [
  "Complete your task autonomously.",
  "When finished, call the agent_done tool.",
  "You did not inherit your parent's conversation",
  "The conversation above was copied from your parent at launch",
];

export interface SessionFacts {
  kind: SessionKind;
  evidence: StampEvidence;
  /** Parent session file, when a source recorded it. */
  parentSession?: string;
  sessionId?: string;
  cwd?: string;
  /** Current `session_info` name, if the session has one. */
  currentName?: string;
  /** First user message text, wrapper included. Used for the label. */
  firstUserText?: string;
  /** Last entry id in file order; the parent a `session_info` entry attaches to. */
  leafId: string | null;
  entryCount: number;
}

interface ParsedLine {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  version?: number;
  cwd?: string;
  parentSession?: string;
  name?: string;
  customType?: string;
  data?: { parentSession?: string; [key: string]: unknown };
  message?: { role?: string; content?: unknown };
}

function parseLines(text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ParsedLine);
    } catch {
      // A truncated tail is normal for a session pi is still writing; skip the line
      // rather than discard the whole file.
    }
  }
  return out;
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type?: string; text?: string } => typeof part === "object" && part !== null)
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join(" ");
}

function matchesTicket(text: string): boolean {
  // A ticket is the wrapper, not a mention: a main session can quote it.
  return TICKET_MARKERS.some((marker) => text.includes(marker));
}

/** Read the facts that decide kind and label. Pure: no filesystem access. */
export function readSessionFacts(text: string): SessionFacts {
  const lines = parseLines(text);
  const header = lines.find((line) => line.type === "session");
  let currentName: string | undefined;
  let firstUserText: string | undefined;
  let contextParent: string | undefined;
  let leafId: string | null = null;

  for (const line of lines) {
    if (line.type === "session") continue;
    if (!line.id) continue;
    leafId = line.id;
    if (line.type === "session_info") {
      // Latest wins, including an explicit clear.
      currentName = typeof line.name === "string" && line.name.trim() ? line.name.trim() : undefined;
    }
    if (line.customType === "subagent-context:v1" && typeof line.data?.parentSession === "string") {
      contextParent = line.data.parentSession;
    }
    if (!firstUserText && line.type === "message" && line.message?.role === "user") {
      const text = userText(line.message.content);
      if (text.trim()) firstUserText = text;
    }
  }

  const headerParent = typeof header?.parentSession === "string" ? header.parentSession : undefined;
  const byHeader = Boolean(headerParent);
  const byTicket = Boolean(firstUserText && matchesTicket(firstUserText));
  const evidence: StampEvidence = byHeader && byTicket ? "header+ticket" : byHeader ? "header" : byTicket ? "ticket" : "none";

  return {
    kind: byHeader || byTicket || Boolean(contextParent) ? "child" : "main",
    evidence,
    parentSession: headerParent ?? contextParent,
    sessionId: header?.id,
    cwd: header?.cwd,
    currentName,
    firstUserText,
    leafId,
    entryCount: lines.length,
  };
}

/**
 * Wrapper sentences that surround a task but are not the task.
 *
 * The ticket is assembled as `[role, modeHint, contextNote, task, summary]`, so
 * extracting "the task" means dropping the four paragraphs this package wrote —
 * by sentence, because the wrapper sentences share paragraphs with the task's
 * neighbours.
 */
const WRAPPER_PATTERNS = [
  /call agent_parent_recall/i,
  /Never modify the parent session/i,
  /Your FINAL assistant message/i,
  /The user can interact with you at any time/i,
  /^When finished, call the agent_done tool/i,
  // `modeHint`, split off from the sentence that follows it.
  /^Complete your task\.?$/i,
  /^Complete your task autonomously\.?$/i,
];

/** One line, no newlines, no wrapper, short enough for the picker. */
function snippet(text: string | undefined, max = 64): string {
  if (!text) return "";
  const flat = text
    .replace(/<file\b[^>]*>/gi, " ")
    .replace(/<\/file>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = flat.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((sentence) => {
    const trimmed = sentence.trim();
    if (!trimmed) return false;
    if (TICKET_MARKERS.some((marker) => trimmed.includes(marker))) return false;
    return !WRAPPER_PATTERNS.some((pattern) => pattern.test(trimmed));
  });
  const body = (kept.length ? kept.join(" ") : flat)
    .replace(/^[\s.:;,—-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!body) return "";
  return body.length > max ? `${body.slice(0, max - 1).trimEnd()}…` : body;
}

/** Whether a name is one of ours (so re-stamping can update it without asking). */
export function isStampedName(name: string | undefined): boolean {
  if (!name) return false;
  return name.startsWith(`${CHILD_PREFIX} ·`) || name.startsWith(`${MAIN_PREFIX} ·`);
}

export interface StampOptions {
  /** Also label sessions that are not children. Off by default: a main session
   * already reads as itself, and renaming 235 of them is noise, not order. */
  includeMain?: boolean;
  /** Overwrite a name the user set by hand. Off by default. */
  force?: boolean;
  /** Extra text for child labels, e.g. a scope. */
  scope?: string;
  maxChars?: number;
}

export interface StampPlan {
  facts: SessionFacts;
  action: "stamp" | "update" | "keep" | "skip";
  /** The name to write; absent when the action is keep/skip. */
  name?: string;
  /** Why, in one line, for the CLI report. */
  reason: string;
}

export function planStamp(facts: SessionFacts, options: StampOptions = {}): StampPlan {
  if (facts.kind === "main" && !options.includeMain) {
    return { facts, action: "skip", reason: "main session (not labelled)" };
  }
  if (facts.currentName && !isStampedName(facts.currentName) && !options.force) {
    return { facts, action: "keep", reason: "has a user-set name" };
  }
  const body = [options.scope, snippet(facts.firstUserText, options.maxChars ?? 64)].filter(Boolean).join(" · ");
  const prefix = facts.kind === "child" ? CHILD_PREFIX : MAIN_PREFIX;
  const name = body ? `${prefix} · ${body}` : prefix;
  if (facts.currentName === name) return { facts, action: "keep", reason: "already stamped" };
  return {
    facts,
    // "update" means it replaces a name that is already there (ours, or the user's
    // under `force`); "stamp" means it adds the first name to a nameless session.
    action: facts.currentName ? "update" : "stamp",
    name,
    reason: `${facts.kind} (${facts.evidence})`,
  };
}

let counter = 0;

/** Deterministic-enough short id for a `session_info` entry. */
function stampId(seed: string): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  let hash = 2166136261;
  const material = `${seed}:${counter}:${Date.now()}`;
  for (let i = 0; i < material.length; i++) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The stamped file text, or the original text when nothing needs writing.
 *
 * Appends one `session_info` entry — the same entry pi's rename key writes — so
 * the picker shows the label. The header is left untouched: kind is derived, not
 * asserted, and rewriting a header is not ours to do.
 */
export function stampSessionText(
  text: string,
  options: StampOptions = {},
): { text: string; plan: StampPlan } {
  const plan = planStamp(readSessionFacts(text), options);
  if (plan.action !== "stamp" && plan.action !== "update") return { text, plan };
  const entry = {
    type: "session_info",
    id: stampId(plan.facts.sessionId ?? "session"),
    parentId: plan.facts.leafId,
    timestamp: new Date().toISOString(),
    name: plan.name,
  };
  const body = text.endsWith("\n") || text === "" ? text : `${text}\n`;
  return { text: `${body}${JSON.stringify(entry)}\n`, plan };
}
