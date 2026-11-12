/**
 * The title brief: the bounded slice of a session a title is written from.
 *
 * Pure: branch in, plain text out. It carries what the session is about (goal,
 * plan, the opening exchange, the work footprint), never tool output, thinking,
 * system prompts or file contents. Paths and tool names are the only detail
 * taken from tool calls. Every signal has its own cap, so the brief stays near
 * 750 tokens however long the session is.
 */
import { initialPlanTitle, latestGoalTitle } from "../dashboard/goal-title.ts";

export const BRIEF_CAPS = Object.freeze({
  goal: 200,
  firstUser: 1_000,
  firstAssistant: 500,
  latestUser: 500,
  footprint: 300,
  compaction: 300,
  currentTitle: 80,
  hint: 200,
});

/** A brief with less natural language than this is not worth a request. */
export const MIN_NATURAL_CHARS = 20;
/** Fenced blocks longer than this collapse to their first 3 and last 2 lines. */
export const CODE_COLLAPSE_LINES = 8;
/** Messages at or under this many characters of natural language are greetings or noise. */
const SHORT_MESSAGE_CHARS = 12;
const FILE_TOOLS = new Set(["read", "edit", "write"]);
const FOOTPRINT_FILES = 6;

/** Tags that wrap the brief. Session text may not open or close one. */
export const TITLE_TAGS = Object.freeze([
  "brief", "goal", "first_user", "first_assistant", "latest_user", "compaction", "footprint", "current_title", "hint",
] as const);

const GREETINGS = new Set([
  "hi", "hello", "hey", "hai", "halo", "yo", "ok", "okay", "test", "tes", "thanks", "thank you", "ping",
]);

const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/\b[A-Fa-f0-9]{32,}\b/g, "[redacted]"],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, "[redacted]"],
];
const TAG_LIKE = new RegExp(`<(/?)(${TITLE_TAGS.join("|")})\\b`, "gi");
const URL_RE = /https?:\/\/\S+|www\.\S+/gi;
/** Any token containing a slash: a path, a URL fragment, or a slash command. */
const PATH_TOKEN_RE = /\S*\/\S*/g;
const FENCE_RE = /(```[^\n]*)\n([\s\S]*?)```/g;

export interface BriefInput {
  branch: readonly any[];
  sessionId: string;
  cwd: string;
  /** Current git branch, when the caller knows it. */
  gitBranch?: string;
  /** The title currently on the session, for the refinement pass. */
  currentTitle?: string;
  /** A hint from `/title now <hint>`. Treated as data, like everything else. */
  hint?: string;
  /** True for the refinement pass: adds the latest user message if it differs. */
  refinement?: boolean;
}

export interface TitleBrief {
  goal: string;
  firstUser: string;
  firstAssistant: string;
  latestUser: string;
  compaction: string;
  footprint: string;
  currentTitle: string;
  hint: string;
  /** User messages on the branch, used by the refinement trigger. */
  userTurns: number;
  /** A committed plan exists for this session. */
  hasPlan: boolean;
}

interface Message {
  role?: string;
  content?: unknown;
  stopReason?: string;
  usage?: unknown;
}

export function redact(text: string): string {
  return REDACTIONS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

/** Stops session text from closing or opening one of the brief's own tags. */
export function neutralize(text: string): string {
  return text.replace(TAG_LIKE, "&lt;$1$2");
}

/** Replace each long fenced block with its head, an omission marker, and its tail. */
export function collapseCode(text: string): string {
  return text.replace(FENCE_RE, (block, opener: string, body: string) => {
    const lines = body.replace(/\n$/, "").split("\n");
    if (lines.length <= CODE_COLLAPSE_LINES) return block;
    const omitted = lines.length - 5;
    return [opener, ...lines.slice(0, 3), `[… ${omitted} lines]`, ...lines.slice(-2), "```"].join("\n");
  });
}

/** One line, bounded, ellipsis when cut. */
export function clip(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1).trimEnd()}…` : flat;
}

/** The text a model may see: collapsed, redacted, neutralised, bounded. */
export function prepare(text: string, cap: number): string {
  return clip(neutralize(redact(collapseCode(text))), cap);
}

/** The words of a message with paths, URLs and slash commands removed. */
export function naturalText(text: string): string {
  return text.replace(URL_RE, " ").replace(PATH_TOKEN_RE, " ").replace(/\s+/g, " ").trim();
}

/** A message that says something about the work, not a greeting or a bare command. */
export function isSubstantive(text: string): boolean {
  const natural = naturalText(text);
  const bare = natural.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").trim();
  return natural.length > SHORT_MESSAGE_CHARS && !GREETINGS.has(bare);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** Images and named files appear as a placeholder: their contents never reach the brief. */
function attachmentsOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "image" || block?.type === "file")
    .map((block) => (block.type === "image"
      ? `[attachment: ${typeof block.mimeType === "string" ? block.mimeType : "image"}]`
      : `[attachment: ${typeof block.filename === "string" ? block.filename : "file"}]`))
    .join(" ");
}

function messagesOf(branch: readonly any[]): Message[] {
  return branch.filter((entry) => entry?.type === "message").map((entry) => entry.message as Message);
}

function userTextOf(message: Message): string {
  return [textOf(message.content), attachmentsOf(message.content)].filter(Boolean).join(" ");
}

function relativePath(path: string, cwd: string): string {
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (path.startsWith(root)) return path.slice(root.length);
  if (path.startsWith("/") || /^[a-z]:\\/i.test(path)) return `…/${path.split(/[/\\]/).pop() ?? ""}`;
  return path;
}

/** Tool names and the most-touched files: `edit×7 read×12; auth/session.ts; branch fix/csrf`. */
export function footprintOf(branch: readonly any[], cwd: string, gitBranch?: string): string {
  const tools = new Map<string, number>();
  const files = new Map<string, number>();
  for (const message of messagesOf(branch)) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content as any[]) {
      if (block?.type !== "toolCall" || typeof block.name !== "string") continue;
      tools.set(block.name, (tools.get(block.name) ?? 0) + 1);
      const args = block.arguments ?? block.input;
      const path = args?.path ?? args?.file_path;
      if (FILE_TOOLS.has(block.name) && typeof path === "string") {
        const shown = relativePath(path, cwd);
        files.set(shown, (files.get(shown) ?? 0) + 1);
      }
    }
  }
  const toolPart = [...tools].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}×${count}`).join(" ");
  const filePart = [...files].sort((a, b) => b[1] - a[1]).slice(0, FOOTPRINT_FILES).map(([path]) => path).join(", ");
  const parts = [toolPart, filePart, gitBranch ? `branch ${gitBranch}` : ""].filter(Boolean);
  return clip(neutralize(redact(parts.join("; "))), BRIEF_CAPS.footprint);
}

function firstExchange(messages: readonly Message[]): { index: number; user: Message | undefined } {
  const index = messages.findIndex((message) => message?.role === "user" && isSubstantive(textOf(message.content)));
  return { index, user: index >= 0 ? messages[index] : undefined };
}

function firstAssistantAfter(messages: readonly Message[], index: number): string {
  for (const message of messages.slice(index + 1)) {
    if (message?.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
    const text = textOf(message.content).trim();
    if (text) return prepare(text, BRIEF_CAPS.firstAssistant);
  }
  return "";
}

function latestCompaction(branch: readonly any[]): string {
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (entry?.type === "compaction" && typeof entry.summary === "string") {
      return prepare(entry.summary, BRIEF_CAPS.compaction);
    }
  }
  return "";
}

/** The goal a person or the agent recorded, else the committed plan's goal. */
function goalOf(branch: readonly any[], sessionId: string): string {
  return latestGoalTitle(branch, sessionId)?.title || initialPlanTitle(branch, sessionId) || "";
}

export function buildTitleBrief(input: BriefInput): TitleBrief {
  const messages = messagesOf(input.branch);
  const { index, user } = firstExchange(messages);
  const latest = [...messages].reverse().find((message) => message?.role === "user");
  const latestText = latest ? userTextOf(latest) : "";
  const firstText = user ? userTextOf(user) : "";
  const includeLatest = input.refinement === true && latestText !== "" && latestText !== firstText;
  return {
    goal: prepare(goalOf(input.branch, input.sessionId), BRIEF_CAPS.goal),
    firstUser: user ? prepare(firstText, BRIEF_CAPS.firstUser) : "",
    firstAssistant: user ? firstAssistantAfter(messages, index) : "",
    latestUser: includeLatest ? prepare(latestText, BRIEF_CAPS.latestUser) : "",
    compaction: latestCompaction(input.branch),
    footprint: footprintOf(input.branch, input.cwd, input.gitBranch),
    currentTitle: input.currentTitle ? prepare(input.currentTitle, BRIEF_CAPS.currentTitle) : "",
    hint: input.hint ? prepare(input.hint, BRIEF_CAPS.hint) : "",
    userTurns: messages.filter((message) => message?.role === "user").length,
    hasPlan: Boolean(initialPlanTitle(input.branch, input.sessionId)),
  };
}

/** Enough natural language to name something. A brief below this is not sent. */
export function hasNaturalLanguage(brief: TitleBrief): boolean {
  const words = [brief.goal, brief.firstUser, brief.latestUser, brief.hint].map(naturalText).join(" ");
  return words.trim().length >= MIN_NATURAL_CHARS;
}
