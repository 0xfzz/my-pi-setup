// Trimmed session manager: spawn and resume pi agent sessions in-process,
// keep a live registry, project minimal state, and translate the small
// command set (prompt / abort / get_state) onto AgentSession calls.
//
// This replaces the vendored app's 3.4k-line rpc-manager; per the PRD the
// model-selection, lease, trust, push and custom-UI chrome is out of scope.

import { createAgentSession, getAgentDir, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { attachSessionPlugins } from "./plugin-host.ts";

export interface SessionStateLite {
  sessionId: string;
  sessionFile: string;
  isStreaming: boolean;
  isBashRunning: boolean;
  isCompacting: boolean;
  model: { provider: string; id: string } | undefined;
  contextUsage: { percent: number; contextWindow: number; tokens: number } | null;
  thinkingLevel: string;
}

/** The session surface the server consumes; fakes in tests implement this. */
export interface SessionCore {
  readonly sessionId: string;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  isStreaming(): boolean;
  getState(): SessionStateLite;
}

export interface SessionHandle {
  core: SessionCore;
  cwd: string;
  sessionFile: string;
  startedAt: number;
  lastActivityAt: number;
}

export interface DiskSession {
  id: string;
  cwd: string;
  file: string;
  modifiedAt: number;
}

export type HistoryBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string }
  | { kind: "toolCall"; toolCallId: string; toolName: string; rawInput: string };

export interface HistoryEntry {
  role: "user" | "assistant";
  blocks: HistoryBlock[];
}

const liveSessions = new Map<string, SessionHandle>();

function toCore(inner: AgentSession): SessionCore {
  return {
    sessionId: inner.sessionId,
    subscribe: (listener: (event: unknown) => void) => inner.subscribe(listener),
    prompt: (text: string) => inner.prompt(text),
    abort: () => inner.abort(),
    isStreaming: () => inner.isStreaming,
    getState: () => {
      const usage = inner.getContextUsage();
      const agentState = (inner as { agent?: { state?: { thinkingLevel?: string } } }).agent?.state;
      return {
        sessionId: inner.sessionId,
        sessionFile: inner.sessionFile ?? "",
        isStreaming: inner.isStreaming,
        isBashRunning: inner.isBashRunning,
        isCompacting: inner.isCompacting,
        model: inner.model ? { provider: inner.model.provider, id: inner.model.id } : undefined,
        contextUsage: usage
          ? {
            percent: usage.percent ?? 0,
            contextWindow: usage.contextWindow ?? 0,
            tokens: usage.tokens ?? 0,
          }
          : null,
        thinkingLevel: agentState?.thinkingLevel ?? "off",
      };
    },
  };
}

function register(core: SessionCore, cwd: string, sessionFile: string, inner?: unknown): SessionCore {
  liveSessions.set(core.sessionId, {
    core,
    cwd,
    sessionFile,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
  });
  // Attach the web-plugin host to the live session's extension event bus so
  // plugin views and UI events flow into the store. The host reads the
  // { sessionId, inner, onEvent } wrapper shape itself; fake cores pass no inner.
  if (inner !== undefined) {
    void attachSessionPlugins({
      sessionId: core.sessionId,
      inner,
      onEvent: (listener: (event: { type?: string }) => void) =>
        core.subscribe((event: unknown) => listener(event as { type?: string })),
    });
  }
  return core;
}

/** Spawn a brand-new pi session with the project's real extensions loaded. */
export async function startSession(options: {
  cwd: string;
  agentDir?: string;
}): Promise<SessionCore> {
  const { session } = await createAgentSession({
    cwd: options.cwd,
    ...(options.agentDir !== undefined ? { agentDir: options.agentDir } : {}),
  });
  return register(toCore(session), options.cwd, session.sessionFile ?? "", session);
}

/** Resume a session from its .jsonl file. */
export async function resumeSession(options: {
  sessionFile: string;
  agentDir?: string;
}): Promise<SessionCore> {
  const manager = SessionManager.open(options.sessionFile, undefined);
  const cwd = manager.getCwd();
  const { session } = await createAgentSession({
    cwd,
    sessionManager: manager,
    ...(options.agentDir !== undefined ? { agentDir: options.agentDir } : {}),
  });
  return register(toCore(session), cwd, options.sessionFile, session);
}

/** Register a fake core (tests and fixtures). */
export function registerSession(core: SessionCore, cwd: string, sessionFile = ""): void {
  register(core, cwd, sessionFile);
}

export function clearSessionsForTests(): void {
  liveSessions.clear();
}

export function getSession(id: string): SessionHandle | undefined {
  return liveSessions.get(id);
}

export function listLiveSessions(): SessionInfo[] {
  return [...liveSessions.values()].map((handle) => ({
    id: handle.core.sessionId,
    cwd: handle.cwd,
    sessionFile: handle.sessionFile,
    live: true,
    modifiedAt: handle.lastActivityAt,
  }));
}

export interface SessionInfo {
  id: string;
  cwd: string;
  sessionFile: string;
  live: boolean;
  modifiedAt: number;
}

function sessionsRoot(agentDir?: string): string {
  return join(agentDir ?? getAgentDir(), "sessions");
}

function sessionIdFromFileName(fileName: string): string | null {
  const withoutExt = fileName.replace(/\.jsonl$/, "");
  const parts = withoutExt.split("_");
  const id = parts[parts.length - 1];
  return /^[0-9a-f-]{8,}$/i.test(id) ? id : null;
}

interface SessionHeaderLike {
  type?: string;
  id?: string;
  cwd?: string;
  timestamp?: string;
}

async function readSessionHeader(file: string): Promise<SessionHeaderLike | null> {
  try {
    const text = await readFile(file, "utf-8");
    const firstLine = text.split("\n", 1)[0];
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine) as SessionHeaderLike;
    return parsed.type === "session" ? parsed : null;
  } catch {
    return null;
  }
}

/** Sessions on disk under the agent dir, newest first, capped. */
export async function listDiskSessions(options?: {
  agentDir?: string;
  limit?: number;
}): Promise<DiskSession[]> {
  const root = sessionsRoot(options?.agentDir);
  if (!existsSync(root)) return [];
  const limit = options?.limit ?? 30;
  const found: DiskSession[] = [];
  let projectDirs: string[];
  try {
    projectDirs = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  for (const projectDir of projectDirs) {
    let files: string[];
    try {
      files = (await readdir(join(root, projectDir))).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const fileName of files) {
      const file = join(root, projectDir, fileName);
      const header = await readSessionHeader(file);
      if (header?.id === undefined || header.cwd === undefined) continue;
      let modifiedAt = 0;
      try {
        modifiedAt = (await stat(file)).mtimeMs;
      } catch {
        continue;
      }
      found.push({ id: header.id, cwd: header.cwd, file, modifiedAt });
    }
  }
  found.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return found.slice(0, limit);
}

/** Find a session file by id, matching the header id or the filename suffix. */
export async function resolveSessionFile(id: string, agentDir?: string): Promise<string | null> {
  if (!/^[0-9a-zA-Z-]+$/.test(id)) return null;
  const root = sessionsRoot(agentDir);
  if (!existsSync(root)) return null;
  let projectDirs: string[];
  try {
    projectDirs = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  for (const projectDir of projectDirs) {
    let files: string[];
    try {
      files = (await readdir(join(root, projectDir))).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const fileName of files) {
      if (sessionIdFromFileName(fileName) === id) {
        return join(root, projectDir, fileName);
      }
    }
  }
  return null;
}

function contentToBlocks(content: unknown): HistoryBlock[] {
  if (typeof content === "string") {
    return content ? [{ kind: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: HistoryBlock[] = [];
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ kind: "text", text: block.text });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      blocks.push({ kind: "thinking", thinking: block.thinking });
    } else if (block.type === "toolCall") {
      const toolName = typeof block.toolName === "string"
        ? block.toolName
        : (typeof block.name === "string" ? block.name : "tool");
      blocks.push({
        kind: "toolCall",
        toolCallId: typeof block.toolCallId === "string" ? block.toolCallId : "",
        toolName,
        rawInput: typeof block.rawInput === "string" ? block.rawInput : "",
      });
    }
  }
  return blocks;
}

/** Parse the transcript entries (user/assistant messages) from a session file. */
export async function readHistory(sessionFile: string, limit = 200): Promise<HistoryEntry[]> {
  let text: string;
  try {
    text = await readFile(sessionFile, "utf-8");
  } catch {
    return [];
  }
  const entries: HistoryEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (entries.length >= limit) break;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.type !== "message") continue;
    const message = parsed.message;
    if (typeof message !== "object" || message === null) continue;
    const role = (message as Record<string, unknown>).role;
    if (role !== "user" && role !== "assistant") continue;
    const blocks = contentToBlocks((message as Record<string, unknown>).content);
    if (blocks.length > 0) entries.push({ role, blocks });
  }
  return entries;
}

export type SessionCommand =
  | { type: "prompt"; message: string }
  | { type: "abort" }
  | { type: "get_state" };

export type CommandResult =
  | { status: "ok"; data: unknown }
  | { status: "not_found" }
  | { status: "error"; error: string };

export function parseSessionCommand(body: unknown): SessionCommand | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be an object" };
  const command = body as Record<string, unknown>;
  if (command.type === "prompt") {
    if (typeof command.message !== "string" || command.message.trim() === "") {
      return { error: "prompt requires a non-empty message" };
    }
    return { type: "prompt", message: command.message };
  }
  if (command.type === "abort") return { type: "abort" };
  if (command.type === "get_state") return { type: "get_state" };
  return { error: `unknown command type: ${String(command.type)}` };
}

/** Route a command to a live session (no implicit spawn: the routes ensure liveness). */
export function sendCommand(id: string, command: SessionCommand): Promise<CommandResult> {
  const handle = liveSessions.get(id);
  if (handle === undefined) return Promise.resolve({ status: "not_found" });
  handle.lastActivityAt = Date.now();
  const { core } = handle;
  switch (command.type) {
    case "prompt": {
      const state = core.getState();
      if (state.isBashRunning) {
        return Promise.resolve({
          status: "error",
          error: "Cannot send a prompt while a shell command is running",
        });
      }
      return core
        .prompt(command.message)
        .then(() => ({ status: "ok", data: { accepted: true } }) as const)
        .catch((error: unknown) => ({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        }));
    }
    case "abort": {
      return core
        .abort()
        .then(() => ({ status: "ok", data: { aborted: true } }) as const)
        .catch((error: unknown) => ({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        }));
    }
    case "get_state": {
      return Promise.resolve({ status: "ok", data: core.getState() });
    }
  }
}

/** Get the live core for `id`, resuming from disk when it is not live yet. */
export async function ensureSession(
  id: string,
  options?: { agentDir?: string },
): Promise<SessionCore | null> {
  const existing = liveSessions.get(id);
  if (existing !== undefined) return existing.core;
  const file = await resolveSessionFile(id, options?.agentDir);
  if (file === null) return null;
  return resumeSession({ sessionFile: file, ...options });
}
