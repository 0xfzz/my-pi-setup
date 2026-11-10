// Trimmed session manager: spawn and resume pi agent sessions in-process,
// keep a live registry, project minimal state, and translate the small
// command set (prompt / abort / get_state) onto AgentSession calls.
//
// This replaces the vendored app's 3.4k-line rpc-manager; per the PRD the
// model-selection, lease, trust, push and custom-UI chrome is out of scope.

import { createAgentSession, getAgentDir, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createStreamTracker, type StreamSnapshot } from "./stream-tracker.ts";
import { createReadStream, existsSync } from "node:fs";
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
  prompt(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void>;
  abort(): Promise<void>;
  isStreaming(): boolean;
  getState(): SessionStateLite;
  /** Slash commands the session can dispatch (extension/prompt/skill). */
  getCommands?(): Array<{ name: string; description?: string }>;
  /** Model list for the web picker + the current model. */
  getModels?(): { current?: { provider: string; id: string }; models: Array<{ provider: string; id: string }> };
  /** Apply a model to the session; false when it could not be applied. */
  setModel?(provider: string, id: string): Promise<boolean>;
  /** Apply a thinking level; false when rejected. */
  setThinkingLevel?(level: string): Promise<boolean>;
  /** Dispatch a web core command (name + args) to the session owner. */
  webCommand?(name: string, args: string): Promise<void>;
  /**
   * The in-flight streaming message, tapped from the session's raw events.
   * Browser streams replay it right after `connected` so a mid-turn
   * (re)connect renders the partial reply instead of dropping deltas.
   */
  getStreamSnapshot?(): StreamSnapshot;
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
  | { kind: "toolCall"; toolCallId: string; toolName: string; rawInput: string }
  | { kind: "image"; data: string; mimeType: string }
  | { kind: "bash"; command: string; output: string; exitCode?: number; cancelled?: boolean; truncated?: boolean };

export interface HistoryEntry {
  role: "user" | "assistant";
  blocks: HistoryBlock[];
  /** Set when the assistant reply ended because the run was aborted. */
  aborted?: boolean;
}

/** A tool call's result, joined to its call by toolCallId. */
export interface ToolResultEntry {
  text: string;
  isError: boolean;
  /** The edit tool's diff, from the result's `details.diff`. */
  diff?: string;
  /** Image blocks the tool returned (read on an image file, screenshots). */
  images?: Array<{ data: string; mimeType: string }>;
}

export interface SessionHistory {
  entries: HistoryEntry[];
  toolResults: Record<string, ToolResultEntry>;
}

const liveSessions = new Map<string, SessionHandle>();

function toCore(inner: AgentSession): SessionCore {
  const getCommands = (): Array<{ name: string; description?: string }> =>
    inner.extensionRunner
      .getRegisteredCommands()
      .map((command) => ({
        name: command.invocationName,
        ...(command.description !== undefined ? { description: command.description } : {}),
      }));
  // The same list the TUI's /model picker offers: scoped models when
  // scoping is active, otherwise the available catalogue snapshot.
  const modelRefs = (): Array<{ provider: string; id: string }> => {
    const scoped = inner.scopedModels;
    const source = scoped.length > 0 ? scoped.map((scopedModel) => scopedModel.model) : inner.modelRuntime.getAvailableSnapshot();
    return source.map((model) => ({ provider: model.provider, id: model.id }));
  };
  const findModel = (provider: string, id: string) => modelRefs().find((ref) => ref.provider === provider && ref.id === id);
  // A permanent tap on the session's raw events keeps the in-flight
  // streaming snapshot current from the session's birth — not from the
  // first browser stream — so any (re)connect can replay it.
  const streamTracker = createStreamTracker();
  inner.subscribe(streamTracker.feed);
  return {
    sessionId: inner.sessionId,
    subscribe: (listener: (event: unknown) => void) => inner.subscribe(listener),
    getStreamSnapshot: (): StreamSnapshot => streamTracker.snapshot(),
    // Prompts pass through AgentSession.prompt with its default
    // expandPromptTemplates: "/command …" dispatches extension commands;
    // steer queues the message when a run is already streaming, like the TUI.
    prompt: (text: string, images?: Array<{ data: string; mimeType: string }>) =>
      inner.prompt(text, {
        streamingBehavior: "steer",
        ...(images !== undefined && images.length > 0
          ? { images: images.map((image) => ({ type: "image" as const, ...image })) }
          : {}),
      }),
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
    getCommands,
    getModels: () => ({
      models: modelRefs(),
      ...(inner.model !== undefined ? { current: { provider: inner.model.provider, id: inner.model.id } } : {}),
    }),
    setModel: async (provider: string, id: string) => {
      const ref = findModel(provider, id);
      if (ref === undefined) return false;
      const model = inner.modelRuntime.getAvailableSnapshot().find(
        (candidate) => candidate.provider === provider && candidate.id === id,
      );
      if (model === undefined) return false;
      await inner.setModel(model, { persist: false });
      return true;
    },
    setThinkingLevel: async (level: string) => {
      await inner.setThinkingLevel(level as never, { persist: false });
      return true;
    },
  };
}

function register(core: SessionCore, cwd: string, sessionFile: string, inner?: unknown): SessionCore {
  const replaced = liveSessions.get(core.sessionId);
  liveSessions.set(core.sessionId, {
    core,
    cwd,
    sessionFile,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
  });
  if (replaced !== undefined && replaced.core !== core) {
    // Someone else now owns this session (a bridge over an in-process
    // resume). Wake every stream watching the old owner so they reconnect
    // to the live one. Array.from snapshots: a listener's cleanup can
    // unsubscribe from the set while the loop runs.
    const listeners = replacementListeners.get(core.sessionId);
    if (listeners !== undefined) for (const listener of Array.from(listeners)) listener();
  }
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

/**
 * Streams watching a session that gets REPLACED (a TUI bridge attaching over
 * an in-process resume, or a re-attach) must end so the browser reconnects
 * and resolves the new owner — otherwise they keep watching a frozen copy.
 */
const replacementListeners = new Map<string, Set<() => void>>();

export function onSessionReplaced(sessionId: string, listener: () => void): () => void {
  let listeners = replacementListeners.get(sessionId);
  if (listeners === undefined) {
    listeners = new Set();
    replacementListeners.set(sessionId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) replacementListeners.delete(sessionId);
  };
}

export function clearSessionsForTests(): void {
  liveSessions.clear();
}

export function getSession(id: string): SessionHandle | undefined {
  return liveSessions.get(id);
}

/** Drop a live session registration (bridge detach or replacement). */
export function unregisterSession(id: string): void {
  liveSessions.delete(id);
}

export function listLiveSessions(): SessionInfo[] {
  return [...liveSessions.values()].map((handle) => ({
    id: handle.core.sessionId,
    cwd: handle.cwd,
    sessionFile: handle.sessionFile,
    live: true,
    running: handle.core.getState().isStreaming,
    modifiedAt: handle.lastActivityAt,
  }));
}

export interface SessionInfo {
  id: string;
  cwd: string;
  sessionFile: string;
  live: boolean;
  modifiedAt: number;
  /** The session is mid-turn right now (agent streaming), for live sessions. */
  running?: boolean;
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

/**
 * Read only the first line of a session file, streaming: a directory scan
 * must never load whole session files (they run to megabytes) just to read
 * a header.
 */
async function readSessionHeader(file: string): Promise<SessionHeaderLike | null> {
  return new Promise((resolve) => {
    const stream = createReadStream(file, { encoding: "utf-8" });
    let settled = false;
    let buffer = "";
    const finish = (value: SessionHeaderLike | null): void => {
      if (settled) return;
      settled = true;
      stream.destroy();
      resolve(value);
    };
    stream.on("data", (chunk: string | Buffer) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        try {
          const parsed = JSON.parse(buffer.slice(0, newline)) as SessionHeaderLike;
          finish(parsed.type === "session" ? parsed : null);
        } catch {
          finish(null);
        }
        return;
      }
      // A header line never spans 64 KB; stop reading instead of buffering.
      if (buffer.length > 65_536) finish(null);
    });
    stream.on("error", () => finish(null));
    stream.on("end", () => {
      try {
        const parsed = JSON.parse(buffer) as SessionHeaderLike;
        finish(parsed.type === "session" ? parsed : null);
      } catch {
        finish(null);
      }
    });
  });
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
    } else if (block.type === "image" && typeof block.data === "string") {
      blocks.push({
        kind: "image",
        data: block.data,
        mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/png",
      });
    } else if (block.type === "toolCall") {
      // pi's on-disk spelling is { id, name, arguments }; the browser's is
      // { toolCallId, toolName, rawInput }. Accept both.
      const args = typeof block.arguments === "object" && block.arguments !== null
        ? (block.arguments as Record<string, unknown>)
        : undefined;
      blocks.push({
        kind: "toolCall",
        toolCallId: typeof block.toolCallId === "string"
          ? block.toolCallId
          : (typeof block.id === "string" ? block.id : ""),
        toolName: typeof block.toolName === "string"
          ? block.toolName
          : (typeof block.name === "string" ? block.name : "tool"),
        rawInput: typeof block.rawInput === "string"
          ? block.rawInput
          : args !== undefined && Object.keys(args).length > 0 ? JSON.stringify(args) : "",
      });
    }
  }
  return blocks;
}

/** Tool-result message content → plain text, images and the edit diff. */
function contentToResult(content: unknown): {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
} {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };
  const parts: string[] = [];
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const raw of content) {
    if (typeof raw === "object" && raw !== null) {
      const block = raw as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (block.type === "image" && typeof block.data === "string") {
        images.push({ data: block.data, mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/png" });
      }
    }
  }
  return { text: parts.join("\n"), images };
}

/** The edit tool's diff from a tool result's `details`. */
function detailsDiff(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const diff = (details as { diff?: unknown }).diff;
  return typeof diff === "string" && diff !== "" ? diff : undefined;
}

/** Parse the transcript entries and tool results from a session file. */
export async function readHistory(sessionFile: string, limit = 200): Promise<SessionHistory> {
  let text: string;
  try {
    text = await readFile(sessionFile, "utf-8");
  } catch {
    return { entries: [], toolResults: {} };
  }
  const entries: HistoryEntry[] = [];
  const toolResults: Record<string, ToolResultEntry> = {};
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
    const messageRecord = message as Record<string, unknown>;
    const role = messageRecord.role;
    if (role === "toolResult") {
      const toolCallId = messageRecord.toolCallId;
      if (typeof toolCallId === "string" && toolCallId !== "") {
        const { text, images } = contentToResult(messageRecord.content);
        const diff = detailsDiff(messageRecord.details);
        toolResults[toolCallId] = {
          text,
          isError: messageRecord.isError === true,
          ...(diff !== undefined ? { diff } : {}),
          ...(images.length > 0 ? { images } : {}),
        };
      }
      continue;
    }
    if (role === "bashExecution") {
      // `!` commands the user ran in the TUI: shown in the transcript as a
      // user-side bash row (command, output, exit code).
      const blocks: HistoryBlock[] = [{
        kind: "bash",
        command: typeof messageRecord.command === "string" ? messageRecord.command : "",
        output: typeof messageRecord.output === "string" ? messageRecord.output : "",
        ...(typeof messageRecord.exitCode === "number" ? { exitCode: messageRecord.exitCode } : {}),
        ...(messageRecord.cancelled === true ? { cancelled: true } : {}),
        ...(messageRecord.truncated === true ? { truncated: true } : {}),
      }];
      entries.push({ role: "user", blocks });
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    const blocks = contentToBlocks(messageRecord.content);
    const entry: HistoryEntry = { role, blocks };
    if (role === "assistant" && messageRecord.stopReason === "aborted") entry.aborted = true;
    if (blocks.length > 0) entries.push(entry);
  }
  return { entries, toolResults };
}

export interface PromptImage {
  data: string;
  mimeType: string;
}

export type SessionCommand =
  | { type: "prompt"; message: string; images?: PromptImage[] }
  | { type: "abort" }
  | { type: "get_state" }
  | { type: "web_command"; name: string; args?: string };

export type CommandResult =
  | { status: "ok"; data: unknown }
  | { status: "not_found" }
  | { status: "error"; error: string };

/** Prompt attachments: base64 image blocks, bounded in count and size. */
function parsePromptImages(images: unknown): PromptImage[] | { error: string } {
  if (images === undefined) return [];
  if (!Array.isArray(images)) return { error: "images must be an array" };
  if (images.length > 8) return { error: "too many images (max 8)" };
  const parsed: PromptImage[] = [];
  for (const raw of images) {
    if (typeof raw !== "object" || raw === null) return { error: "images entries must be objects" };
    const image = raw as { data?: unknown; mimeType?: unknown };
    if (typeof image.data !== "string" || image.data === "") {
      return { error: "images entries require non-empty data" };
    }
    if (typeof image.mimeType !== "string" || !image.mimeType.startsWith("image/")) {
      return { error: "images entries require an image/* mimeType" };
    }
    if (image.data.length > 6_000_000) {
      return { error: "image too large (max ~6 MB of base64 per image)" };
    }
    parsed.push({ data: image.data, mimeType: image.mimeType });
  }
  return parsed;
}

export function parseSessionCommand(body: unknown): SessionCommand | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be an object" };
  const command = body as Record<string, unknown>;
  if (command.type === "prompt") {
    if (typeof command.message !== "string") {
      return { error: "prompt requires a message" };
    }
    // An image-only prompt carries an empty message.
    if (command.message.trim() === "" && !Array.isArray(command.images)) {
      return { error: "prompt requires a non-empty message" };
    }
    const images = parsePromptImages(command.images);
    if ("error" in images) return { error: images.error };
    return {
      type: "prompt",
      message: command.message,
      ...(images.length > 0 ? { images } : {}),
    };
  }
  if (command.type === "abort") return { type: "abort" };
  if (command.type === "get_state") return { type: "get_state" };
  if (command.type === "web_command") {
    if (typeof command.name !== "string" || command.name.trim() === "") {
      return { error: "web_command requires a name" };
    }
    const name = command.name.trim();
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
      return { error: "web_command name must be a simple identifier" };
    }
    return {
      type: "web_command",
      name,
      ...(typeof command.args === "string" ? { args: command.args.slice(0, 4_000) } : {}),
    };
  }
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
      // The prompt rides as typed — `@file` mentions included. The model
      // reads them with pi's read tool, which natively strips the `@`
      // prefix (resolveReadPath); the server never inlines file content.
      return core
        .prompt(command.message, command.images)
        .then((): CommandResult => ({ status: "ok", data: { accepted: true } }))
        .catch((error: unknown): CommandResult => ({
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
    case "web_command": {
      // The web core's command channel. Bridged sessions forward to the
      // extension registry; in-process sessions re-route through the prompt
      // path, where the mode-gated pi commands dispatch them.
      if (core.webCommand !== undefined) {
        return core
          .webCommand(command.name, command.args ?? "")
          .then(() => ({ status: "ok", data: { accepted: true } }) as const)
          .catch((error: unknown) => ({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      return core
        .prompt(`/${command.name}${command.args !== undefined && command.args !== "" ? ` ${command.args}` : ""}`)
        .then(() => ({ status: "ok", data: { accepted: true } }) as const)
        .catch((error: unknown) => ({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        }));
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
