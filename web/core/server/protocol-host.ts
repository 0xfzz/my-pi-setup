/**
 * The host side of the protocol route. One host per session (and one for the
 * session-less directory route) owns bindings per browser client, so a hello
 * is enforced for each client rather than once for the whole server.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { DirectorySurface } from "../adapters/directory.ts";
import type { SessionSurface } from "../adapters/session.ts";
import { createDirectoryBinding } from "../protocol/bindings/directory.ts";
import { createHttpSseBinding } from "../protocol/bindings/http-sse.ts";
import { handshakeRequired } from "../protocol/bindings/shared.ts";
import type { BindingReply, CapabilityAuditEntry as AuditEntry, ProtocolBinding } from "../protocol/bindings/types.ts";
import { parseEnvelope } from "../protocol/envelope.ts";
import { bridgeError, type BridgeError } from "../protocol/errors.ts";
import { BRIDGE_PROTOCOL_VERSION, HELLO, type Hello, type HelloAck } from "../protocol/version.ts";
import { decodeHistoryCursor, encodeHistoryCursor } from "../../../lib/history-cursor.ts";
import { annotateBuiltinCommands } from "../shared/commands.ts";
import { piBuiltinCommands } from "../pi-api/index.ts";
import { gitBranch } from "./git-branch.ts";
import { createHistoryCache, fileStamp } from "./history-cache.ts";
import { getPluginHost } from "./plugin-host.ts";
import { recordSessionName } from "./sessions.ts";
import {
  deleteSession,
  ensureSession,
  getSession,
  listAllSessions,
  readHistoryPage,
  resolveSessionFile,
  startSession,
} from "./sessions.ts";
import { toWireToolResults } from "./tool-result-wire.ts";
import { webUiStore } from "./ui-store.ts";

const HISTORY_LIMIT = 50;
const PROTOCOL_CURSOR_PREFIX = "p1:";

interface ProtocolCursorState {
  readonly sequence: number;
  readonly offset: number;
}

/** Opaque resume token: it never exposes file paths or the client's cursor shape. */
export function encodeProtocolCursor(state: ProtocolCursorState): string {
  return Buffer.from(`${PROTOCOL_CURSOR_PREFIX}${JSON.stringify(state)}`, "utf8").toString("base64url");
}

export function decodeProtocolCursor(cursor: unknown): ProtocolCursorState | undefined {
  if (typeof cursor !== "string") return undefined;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (!decoded.startsWith(PROTOCOL_CURSOR_PREFIX)) return undefined;
    const parsed: unknown = JSON.parse(decoded.slice(PROTOCOL_CURSOR_PREFIX.length));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const state = parsed as Partial<ProtocolCursorState>;
    if (typeof state.sequence !== "number" || typeof state.offset !== "number"
      || !Number.isSafeInteger(state.sequence) || !Number.isSafeInteger(state.offset)) return undefined;
    return { sequence: Math.max(0, state.sequence), offset: Math.max(0, state.offset) };
  } catch {
    return undefined;
  }
}

const readHistoryCached = createHistoryCache({
  load: (file) => readHistoryPage(file, { limit: HISTORY_LIMIT }),
  stamp: fileStamp,
});

async function historyFileFor(sessionId: string): Promise<string | null> {
  const live = getSession(sessionId);
  return live?.sessionFile || (await resolveSessionFile(sessionId)) || null;
}

/** The resync snapshot is the history page the client already renders. */
async function resyncSnapshot(sessionId: string, params: unknown): Promise<unknown> {
  const body = (params ?? {}) as Record<string, unknown>;
  const previous = decodeProtocolCursor(body.cursor) ?? { sequence: 0, offset: 0 };
  const clientCursor = typeof body.newerCursor === "string" ? decodeHistoryCursor(body.newerCursor) : undefined;
  const after = clientCursor ?? previous.offset;
  const file = await historyFileFor(sessionId);
  const page = file === null
    ? { entries: [], toolResults: {}, olderCursor: encodeHistoryCursor(after), newerCursor: encodeHistoryCursor(after), hasOlder: false }
    : await readHistoryPage(file, { limit: HISTORY_LIMIT, after });
  return {
    sessionId,
    entries: page.entries,
    toolResults: toWireToolResults(page.toolResults),
    olderCursor: page.olderCursor,
    newerCursor: page.newerCursor,
    hasOlder: page.hasOlder,
    cursor: encodeProtocolCursor({ sequence: previous.sequence + 1, offset: toOffset(page.newerCursor) }),
  };
}

function toOffset(cursor: string): number {
  return decodeHistoryCursor(cursor) ?? 0;
}

/** The session-scoped half: every read calls the same server function as its route. */
export function sessionSurfaceOf(sessionId: string, cwd: string): SessionSurface {
  const coreOf = () => getSession(sessionId)?.core;
  return {
    prompt: (text) => coreOf()?.prompt(text),
    abort: () => coreOf()?.abort(),
    setModel: (provider, id) => coreOf()?.setModel?.(provider, id) ?? false,
    setThinkingLevel: (level) => coreOf()?.setThinkingLevel?.(level) ?? false,
    webCommand: (name, args) => coreOf()?.webCommand?.(name, args),
    get: () => ({ running: true, state: coreOf()?.getState() ?? null }),
    branch: async () => {
      await ensureSession(sessionId);
      const directory = getSession(sessionId)?.cwd;
      return { branch: directory === undefined ? null : await gitBranch(directory) };
    },
    models: async () => {
      const core = coreOf();
      if (core === undefined) throw new Error("session not found");
      let catalog = core.getModels?.() ?? { models: [] };
      const picker = getPluginHost()?.services.resolve<(base: typeof catalog, info: { sessionId: string; cwd: string }) => typeof catalog | Promise<typeof catalog>>("model.pick");
      if (picker !== undefined) {
        const overridden = await picker(catalog, { sessionId, cwd });
        if (overridden !== undefined && Array.isArray(overridden.models)) catalog = overridden;
      }
      return { sessionId, ...catalog };
    },
    tree: () => {
      const nodes = coreOf()?.getTreeNodes?.();
      if (nodes === undefined || nodes === null) throw new Error("tree not posted yet");
      return { sessionId, nodes };
    },
    commands: async () => {
      const core = coreOf();
      if (core === undefined) throw new Error("session not found");
      return { sessionId, commands: [...annotateBuiltinCommands(await piBuiltinCommands()), ...(core.getCommands?.() ?? [])] };
    },
    history: (params) => {
      const body = (params ?? {}) as Record<string, unknown>;
      const limit = typeof body.limit === "number" ? Math.min(HISTORY_LIMIT, Math.max(1, Math.floor(body.limit))) : HISTORY_LIMIT;
      const cursor = typeof body.cursor === "string" ? decodeHistoryCursor(body.cursor) : undefined;
      if (typeof body.cursor === "string" && cursor === undefined) throw new Error("invalid history cursor");
      const direction = body.direction === "newer" ? "newer" : "older";
      return historyFileFor(sessionId).then((file) => file === null
        ? { sessionId, entries: [], toolResults: {}, olderCursor: encodeHistoryCursor(0), newerCursor: encodeHistoryCursor(0), hasOlder: false }
        : readHistoryPage(file, direction === "newer" ? { limit, after: cursor ?? 0 } : cursor === undefined ? { limit } : { limit, before: cursor }));
    },
    toolResult: async (toolCallId) => {
      const file = await historyFileFor(sessionId);
      if (file === null) throw new Error("session not found");
      const result = (await readHistoryCached(file)).toolResults[toolCallId];
      if (result === undefined) throw new Error("tool result not found");
      return toWireToolResults({ [toolCallId]: result })[toolCallId];
    },
    snapshot: () => ({ sessionId, ...(webUiStore.snapshot().sessions[sessionId] ?? { views: {} }) }),
    resync: (cursor) => resyncSnapshot(sessionId, { cursor }),
  };
}

/** The directory half: session.list/search/create and session-less session calls. */
export function directorySurfaceOf(): DirectorySurface {
  return {
    list: ({ query }) => listAllSessions({ query }),
    create: ({ cwd }) => {
      const directory = cwd === undefined ? process.cwd() : resolve(cwd);
      if (!existsSync(directory)) throw new Error(`cwd does not exist: ${directory}`);
      return startSession({ cwd: directory }).then((core) => ({ sessionId: core.sessionId, cwd: directory }));
    },
    get: ({ id }) => listAllSessions().then((sessions) => {
      const found = sessions.find((session) => session.id === id);
      if (found === undefined) throw new Error(`session ${id} not found`);
      return { session: found };
    }),
    remove: async ({ id }) => {
      if (id === undefined) throw new Error("session id is required");
      const outcome = await deleteSession(id);
      if (outcome.status !== "ok") throw new Error(`session ${id} cannot be deleted`);
      return { ok: true, sessionId: id };
    },
    rename: ({ id, name }) => {
      if (id === undefined || name === undefined) throw new Error("id and name are required");
      recordSessionName(id, name);
      return { ok: true, sessionId: id, name };
    },
  };
}

export interface ProtocolHostOptions {
  readonly sessionId?: string;
  readonly cwd: string;
  readonly grantedCapabilities: readonly string[];
  /** Capabilities granted to plugin-originated sources; separate from browser grants. */
  readonly pluginGrants?: readonly string[];
  readonly session?: SessionSurface;
  readonly directory?: DirectorySurface;
  readonly snapshot?: () => unknown;
  readonly onAudit?: (entry: AuditEntry) => void;
  /** Overrides the discovered manifest slices, mainly for isolated tests. */
  readonly bridgeSlices?: ReadonlyMap<string, readonly string[]>;
}

export interface ProtocolHost {
  /** One envelope in, one binding reply out; HELLO replies carry the raw ack. */
  handle(input: unknown): Promise<BindingReply>;
  denials(): readonly AuditEntry[];
  close(): Promise<void>;
}

/** Phase 2 owns discovery; the host exposes only the derived slice map. */
export function declaredBridgeSlices(): ReadonlyMap<string, readonly string[]> {
  const host: unknown = getPluginHost();
  if (host === null || typeof host !== "object") return new Map();
  const candidate: unknown = Reflect.get(host, "bridgeSlices");
  if (!(candidate instanceof Map)) return new Map();
  const slices = new Map<string, readonly string[]>();
  for (const [id, messages] of candidate.entries()) {
    if (typeof id !== "string" || !Array.isArray(messages)
      || !messages.every((name): name is string => typeof name === "string")) continue;
    slices.set(id, [...messages]);
  }
  return slices;
}

function clientIdOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const source = (input as { source?: { id?: unknown } }).source;
  if (source === undefined || typeof source.id !== "string" || source.id === "") return undefined;
  return source.id;
}

function refusal(code: BridgeError["code"], message: string): BindingReply {
  return { ok: false, error: bridgeError(code, message) };
}

/**
 * Both hosts share the same handshake and audit rules; only their adapter
 * surfaces differ. A client that never said hello is never dispatched.
 */
function createHost(
  options: ProtocolHostOptions,
  makeBinding: (grants: readonly string[], clientId: string, audit: (entry: AuditEntry) => void) => ProtocolBinding,
): ProtocolHost {
  const bindings = new Map<string, ProtocolBinding>();
  const denials: AuditEntry[] = [];
  const audit = (entry: AuditEntry): void => {
    denials.push(entry);
    options.onAudit?.(entry);
  };

  const bindingFor = (clientId: string): ProtocolBinding => {
    let binding = bindings.get(clientId);
    if (binding === undefined) {
      binding = makeBinding(options.grantedCapabilities, clientId, audit);
      bindings.set(clientId, binding);
    }
    return binding;
  };

  return {
    async handle(input: unknown): Promise<BindingReply> {
      const parsed = parseEnvelope(input);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      const clientId = clientIdOf(parsed.envelope);
      if (clientId === undefined) return refusal("VALIDATION_FAILED", "envelope.source.id identifies the client");

      if (parsed.envelope.version !== BRIDGE_PROTOCOL_VERSION) {
        return { ok: false, error: bridgeError("VERSION_MISMATCH", `peer speaks protocol v${parsed.envelope.version}`, {
          expected: BRIDGE_PROTOCOL_VERSION,
          received: parsed.envelope.version,
        }) };
      }

      if (parsed.envelope.name === HELLO) {
        const hello = parsed.envelope.payload as Hello;
        const outcome = await bindingFor(clientId).hello(hello);
        if (!outcome.ok) bindings.delete(clientId);
        return outcome as BindingReply;
      }

      const binding = bindings.get(clientId);
      if (binding === undefined) return { ok: false, error: handshakeRequired() };
      return binding.invoke(parsed.envelope);
    },

    denials: () => denials,
    async close(): Promise<void> {
      await Promise.all([...bindings.values()].map((binding) => binding.close()));
      bindings.clear();
    },
  };
}

/** Session-scoped host: POST /api/agent/:id/protocol. */
export function createProtocolHost(options: ProtocolHostOptions): ProtocolHost {
  const sessionId = options.sessionId;
  if (sessionId === undefined) throw new Error("a session host needs a sessionId");
  const session = options.session ?? sessionSurfaceOf(sessionId, options.cwd);
  const directory = options.directory ?? directorySurfaceOf();
  return createHost(options, (grants, clientId, audit) => createHttpSseBinding({
    name: "http-sse",
    sessionId,
    cwd: options.cwd,
    grantedCapabilities: grants,
    pluginGrants: options.pluginGrants,
    // Only the composition root opts a host into slice enforcement; an
    // explicitly empty map still denies every undeclared plugin message.
    bridgeSlices: options.bridgeSlices,
    clientId,
    audit,
    session,
    directory,
    snapshot: options.snapshot,
  }));
}

/** Session-less host: POST /api/protocol. Envelopes must not carry sessionId. */
export function createDirectoryProtocolHost(options: ProtocolHostOptions): ProtocolHost {
  return createHost(options, (grants, clientId, audit) => createDirectoryBinding({
    name: "http-sse",
    cwd: options.cwd,
    grantedCapabilities: grants,
    pluginGrants: options.pluginGrants,
    bridgeSlices: options.bridgeSlices,
    clientId,
    audit,
    directory: options.directory ?? directorySurfaceOf(),
  }));
}

export type { Hello, HelloAck };
