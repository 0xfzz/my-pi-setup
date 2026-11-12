/**
 * Raw model text in, one title or a named rejection out. Pure.
 *
 * A rejection is a failure, never a fallback: the session stays untitled and
 * the reason is shown. The raw first line of a prompt is never used as a title.
 */
import { meaningfulSessionTitle } from "../naming.ts";

export const TITLE_MIN_WORDS = 3;
export const TITLE_MAX_WORDS = 8;
export const TITLE_MAX_CHARS = 60;

const GENERIC = new Set([
  "new session", "coding help", "greeting", "untitled", "session", "default", "title",
  "conversation", "chat", "help", "question", "coding question", "light chat",
]);
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const LONG_HEX_RE = /\b[0-9a-f]{12,}\b/i;
const URL_RE = /https?:\/\/|www\./i;
/** Path shapes only: `/abs`, `./rel`, `~/home`, `dir/file.ext`, `a/b/c`, `C:\\x`. A slash inside a phrase is not a path. */
const PATH_RE = /(?:^|\s)(?:~|\.{1,2})?\/\S|\S+\/\S+\.\w{1,6}\b|\S+\/\S+\/\S+|[a-z]:\\/i;

export type TitleRejection =
  | "empty"
  | "keep-without-current"
  | "too-few-words"
  | "too-many-words"
  | "generic"
  | "path"
  | "url"
  | "identifier"
  | "echo"
  | "not-a-title";

export type TitleVerdict =
  | { kind: "title"; title: string }
  | { kind: "keep" }
  | { kind: "rejected"; reason: TitleRejection };

export interface CleanInput {
  project?: string;
  /** The first user message, so an echo of it can be refused. */
  firstUser?: string;
  /** The title on the session now; `KEEP` is only valid with one. */
  currentTitle?: string;
}

function firstLine(raw: string): string {
  return raw.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? "";
}

/** Strip the markup, quotes and trailing punctuation a model adds around a title. */
export function stripDecoration(line: string): string {
  return line
    .replace(/^(?:title|judul)\s*[:：-]\s*/i, "")
    .replace(/^[#>*_\-\s]+/, "")
    .replace(/[*_\s]+$/, "")
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
    .replace(/[\s.。!?:;,]+$/, "")
    .trim();
}

function boundedTo(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, "").trim();
}

/** The first line of a message, normalised the same way a title is, for echo checks. */
function echoKey(text: string | undefined): string {
  return stripDecoration(firstLine(text ?? "")).toLowerCase();
}

export function cleanTitle(raw: unknown, input: CleanInput = {}): TitleVerdict {
  const line = typeof raw === "string" ? firstLine(raw) : "";
  if (!line) return { kind: "rejected", reason: "empty" };
  const stripped = stripDecoration(line);
  if (/^keep$/i.test(stripped)) {
    return input.currentTitle ? { kind: "keep" } : { kind: "rejected", reason: "keep-without-current" };
  }
  if (!stripped) return { kind: "rejected", reason: "empty" };
  if (URL_RE.test(stripped)) return { kind: "rejected", reason: "url" };
  if (PATH_RE.test(stripped)) return { kind: "rejected", reason: "path" };
  if (UUID_RE.test(stripped) || LONG_HEX_RE.test(stripped)) return { kind: "rejected", reason: "identifier" };

  const title = boundedTo(stripped, TITLE_MAX_CHARS);
  if (GENERIC.has(title.toLowerCase())) return { kind: "rejected", reason: "generic" };
  const words = title.split(/\s+/).filter(Boolean).length;
  if (words < TITLE_MIN_WORDS) return { kind: "rejected", reason: "too-few-words" };
  if (words > TITLE_MAX_WORDS) return { kind: "rejected", reason: "too-many-words" };
  if (echoKey(input.firstUser) === title.toLowerCase()) return { kind: "rejected", reason: "echo" };
  const meaningful = meaningfulSessionTitle(title, { project: input.project });
  if (!meaningful) return { kind: "rejected", reason: "not-a-title" };
  return { kind: "title", title: meaningful };
}
