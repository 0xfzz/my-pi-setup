// The web server's core API, as native Fastify routes.
//
// Each entry is a real Fastify path (params are Fastify's, not a regex capture)
// with one handler per supported method. A generated per-path dispatcher answers
// 405 for a known path used with an unsupported method, so known-path 405 versus
// unknown-path 404 is preserved without a second handwritten matcher: Fastify's
// router does the matching, and the dispatcher only picks the method.
//
// `asJson` is the one shared response policy (JSON, `cache-control: no-store`).

import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SSERouteOptions } from "@fastify/sse";
import { openEventChannel, SSE_ROUTE_OPTIONS, type EventChannel } from "../http/sse.ts";
import { registerLenientJsonParser, parsedJsonBody as bodyOf } from "../http/json-body.ts";
import { registerMethodFallback } from "../http/method-fallback.ts";
import { SESSION_COMMAND_SCHEMA } from "../../../lib/session-command-schema.ts";
import { PI_API_BODY_SCHEMA } from "../../../lib/pi-api-schema.ts";
import { decodeHistoryCursor } from "../../../lib/history-cursor.ts";
import { CLIENT_LOG_BODY_SCHEMA, coreRequestSchema, MODEL_BODY_SCHEMA, THINKING_BODY_SCHEMA, ACTION_BODY_SCHEMA, PERMISSIVE_BODY_SCHEMA } from "./request-schemas.ts";
import { parseBrowserLogEntries, type BrowserLogEntry } from "../shared/web-log-browser.ts";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { attachBridge, getBridge, type BridgeState } from "./bridge.ts";
import { getPluginDescriptor, getPluginHost, pluginsWhenReady } from "./plugin-host.ts";
import { checkAndSetInFlightAction, recordActionAudit } from "./plugin-actions.ts";
import { validateActionValues } from "../plugin-contracts/actions.ts";
import { isKnownSession, relayActionRequest } from "./plugin-sessions.ts";
import { recordPluginView } from "./plugin-views.ts";
import {
  announceCodeChanges,
  deleteSession,
  ensureSession,
  getServerBootId,
  getSession,
  listAllSessions,
  parseSessionCommand,
  readHistory,
  readHistoryPage,
  reloadStateOf,
  resolveSessionFile,
  sendCommand,
  startSession,
} from "./sessions.ts";
import { createHistoryCache, fileStamp } from "./history-cache.ts";
import { toWireToolResults } from "./tool-result-wire.ts";
import { handlePiApiRequest } from "./pi-api.ts";
import { createInProcessBinding } from "../protocol/bindings/in-process.ts";
import { parseEnvelope } from "../protocol/envelope.ts";
import { BRIDGE_PROTOCOL_VERSION, HELLO, type Hello } from "../protocol/version.ts";
import { gitBranch } from "./git-branch.ts";
import { piBuiltinCommands } from "../pi-api/index.ts";
import { annotateBuiltinCommands } from "../shared/commands.ts";
import { attachAgentEventStream, attachSessionsEventStream } from "./event-stream.ts";
import {
  PLUGIN_CAPABILITY_ACTIONS,
  PLUGIN_MANAGER_ACTIONS,
} from "../shared/plugin-manager.ts";
import {
  applyPluginManagerAction,
  isCapabilityAction,
  isPluginManagerCommand,
  pluginManagerReport,
} from "./plugin-admin.ts";
import { servedClientBuild } from "./client-build.ts";
import { isDraining } from "./drain.ts";

type HttpMethod = "GET" | "POST" | "DELETE";
type CoreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void> | void;

interface CoreRoute {
  path: string;
  methods: Partial<Record<HttpMethod, CoreHandler>>;
  sse?: SSERouteOptions;
  body?: Record<string, unknown>;
  query?: readonly string[];
}

// ── Request helpers ─────────────────────────────────────────────────────────

function asJson(reply: FastifyReply, status: number, body: unknown): void {
  void reply.code(status).header("cache-control", "no-store").send(body);
}

function mainEventChannel(reply: FastifyReply): EventChannel {
  reply.header("cache-control", "no-cache, no-transform");
  return openEventChannel(reply);
}

/** The query string with `URLSearchParams` semantics (first value wins). */
function queryOf(request: FastifyRequest): URLSearchParams {
  return new URLSearchParams(request.query as Record<string, string>);
}

function paramOf(request: FastifyRequest, name: string): string {
  const params = request.params as Record<string, string> | undefined;
  return params?.[name] ?? "";
}

/** The host's own dialog channel: the bridge's built-in pickers. */
const HOST_DIALOG_CHANNEL = "web-core";

/** Cap for the typed value an instant action may carry (a dialog answer). */
const MAX_ACTION_VALUE_LENGTH = 2000;

// ── Handlers ────────────────────────────────────────────────────────────────

function handleHealth(_request: FastifyRequest, reply: FastifyReply): void {
  if (isDraining()) {
    asJson(reply, 503, { ok: false, service: "pi-web-minimal", draining: true });
    return;
  }
  asJson(reply, 200, {
    ok: true,
    service: "pi-web-minimal",
    bootId: getServerBootId(),
    // Which client bundle this server is serving. A page compares it with the
    // id stamped into its own HTML: a mismatch means the page is older than the
    // bundle and reloads onto it.
    buildId: servedClientBuild()?.buildId ?? null,
  });
}

/** Live session counts used by the reload guard before it stops this process. */
function handleReloadState(_request: FastifyRequest, reply: FastifyReply): void {
  asJson(reply, 200, reloadStateOf());
}

async function handleReloadNotice(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  let message: string | undefined;
  try {
    const body = bodyOf(request) as { message?: unknown };
    if (typeof body?.message === "string" && body.message.trim() !== "") {
      message = body.message.trim();
    }
  } catch {
    // Default message is used when no JSON body is supplied.
  }
  announceCodeChanges(message);
  asJson(reply, 200, { ok: true });
}

async function handlePluginsList(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // After boot: a descriptor whose plugin has not activated yet is hidden, and
  // the client reads this list once per page load.
  asJson(reply, 200, { plugins: await pluginsWhenReady() });
}

/**
 * POST /api/plugins/action — 404 before anything else, 403 when a declared
 * confirm does not match byte-identically, 409 while another action is in
 * flight for the session, then audit + relay over the session bus.
 */
async function handlePluginAction(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  let body: {
    sessionId?: unknown;
    pluginId?: unknown;
    actionId?: unknown;
    confirm?: unknown;
    values?: unknown;
  };
  try {
    body = bodyOf(request) as typeof body;
  } catch {
    asJson(reply, 400, { error: "Invalid JSON body" });
    return;
  }
  const { sessionId, pluginId, actionId, confirm } = body ?? {};
  // A dialog form's answers: bounded field names and values, so an extension
  // can read them without defending against a prototype key or a huge body.
  const submitted = validateActionValues(body?.values);
  if (!submitted.ok) {
    asJson(reply, 400, { error: submitted.error });
    return;
  }

  // 1. Validate: sessionId/pluginId/actionId known (404 before anything else).
  if (typeof sessionId !== "string" || !isKnownSession(sessionId)) {
    asJson(reply, 404, { error: "Session not found" });
    return;
  }
  if (typeof pluginId !== "string") {
    asJson(reply, 404, { error: "Plugin not found" });
    return;
  }
  const isHostChannel = pluginId === HOST_DIALOG_CHANNEL;
  const descriptor = isHostChannel ? undefined : getPluginDescriptor(pluginId);
  if (!isHostChannel && !descriptor) {
    asJson(reply, 404, { error: "Plugin not found" });
    return;
  }
  if (typeof actionId !== "string") {
    asJson(reply, 404, { error: "Action not found" });
    return;
  }
  // A plugin whose action ids are chosen at runtime (the host's own dialog
  // channel, or a descriptor that declares `dynamicActions`) validates them
  // itself: the static list cannot name `fork@<entryId>`.
  const action = descriptor?.actions?.find((candidate) => candidate.id === actionId);
  if (!isHostChannel && descriptor?.dynamicActions !== true && !action) {
    asJson(reply, 404, { error: "Action not found" });
    return;
  }

  // 2. A declared confirm must match byte-identically (403, nothing emitted).
  if (action?.confirm !== undefined && (typeof confirm !== "string" || confirm !== action.confirm)) {
    asJson(reply, 403, { error: "Invalid confirmation string" });
    return;
  }

  // 3. One in-flight CONFIRMED submission per (session, plugin, action) (409).
  //    Instant actions (no declared confirm) and the web core channel are
  //    exempt: both are fire-and-forget dispatches.
  const requestId = randomUUID();
  const claimed = action?.confirm === undefined
    || checkAndSetInFlightAction({ sessionId, pluginId, actionId, requestId });
  if (!claimed) {
    asJson(reply, 409, { error: "Action already in flight for this session" });
    return;
  }

  // 4. Audit, then relay to the owning extension over the session event bus.
  recordActionAudit({ requestId, sessionId, pluginId, actionId, timestamp: Date.now() });
  const relayedConfirm = action?.confirm === undefined
    && typeof confirm === "string"
    && confirm.length > 0
    && confirm.length <= MAX_ACTION_VALUE_LENGTH
    ? confirm
    : undefined;
  const relayedValues = action?.confirm === undefined ? submitted.values : undefined;
  if (isHostChannel) {
    // The picker closes here, server-side, so the close is race-free with the
    // picked action's side effect.
    recordPluginView(sessionId, HOST_DIALOG_CHANNEL, { type: "dialog", open: false });
  }
  const { relayed } = relayActionRequest(sessionId, pluginId, actionId, requestId, relayedConfirm, relayedValues);
  asJson(reply, 200, { ok: true, requestId, relayed });
}

function writeBrowserLogEntry(logger: FastifyBaseLogger, entry: BrowserLogEntry): void {
  const fields = {
    source: "browser",
    browserTs: entry.ts,
    ...(entry.stack === undefined ? {} : { err: { type: "BrowserError", message: entry.message, stack: entry.stack } }),
  };
  switch (entry.level) {
    case "fatal": logger.fatal(fields, entry.message); break;
    case "error": logger.error(fields, entry.message); break;
    case "warn": logger.warn(fields, entry.message); break;
    case "info": logger.info(fields, entry.message); break;
    case "debug": logger.debug(fields, entry.message); break;
    case "trace": logger.trace(fields, entry.message); break;
  }
}

function handleClientLog(request: FastifyRequest, reply: FastifyReply): void {
  if (request.validationError !== undefined) {
    asJson(reply, 400, { error: "Invalid JSON body" });
    return;
  }
  const entries = parseBrowserLogEntries(bodyOf(request));
  if (entries === undefined) {
    asJson(reply, 400, { error: "Invalid log entries" });
    return;
  }
  for (const entry of entries) writeBrowserLogEntry(request.log, entry);
  asJson(reply, 200, { ok: true });
}

function handlePluginManagerReport(_request: FastifyRequest, reply: FastifyReply): void {
  const report = pluginManagerReport();
  if (report === null) {
    asJson(reply, 503, { error: "plugin host not started", code: "plugin_host_unavailable" });
    return;
  }
  asJson(reply, 200, report);
}

async function handlePluginManagerCommand(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const pluginId = paramOf(request, "id");
  const action = paramOf(request, "command");
  if (!isPluginManagerCommand(action)) {
    asJson(reply, 400, {
      error: `unknown action "${action}"`,
      actions: [...PLUGIN_MANAGER_ACTIONS, ...PLUGIN_CAPABILITY_ACTIONS],
    });
    return;
  }
  let capability: string | undefined;
  if (isCapabilityAction(action)) {
    try {
      const body = bodyOf(request) as { capability?: unknown };
      if (typeof body?.capability === "string") capability = body.capability;
    } catch {
      capability = undefined;
    }
  }
  const outcome = await applyPluginManagerAction(pluginId, action, capability);
  // 404 only when the kernel does not know the plugin at all; a refused action
  // (quarantined, unresolved, broken) is a 409 carrying the state.
  const unknown = outcome.error?.startsWith("unknown plugin") ?? false;
  asJson(reply, outcome.ok ? 200 : unknown ? 404 : 409, outcome);
}

function handleBridgeAttach(request: FastifyRequest, reply: FastifyReply): void {
  const sessionId = paramOf(request, "id");
  const query = queryOf(request);
  const modelParam = query.get("model");
  const modelSlash = modelParam !== null ? modelParam.indexOf("/") : -1;
  attachBridge({
    channel: mainEventChannel(reply),
    metadata: {
      sessionId,
      cwd: query.get("cwd") ?? process.cwd(),
      sessionFile: query.get("sessionFile") ?? undefined,
      model: modelSlash > 0 && modelParam !== null
        ? { provider: modelParam.slice(0, modelSlash), id: modelParam.slice(modelSlash + 1) }
        : undefined,
      thinkingLevel: query.get("thinkingLevel") ?? undefined,
    },
  });
}

async function handleBridgeEvents(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sessionId = paramOf(request, "id");
  const bridge = getBridge(sessionId);
  if (bridge === undefined) {
    asJson(reply, 404, { error: "Bridge not attached" });
    return;
  }
  try {
    const body = bodyOf(request) as {
      event?: unknown;
      events?: unknown[];
      state?: Partial<BridgeState>;
    };
    if (body.state !== undefined) bridge.postState(body.state);
    const events = [
      ...(Array.isArray(body.events) ? body.events : []),
      ...(body.event !== undefined ? [body.event] : []),
    ];
    for (const event of events) bridge.postEvent(event);
    asJson(reply, 200, { ok: true });
  } catch (error) {
    request.log.warn({ err: error, sessionId }, "bridge event rejected");
    asJson(reply, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleBridgeDetach(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sessionId = paramOf(request, "id");
  const bridge = getBridge(sessionId);
  if (bridge === undefined) {
    asJson(reply, 404, { error: "Bridge not attached" });
    return;
  }
  bridge.close();
  asJson(reply, 200, { ok: true });
}

async function handlePiApi(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sessionId = paramOf(request, "id");
  const handle = getSession(sessionId);
  if (handle === undefined) {
    asJson(reply, 404, { error: "Session not found" });
    return;
  }
  const body = bodyOf(request);
  const outcome = await handlePiApiRequest(handle.cwd, body);
  asJson(reply, outcome.status, outcome.body);
}

/**
 * The protocol binding's HTTP+SSE entry. One route for every catalog message:
 * the client sends an envelope, the binding validates it and dispatches to the
 * same adapters the in-process sessions use. Legacy routes stay as aliases.
 */
async function handleProtocol(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sessionId = paramOf(request, "id");
  const handle = getSession(sessionId);
  if (handle === undefined) {
    asJson(reply, 404, { ok: false, error: { code: "SESSION_NOT_FOUND", message: `session ${sessionId} not found`, retryable: false } });
    return;
  }
  const parsed = parseEnvelope(bodyOf(request));
  if (!parsed.ok) {
    asJson(reply, 400, { ok: false, error: parsed.error });
    return;
  }
  const envelope = parsed.envelope;
  if (envelope.name === HELLO) {
    const hello = envelope.payload as Hello;
    if (hello.version !== BRIDGE_PROTOCOL_VERSION) {
      asJson(reply, 200, { ok: false, error: { code: "VERSION_MISMATCH", message: `peer speaks protocol v${hello.version}`, retryable: false } });
      return;
    }
    asJson(reply, 200, { ok: true, value: {
      version: BRIDGE_PROTOCOL_VERSION,
      capabilities: hello.capabilities,
      bindings: ["http-sse"],
      sessionId,
      cursor: "0",
    } });
    return;
  }
  const binding = createInProcessBinding({
    name: "http-sse",
    sessionId,
    cwd: handle.cwd,
    grantedCapabilities: [],
    session: {
      prompt: (text) => handle.core.prompt(text),
      abort: () => handle.core.abort(),
      setModel: (provider, id) => handle.core.setModel?.(provider, id) ?? false,
      setThinkingLevel: (level) => handle.core.setThinkingLevel?.(level) ?? false,
      webCommand: (name, args) => handle.core.webCommand?.(name, args),
    },
  });
  await binding.hello({
    version: BRIDGE_PROTOCOL_VERSION,
    bindings: ["http-sse"],
    clientId: envelope.source.id,
    capabilities: [],
  });
  const outcome = await binding.invoke(envelope);
  asJson(reply, outcome.ok ? 200 : 400, outcome);
}

async function handleDirectories(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // The new-session picker: subdirectories of a path (hidden dirs skipped,
  // capped) plus the parent for navigation. A bad path is a 400, not an
  // error — the picker shows it inline.
  const requested = queryOf(request).get("path") ?? "";
  let dir: string;
  try {
    dir = resolve(requested === "" ? process.cwd() : requested);
  } catch (error) {
    request.log.warn({ err: error, path: requested }, "invalid directory path");
    asJson(reply, 400, { error: "invalid path" });
    return;
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    asJson(reply, 400, { error: `not a directory: ${dir}` });
    return;
  }
  let dirents: Array<{ isDirectory: () => boolean; name: string }>;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    request.log.warn({ err: error, dir }, "directory listing failed");
    asJson(reply, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const entries = dirents
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: join(dir, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 500);
  const parent = dirname(dir);
  asJson(reply, 200, {
    path: dir,
    parent: parent === dir ? null : parent,
    entries,
  });
}

function handleSessionsEvents(_request: FastifyRequest, reply: FastifyReply): void {
  attachSessionsEventStream(mainEventChannel(reply));
}

async function handleSessionsList(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const query = queryOf(request).get("q") ?? undefined;
  const sessions = await listAllSessions({ query });
  asJson(reply, 200, { sessions });
}

async function handleSessionDelete(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const outcome = await deleteSession(paramOf(request, "id"));
  if (outcome.status === "not_found") {
    asJson(reply, 404, { error: "Session not found" });
    return;
  }
  if (outcome.status === "vetoed") {
    asJson(reply, 403, { error: outcome.reason, vetoedBy: outcome.pluginId });
    return;
  }
  asJson(reply, 200, { ok: true });
}

async function handleAgentNew(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  let requestedCwd: unknown;
  try {
    const body = bodyOf(request) as { cwd?: unknown };
    requestedCwd = body.cwd;
    const cwd = typeof body.cwd === "string" && body.cwd.trim() !== ""
      ? resolve(body.cwd)
      : process.cwd();
    if (!existsSync(cwd)) {
      asJson(reply, 400, { error: `cwd does not exist: ${cwd}` });
      return;
    }
    const core = await startSession({ cwd });
    asJson(reply, 200, { sessionId: core.sessionId, cwd });
  } catch (error) {
    request.log.error({ err: error, cwd: requestedCwd }, "failed to start session");
    asJson(reply, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

function handleAgentEvents(request: FastifyRequest, reply: FastifyReply): void {
  const sessionId = paramOf(request, "id");
  const sessionPromise = ensureSession(sessionId);
  attachAgentEventStream(mainEventChannel(reply), { sessionId, sessionPromise });
}

/** Parsed histories, reused while a session file is unchanged (see history-cache.ts). */
const readHistoryCached = createHistoryCache({ load: (file) => readHistory(file), stamp: fileStamp });

/** The web loads a small newest page first and walks older history on demand. */
const HISTORY_PAGE_LIMIT = 50;
const HISTORY_MAX_LIMIT = 200;

interface HistoryQuery {
  limit: number;
  before?: number;
  after?: number;
}

/** Translate the HTTP cursor into the file-offset options the reader understands. */
function historyQueryOf(request: FastifyRequest): HistoryQuery | { error: string } {
  const query = queryOf(request);
  const rawLimit = query.get("limit");
  const limit = rawLimit === null ? HISTORY_PAGE_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_MAX_LIMIT) {
    return { error: `limit must be between 1 and ${HISTORY_MAX_LIMIT}` };
  }
  const rawCursor = query.get("cursor");
  if (rawCursor === null) return { limit };
  const offset = decodeHistoryCursor(rawCursor);
  if (offset === undefined) return { error: "invalid history cursor" };
  const direction = query.get("direction") ?? "older";
  if (direction === "newer") return { limit, after: offset };
  if (direction === "older") return { limit, before: offset };
  return { error: "direction must be older or newer" };
}

async function historyFileFor(sessionId: string): Promise<string | null> {
  const live = getSession(sessionId);
  return live?.sessionFile || (await resolveSessionFile(sessionId)) || null;
}

async function handleAgentHistory(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sessionId = paramOf(request, "id");
  const file = await historyFileFor(sessionId);
  if (!file) {
    asJson(reply, 404, { error: "Session not found" });
    return;
  }
  const parsedQuery = historyQueryOf(request);
  if ("error" in parsedQuery) {
    asJson(reply, 400, { error: parsedQuery.error });
    return;
  }
  const history = await readHistoryPage(file, parsedQuery);
  const host = getPluginHost();
  let entries = history.entries;
  if (host !== null && host.hooks.handlersFor("message.before-render-model").length > 0) {
    const transformed: typeof entries = [];
    for (const entry of entries) {
      const next = await host.hooks.waterfall("message.before-render-model", entry, { sessionId });
      transformed.push(
        typeof next === "object" && next !== null && "role" in next && Array.isArray((next as { blocks?: unknown }).blocks)
          ? (next as (typeof entries)[number])
          : entry,
      );
    }
    entries = transformed;
  }
  asJson(reply, 200, {
    sessionId,
    entries,
    toolResults: toWireToolResults(history.toolResults),
    olderCursor: history.olderCursor,
    newerCursor: history.newerCursor,
    hasOlder: history.hasOlder,
  });
}

/** One tool result in full, for an expanded tool call whose images the history left out. */
async function handleAgentToolResult(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sessionId = paramOf(request, "id");
  const file = await historyFileFor(sessionId);
  if (!file) {
    asJson(reply, 404, { error: "Session not found" });
    return;
  }
  const result = (await readHistoryCached(file)).toolResults[paramOf(request, "toolCallId")];
  if (result === undefined) {
    asJson(reply, 404, { error: "Tool result not found" });
    return;
  }
  asJson(reply, 200, result);
}

async function handleAgentCommands(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sessionId = paramOf(request, "id");
  // Live sessions only — a disk-only session has no process to dispatch a
  // command, and resuming one just to list them is a heavy side effect.
  const core = getSession(sessionId)?.core;
  if (core === undefined) {
    asJson(reply, 404, { error: "Session not found" });
    return;
  }
  const builtins = annotateBuiltinCommands(await piBuiltinCommands());
  asJson(reply, 200, { sessionId, commands: [...builtins, ...(core.getCommands?.() ?? [])] });
}

async function handleAgentTree(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sessionId = paramOf(request, "id");
  const core = getSession(sessionId)?.core;
  if (core === undefined) {
    asJson(reply, 404, { error: "Session not found" });
    return;
  }
  const nodes = core.getTreeNodes?.() ?? null;
  if (nodes === null) {
    asJson(reply, 404, { error: "Tree not posted yet" });
    return;
  }
  asJson(reply, 200, { sessionId, nodes });
}

async function handleAgentModels(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sessionId = paramOf(request, "id");
  const handle = getSession(sessionId);
  const core = handle?.core;
  if (core === undefined) {
    asJson(reply, 404, { error: "Session not found" });
    return;
  }
  let catalog = core.getModels?.() ?? { models: [] };
  const host = getPluginHost();
  const pickerService = host?.services.resolve<(base: typeof catalog, info: { sessionId: string; cwd: string }) => typeof catalog | Promise<typeof catalog>>("model.pick");
  if (pickerService !== undefined) {
    const overridden = await pickerService(catalog, { sessionId, cwd: handle?.cwd ?? "" });
    if (overridden && Array.isArray(overridden.models)) catalog = overridden;
  }
  asJson(reply, 200, { sessionId, ...catalog });
}

async function handleAgentSetModel(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sessionId = paramOf(request, "id");
  const core = getSession(sessionId)?.core;
  if (core === undefined || core.setModel === undefined) {
    asJson(reply, 404, { error: "Session not found" });
    return;
  }
  let requestedModel: { provider: unknown; id: unknown } | undefined;
  try {
    const body = bodyOf(request) as { provider: string; id: string };
    requestedModel = { provider: body.provider, id: body.id };
    if (request.validationError) {
      asJson(reply, 400, { error: "provider and id are required" });
      return;
    }
    const applied = await core.setModel(body.provider, body.id);
    if (!applied) {
      asJson(reply, 400, { error: "model not available in this session" });
      return;
    }
    asJson(reply, 200, { ok: true });
  } catch (error) {
    request.log.warn({ err: error, sessionId, model: requestedModel }, "session model change failed");
    asJson(reply, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleAgentSetThinking(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sessionId = paramOf(request, "id");
  const core = getSession(sessionId)?.core;
  if (core === undefined || core.setThinkingLevel === undefined) {
    asJson(reply, 404, { error: "Session not found" });
    return;
  }
  let requestedLevel: unknown;
  try {
    const body = bodyOf(request) as { level: string };
    requestedLevel = body.level;
    if (request.validationError) {
      asJson(reply, 400, { error: "level is required" });
      return;
    }
    const applied = await core.setThinkingLevel(body.level);
    if (!applied) {
      asJson(reply, 400, { error: "thinking level rejected" });
      return;
    }
    asJson(reply, 200, { ok: true });
  } catch (error) {
    request.log.warn({ err: error, sessionId, level: requestedLevel }, "session thinking-level change failed");
    asJson(reply, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleAgentBranch(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sessionId = paramOf(request, "id");
  // The branch of the directory the session runs in. A directory that is not a
  // worktree (or has no git) answers null rather than failing the line.
  const core = await ensureSession(sessionId);
  const cwd = core === null ? undefined : getSession(sessionId)?.cwd;
  if (cwd === undefined) {
    asJson(reply, 404, { error: "Session not found" });
    return;
  }
  asJson(reply, 200, { branch: await gitBranch(cwd) });
}

async function handleChangelog(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // The web port of /changelog: the installed pi package's changelog, rendered
  // client-side. The package exports do not expose the file, so resolve the
  // entry and walk up to the package root.
  try {
    const { dirname: dirnameOf, join: joinPath } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    let dir = dirnameOf(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
    let changelogPath: string | null = null;
    for (let i = 0; i < 3 && dir !== "/"; i++) {
      dir = dirnameOf(dir);
      const candidate = joinPath(dir, "CHANGELOG.md");
      if (existsSync(candidate)) {
        changelogPath = candidate;
        break;
      }
    }
    if (changelogPath === null) throw new Error("CHANGELOG.md not found next to the package");
    const content = await readFile(changelogPath, "utf8");
    asJson(reply, 200, { markdown: content.slice(0, 512_000) });
  } catch (error) {
    request.log.warn({ err: error }, "changelog could not be read");
    asJson(reply, 404, { error: "changelog not found" });
  }
}

async function handleAgent(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sessionId = paramOf(request, "id");
  try {
    if (request.method === "GET") {
      const core = await ensureSession(sessionId);
      if (core === null) {
        asJson(reply, 404, { error: "Session not found" });
        return;
      }
      asJson(reply, 200, { running: true, state: core.getState() });
      return;
    }
    const body = bodyOf(request);
    const parsed = parseSessionCommand(body);
    if ("error" in parsed) {
      asJson(reply, 400, { error: parsed.error });
      return;
    }
    const core = await ensureSession(sessionId);
    if (core === null) {
      asJson(reply, 404, { error: "Session not found" });
      return;
    }
    const result = await sendCommand(sessionId, parsed);
    if (result.status === "ok") {
      asJson(reply, 200, { success: true, data: result.data });
    } else if (result.status === "not_found") {
      asJson(reply, 404, { error: "Session not found" });
    } else {
      request.log.error({ err: new Error(result.error), sessionId }, "agent command failed");
      asJson(reply, 500, { error: result.error });
    }
  } catch (error) {
    request.log.error({ err: error, sessionId }, "agent command threw");
    asJson(reply, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

// ── The route table ─────────────────────────────────────────────────────────
// Fastify resolves the path (static beats param); the per-path dispatcher only
// picks the method, so no ordering is required and `/api/agent/new` wins over
// `/api/agent/:id` by specificity rather than table position.

const CORE_ROUTES: readonly CoreRoute[] = [
  { path: "/api/health", methods: { GET: handleHealth } },
  { path: "/api/reload-state", methods: { GET: handleReloadState } },
  { path: "/api/reload-notice", methods: { POST: handleReloadNotice } },
  { path: "/api/client/log", methods: { POST: handleClientLog }, body: CLIENT_LOG_BODY_SCHEMA },
  { path: "/api/plugins", methods: { GET: handlePluginsList } },
  { path: "/api/plugin-manager", methods: { GET: handlePluginManagerReport } },
  { path: "/api/plugin-manager/:id/:command", methods: { POST: handlePluginManagerCommand } },
  { path: "/api/plugins/action", methods: { POST: handlePluginAction }, body: ACTION_BODY_SCHEMA },
  { path: "/api/bridge/:id/attach", methods: { GET: handleBridgeAttach }, sse: { ...SSE_ROUTE_OPTIONS, heartbeat: true } },
  { path: "/api/bridge/:id/events", methods: { POST: handleBridgeEvents } },
  { path: "/api/bridge/:id/detach", methods: { POST: handleBridgeDetach } },
  { path: "/api/agent/:id/pi_api", methods: { POST: handlePiApi }, body: PI_API_BODY_SCHEMA },
  { path: "/api/agent/:id/protocol", methods: { POST: handleProtocol }, body: PERMISSIVE_BODY_SCHEMA },
  { path: "/api/directories", methods: { GET: handleDirectories }, query: ["path"] },
  { path: "/api/sessions/events", methods: { GET: handleSessionsEvents }, sse: SSE_ROUTE_OPTIONS },
  { path: "/api/sessions", methods: { GET: handleSessionsList }, query: ["q"] },
  { path: "/api/sessions/:id", methods: { DELETE: handleSessionDelete } },
  { path: "/api/agent/new", methods: { POST: handleAgentNew } },
  { path: "/api/agent/:id/events", methods: { GET: handleAgentEvents }, sse: SSE_ROUTE_OPTIONS },
  { path: "/api/agent/:id/history", methods: { GET: handleAgentHistory }, query: ["cursor", "direction", "limit"] },
  { path: "/api/agent/:id/tool-results/:toolCallId", methods: { GET: handleAgentToolResult } },
  { path: "/api/agent/:id/commands", methods: { GET: handleAgentCommands } },
  { path: "/api/agent/:id/tree", methods: { GET: handleAgentTree } },
  { path: "/api/agent/:id/models", methods: { GET: handleAgentModels } },
  { path: "/api/agent/:id/model", methods: { POST: handleAgentSetModel }, body: MODEL_BODY_SCHEMA },
  { path: "/api/agent/:id/thinking", methods: { POST: handleAgentSetThinking }, body: THINKING_BODY_SCHEMA },
  { path: "/api/agent/:id/branch", methods: { GET: handleAgentBranch } },
  { path: "/api/changelog", methods: { GET: handleChangelog } },
  { path: "/api/agent/:id", methods: { GET: handleAgent, POST: handleAgent }, body: SESSION_COMMAND_SCHEMA },
];

/**
 * Register the core API as native Fastify routes.
 *
 * The body parser is scoped to this plugin so it cannot change another route's
 * error ordering: parse once before schemas, independently of Content-Type;
 * use `{}` for empty input and let handlers map malformed JSON at their
 * established decision point via attachValidation/parsedJsonBody.
 */
export async function registerCoreRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    registerLenientJsonParser(scope);
    scope.addHook("onRequest", async (request, reply) => {
      if (!isDraining()) return;
      // Health has its own draining answer; the reload notice is the one
      // write still allowed while the supervisor tells open pages to wait.
      if (request.url === "/api/health" || request.url === "/api/reload-notice") return;
      asJson(reply, 503, { error: "server is restarting" });
      return reply;
    });
    for (const route of CORE_ROUTES) {
      for (const [method, handler] of Object.entries(route.methods)) {
        scope.route({
          method: method as HttpMethod, url: route.path, sse: route.sse,
          attachValidation: true,
          schema: coreRequestSchema({ path: route.path, query: route.query, ...(method === "POST" ? { body: route.body ?? PERMISSIVE_BODY_SCHEMA } : {}) }),
          handler,
        });
      }
      registerMethodFallback(scope, {
        path: route.path, methods: Object.keys(route.methods),
        refuse: async (_request, reply) => { asJson(reply, 405, { error: "method not allowed" }); },
      });
    }
  });
}
