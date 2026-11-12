// The web server's API route table: one declarative entry per route, in
// evaluation order. Adding a route is adding an entry + a handler — no
// branching inside a monolithic dispatcher. Order matters only where a
// path is also a prefix of another (e.g. `/api/agent/new` before the
// generic `/api/agent/:id`, and every `/api/agent/:id/<suffix>` route
// before `/api/agent/:id` itself).

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { attachBridge, getBridge, type BridgeState } from "./bridge.ts";
import {
  checkAndSetInFlightAction,
  getPluginDescriptor,
  getRegisteredPlugins,
  isKnownSession,
  recordActionAudit,
  relayActionRequest,
  webPluginsStore,
} from "./plugin-host.ts";
import {
  ensureSession,
  getSession,
  listDiskSessions,
  listLiveSessions,
  parseSessionCommand,
  readHistory,
  resolveSessionFile,
  resolveSessionRoot,
  sendCommand,
  startSession,
} from "./sessions.ts";
import { handlePiApiRequest } from "./pi-api.ts";
import { piBuiltinCommands } from "../../../lib/web-pi-apis/index.ts";
import { annotateBuiltinCommands } from "../shared/commands.ts";
import { attachAgentEventStream, attachSessionsEventStream } from "./event-stream.ts";
import { listDirectory, readText, searchPaths, statusForCode, streamFile, type FileFailure } from "./files.ts";
import { readJsonBody, sendJson } from "./http.ts";

type HttpMethod = "GET" | "POST";

interface RouteMatch {
  /** The session id captured from the path's id segment, decoded. */
  param: string;
}

interface ApiRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** Empty for exact-path routes; the decoded session id for id-capturing routes. */
  param: string;
}

interface ApiRoute {
  /** Exact pathname, or a RegExp whose first capture group is the session id. */
  match: string | RegExp;
  methods: readonly HttpMethod[];
  handle: (ctx: ApiRouteContext) => Promise<void>;
}

function matchRoute(match: string | RegExp, pathname: string): RouteMatch | null {
  if (typeof match === "string") return match === pathname ? { param: "" } : null;
  const captured = match.exec(pathname);
  if (captured === null) return null;
  return { param: decodeURIComponent(captured[1] ?? "") };
}

/**
 * The core-name routes `/api/agent/:id/<suffix>` share this id-capturing
 * regex; the generic `/api/agent/:id` route closes the list.
 */
const id = "[^/]+";

// ── Handlers ────────────────────────────────────────────────────────────────

async function handleHealth(ctx: ApiRouteContext): Promise<void> {
  sendJson(ctx.res, 200, { ok: true, service: "pi-web-minimal" });
}

async function handlePluginsList(ctx: ApiRouteContext): Promise<void> {
  sendJson(ctx.res, 200, { plugins: getRegisteredPlugins() });
}

/**
 * POST /api/plugins/action — ported from the vendored app with identical
 * semantics: 404 before anything else, 403 when a declared confirm does not
 * match byte-identically, 409 while another action is in flight for the
 * session, then audit + relay over the session bus.
 */
async function handlePluginAction(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { sessionId?: unknown; pluginId?: unknown; actionId?: unknown; confirm?: unknown };
  try {
    body = (await readJsonBody(req)) as typeof body;
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }
  const { sessionId, pluginId, actionId, confirm } = body ?? {};

  // 1. Validate: sessionId/pluginId/actionId known (404 before anything else).
  if (typeof sessionId !== "string" || !isKnownSession(sessionId)) {
    sendJson(res, 404, { error: "Session not found" });
    return;
  }
  if (typeof pluginId !== "string") {
    sendJson(res, 404, { error: "Plugin not found" });
    return;
  }
  // The web core channel: the bridge's own built-in pickers. Its action
  // ids are dynamic (session entries: "fork@<entryId>"), so the extension
  // that published the picker is the validator — the static descriptor
  // registry is for external plugins. The in-flight guard and audit below
  // still apply.
  const isWebCore = pluginId === "web-core";
  const descriptor = isWebCore ? undefined : getPluginDescriptor(pluginId);
  if (!isWebCore && !descriptor) {
    sendJson(res, 404, { error: "Plugin not found" });
    return;
  }
  if (typeof actionId !== "string") {
    sendJson(res, 404, { error: "Action not found" });
    return;
  }
  const action = descriptor?.actions?.find((candidate) => candidate.id === actionId);
  if (!isWebCore && !action) {
    sendJson(res, 404, { error: "Action not found" });
    return;
  }

  // 2. A declared confirm must match byte-identically (403, nothing emitted).
  //    An action without a declared confirm is the instant form: it submits
  //    without a typed string. The web core channel has no declared
  //    confirms — its picks are instant.
  if (action?.confirm !== undefined && (typeof confirm !== "string" || confirm !== action.confirm)) {
    sendJson(res, 403, { error: "Invalid confirmation string" });
    return;
  }

  // 3. At most one in-flight CONFIRMED action per session, held for 60 s
  //    (409). Instant actions (no declared confirm) and the web core
  //    channel are exempt: both are fire-and-forget dispatches, so a lock
  //    here would refuse the next click — the exact failure behind rapid
  //    Normal↔Plan toggling. Confirmed actions stay locked to stop a
  //    cost-intense re-submission while the first is still processing.
  const requestId = randomUUID();
  if (action?.confirm !== undefined && !checkAndSetInFlightAction(sessionId, requestId, 60_000)) {
    sendJson(res, 409, { error: "Action already in flight for this session" });
    return;
  }

  // 4. Audit, then relay to the owning extension over the session event bus.
  recordActionAudit({ requestId, sessionId, pluginId, actionId, timestamp: Date.now() });
  if (isWebCore) {
    // The picker closes here, server-side: the picked action's side effect
    // (a fork, a tree navigation) can switch the pi's session and rebind
    // its poster before the extension's own queued open:false flushes —
    // this close is immediate and race-free. The relay still notifies the
    // extension (the TUI-side dialog close).
    webPluginsStore.recordView(sessionId, "web-core", { type: "dialog", open: false });
  }
  const { relayed } = relayActionRequest(sessionId, pluginId, actionId, requestId);
  sendJson(res, 200, { ok: true, requestId, relayed });
}

async function handleBridgeAttach(ctx: ApiRouteContext): Promise<void> {
  const { req, res, url, param: sessionId } = ctx;
  const modelParam = url.searchParams.get("model");
  const modelSlash = modelParam !== null ? modelParam.indexOf("/") : -1;
  attachBridge({
    req,
    res,
    metadata: {
      sessionId,
      cwd: url.searchParams.get("cwd") ?? process.cwd(),
      sessionFile: url.searchParams.get("sessionFile") ?? undefined,
      model: modelSlash > 0 && modelParam !== null
        ? { provider: modelParam.slice(0, modelSlash), id: modelParam.slice(modelSlash + 1) }
        : undefined,
      thinkingLevel: url.searchParams.get("thinkingLevel") ?? undefined,
    },
  });
}

async function handleBridgeEvents(ctx: ApiRouteContext): Promise<void> {
  const { req, res, param: sessionId } = ctx;
  const bridge = getBridge(sessionId);
  if (bridge === undefined) {
    sendJson(res, 404, { error: "Bridge not attached" });
    return;
  }
  try {
    const body = (await readJsonBody(req)) as {
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
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleBridgeDetach(ctx: ApiRouteContext): Promise<void> {
  const { res, param: sessionId } = ctx;
  const bridge = getBridge(sessionId);
  if (bridge === undefined) {
    sendJson(res, 404, { error: "Bridge not attached" });
    return;
  }
  bridge.close();
  sendJson(res, 200, { ok: true });
}

async function handlePiApi(ctx: ApiRouteContext): Promise<void> {
  const { req, res, param: sessionId } = ctx;
  const handle = getSession(sessionId);
  if (handle === undefined) {
    sendJson(res, 404, { error: "Session not found" });
    return;
  }
  const body = await readJsonBody(req);
  const outcome = await handlePiApiRequest(handle.cwd, body);
  sendJson(res, outcome.status, outcome.body);
}

async function handleDirectories(ctx: ApiRouteContext): Promise<void> {
  const { res, url } = ctx;
  // The new-session picker: subdirectories of a path (hidden dirs skipped,
  // capped) plus the parent for navigation. A bad path is a 400, not an
  // error — the picker shows it inline.
  const requested = url.searchParams.get("path") ?? "";
  let dir: string;
  try {
    dir = resolve(requested === "" ? process.cwd() : requested);
  } catch {
    sendJson(res, 400, { error: "invalid path" });
    return;
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    sendJson(res, 400, { error: `not a directory: ${dir}` });
    return;
  }
  let dirents: Array<{ isDirectory: () => boolean; name: string }>;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const entries = dirents
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: join(dir, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 500);
  const parent = dirname(dir);
  sendJson(res, 200, {
    path: dir,
    parent: parent === dir ? null : parent,
    entries,
  });
}

async function handleSessionsEvents(ctx: ApiRouteContext): Promise<void> {
  attachSessionsEventStream(ctx.req, ctx.res);
}

async function handleSessionsList(ctx: ApiRouteContext): Promise<void> {
  const live = listLiveSessions();
  const liveIds = new Set(live.map((session) => session.id));
  const disk = await listDiskSessions();
  const sessions = [
    ...live,
    ...disk
      .filter((session) => !liveIds.has(session.id))
      .map((session) => ({
        id: session.id,
        cwd: session.cwd,
        sessionFile: session.file,
        live: false,
        running: false,
        modifiedAt: session.modifiedAt,
        ...(session.name !== undefined ? { name: session.name } : {}),
      })),
  ];
  sendJson(ctx.res, 200, { sessions });
}

async function handleAgentNew(ctx: ApiRouteContext): Promise<void> {
  const { req, res } = ctx;
  try {
    const body = (await readJsonBody(req)) as { cwd?: unknown };
    const cwd = typeof body.cwd === "string" && body.cwd.trim() !== ""
      ? resolve(body.cwd)
      : process.cwd();
    if (!existsSync(cwd)) {
      sendJson(res, 400, { error: `cwd does not exist: ${cwd}` });
      return;
    }
    const core = await startSession({ cwd });
    sendJson(res, 200, { sessionId: core.sessionId, cwd });
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleAgentEvents(ctx: ApiRouteContext): Promise<void> {
  const { req, res, param: sessionId } = ctx;
  const sessionPromise = ensureSession(sessionId);
  attachAgentEventStream(req, res, sessionId, sessionPromise);
}

async function handleAgentHistory(ctx: ApiRouteContext): Promise<void> {
  const { res, param: sessionId } = ctx;
  const live = getSession(sessionId);
  const file = live?.sessionFile || (await resolveSessionFile(sessionId));
  if (!file) {
    sendJson(res, 404, { error: "Session not found" });
    return;
  }
  const history = await readHistory(file);
  sendJson(res, 200, { sessionId, entries: history.entries, toolResults: history.toolResults });
}

async function handleAgentCommands(ctx: ApiRouteContext): Promise<void> {
  const { res, param: sessionId } = ctx;
  // Live sessions only — a disk-only session has no process to dispatch
  // a command, and resuming one just to list them is a heavy side effect.
  const core = getSession(sessionId)?.core;
  if (core === undefined) {
    sendJson(res, 404, { error: "Session not found" });
    return;
  }
  // pi's built-in list at runtime (BUILTIN_SLASH_COMMANDS via the
  // pi_api facade) annotated with the web's presentation flags, then the
  // session's live commands (extension/prompt/skill + web core registry).
  const builtins = annotateBuiltinCommands(await piBuiltinCommands());
  sendJson(res, 200, { sessionId, commands: [...builtins, ...(core.getCommands?.() ?? [])] });
}

async function handleAgentTree(ctx: ApiRouteContext): Promise<void> {
  const { res, param: sessionId } = ctx;
  const core = getSession(sessionId)?.core;
  if (core === undefined) {
    sendJson(res, 404, { error: "Session not found" });
    return;
  }
  // pi's tree, projected for the web picker; the extension posts it for
  // bridged sessions (web_tree), the server builds it in-process.
  const nodes = core.getTreeNodes?.() ?? null;
  if (nodes === null) {
    sendJson(res, 404, { error: "Tree not posted yet" });
    return;
  }
  sendJson(res, 200, { sessionId, nodes });
}

async function handleAgentModels(ctx: ApiRouteContext): Promise<void> {
  const { res, param: sessionId } = ctx;
  const core = getSession(sessionId)?.core;
  if (core === undefined) {
    sendJson(res, 404, { error: "Session not found" });
    return;
  }
  sendJson(res, 200, { sessionId, ...(core.getModels?.() ?? { models: [] }) });
}

async function handleAgentSetModel(ctx: ApiRouteContext): Promise<void> {
  const { req, res, param: sessionId } = ctx;
  const core = getSession(sessionId)?.core;
  if (core === undefined || core.setModel === undefined) {
    sendJson(res, 404, { error: "Session not found" });
    return;
  }
  try {
    const body = (await readJsonBody(req)) as { provider?: unknown; id?: unknown };
    if (typeof body.provider !== "string" || typeof body.id !== "string") {
      sendJson(res, 400, { error: "provider and id are required" });
      return;
    }
    const applied = await core.setModel(body.provider, body.id);
    if (!applied) {
      sendJson(res, 400, { error: "model not available in this session" });
      return;
    }
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleAgentSetThinking(ctx: ApiRouteContext): Promise<void> {
  const { req, res, param: sessionId } = ctx;
  const core = getSession(sessionId)?.core;
  if (core === undefined || core.setThinkingLevel === undefined) {
    sendJson(res, 404, { error: "Session not found" });
    return;
  }
  try {
    const body = (await readJsonBody(req)) as { level?: unknown };
    if (typeof body.level !== "string") {
      sendJson(res, 400, { error: "level is required" });
      return;
    }
    const applied = await core.setThinkingLevel(body.level);
    if (!applied) {
      sendJson(res, 400, { error: "thinking level rejected" });
      return;
    }
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleChangelog(ctx: ApiRouteContext): Promise<void> {
  const { res } = ctx;
  // The web port of /changelog: the installed pi package's changelog,
  // rendered as a dialog client-side. The package exports do not expose
  // the file, so resolve the entry and walk up to the package root.
  try {
    const { dirname: dirnameOf, join: joinPath } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    // The package exports are ESM-only; import.meta.resolve gives the
    // entry, and the changelog sits at the package root beside dist/.
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
    sendJson(res, 200, { markdown: content.slice(0, 512_000) });
  } catch {
    sendJson(res, 404, { error: "changelog not found" });
  }
}

async function handleAgent(ctx: ApiRouteContext): Promise<void> {
  const { req, res, param: sessionId } = ctx;
  try {
    if (req.method === "GET") {
      const core = await ensureSession(sessionId);
      if (core === null) {
        sendJson(res, 404, { error: "Session not found" });
        return;
      }
      sendJson(res, 200, { running: true, state: core.getState() });
      return;
    }
    const body = await readJsonBody(req);
    const parsed = parseSessionCommand(body);
    if ("error" in parsed) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }
    const core = await ensureSession(sessionId);
    if (core === null) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }
    const result = await sendCommand(sessionId, parsed);
    if (result.status === "ok") {
      sendJson(res, 200, { success: true, data: result.data });
    } else if (result.status === "not_found") {
      sendJson(res, 404, { error: "Session not found" });
    } else {
      sendJson(res, 500, { error: result.error });
    }
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ── Files routes: session-scoped, read-only file browsing and preview ──────
// Each handler resolves the root from the session id and re-validates the path
// server-side (see files.ts); the client never supplies an absolute root.

async function rootForFiles(sessionId: string, res: ServerResponse): Promise<string | null> {
  const root = await resolveSessionRoot(sessionId);
  if (root === null) {
    sendJson(res, 404, { error: "Session not found", code: "unknown_session" });
    return null;
  }
  return root;
}

function sendFileFailure(res: ServerResponse, failure: FileFailure): void {
  sendJson(res, statusForCode(failure.code), { error: failure.message, code: failure.code });
}

async function handleFilesList(ctx: ApiRouteContext): Promise<void> {
  const { res, url, param: sessionId } = ctx;
  const root = await rootForFiles(sessionId, res);
  if (root === null) return;
  const result = await listDirectory(root, url.searchParams.get("path") ?? "", url.searchParams.get("hidden") === "1");
  if (!result.ok) sendFileFailure(res, result);
  else sendJson(res, 200, result);
}

async function handleFilesRead(ctx: ApiRouteContext): Promise<void> {
  const { res, url, param: sessionId } = ctx;
  const root = await rootForFiles(sessionId, res);
  if (root === null) return;
  const result = await readText(root, url.searchParams.get("path") ?? "");
  if (!result.ok) sendFileFailure(res, result);
  else sendJson(res, 200, result);
}

async function handleFilesSearch(ctx: ApiRouteContext): Promise<void> {
  const { res, url, param: sessionId } = ctx;
  const root = await rootForFiles(sessionId, res);
  if (root === null) return;
  const result = await searchPaths(root, url.searchParams.get("q") ?? "");
  if (!result.ok) sendFileFailure(res, result);
  else sendJson(res, 200, result);
}

async function handleFilesDownload(ctx: ApiRouteContext): Promise<void> {
  const { req, res, url, param: sessionId } = ctx;
  const root = await rootForFiles(sessionId, res);
  if (root === null) return;
  await streamFile(req, res, root, url.searchParams.get("path") ?? "", url.searchParams.get("download") === "1");
}

// ── The route table ────────────────────────────────────────────────────────
// Ordered: more specific paths precede the generic `/api/agent/:id`.

const API_ROUTES: readonly ApiRoute[] = [
  { match: "/api/health", methods: ["GET"], handle: handleHealth },
  { match: "/api/plugins", methods: ["GET"], handle: handlePluginsList },
  { match: "/api/plugins/action", methods: ["POST"], handle: ({ req, res }) => handlePluginAction(req, res) },
  { match: /^\/api\/bridge\/([^/]+)\/attach$/, methods: ["GET"], handle: handleBridgeAttach },
  { match: /^\/api\/bridge\/([^/]+)\/events$/, methods: ["POST"], handle: handleBridgeEvents },
  { match: /^\/api\/bridge\/([^/]+)\/detach$/, methods: ["POST"], handle: handleBridgeDetach },
  { match: /^\/api\/agent\/([^/]+)\/pi_api$/, methods: ["POST"], handle: handlePiApi },
  { match: "/api/directories", methods: ["GET"], handle: handleDirectories },
  { match: "/api/sessions/events", methods: ["GET"], handle: handleSessionsEvents },
  { match: "/api/sessions", methods: ["GET"], handle: handleSessionsList },
  { match: "/api/agent/new", methods: ["POST"], handle: handleAgentNew },
  { match: new RegExp(`^/api/agent/(${id})/events$`), methods: ["GET"], handle: handleAgentEvents },
  { match: new RegExp(`^/api/agent/(${id})/history$`), methods: ["GET"], handle: handleAgentHistory },
  { match: new RegExp(`^/api/agent/(${id})/commands$`), methods: ["GET"], handle: handleAgentCommands },
  { match: new RegExp(`^/api/agent/(${id})/tree$`), methods: ["GET"], handle: handleAgentTree },
  { match: new RegExp(`^/api/agent/(${id})/models$`), methods: ["GET"], handle: handleAgentModels },
  { match: new RegExp(`^/api/agent/(${id})/model$`), methods: ["POST"], handle: handleAgentSetModel },
  { match: new RegExp(`^/api/agent/(${id})/thinking$`), methods: ["POST"], handle: handleAgentSetThinking },
  { match: new RegExp(`^/api/agent/(${id})/files$`), methods: ["GET"], handle: handleFilesList },
  { match: new RegExp(`^/api/agent/(${id})/files/read$`), methods: ["GET"], handle: handleFilesRead },
  { match: new RegExp(`^/api/agent/(${id})/files/search$`), methods: ["GET"], handle: handleFilesSearch },
  { match: new RegExp(`^/api/agent/(${id})/files/download$`), methods: ["GET"], handle: handleFilesDownload },
  { match: "/api/changelog", methods: ["GET"], handle: handleChangelog },
  { match: new RegExp(`^/api/agent/(${id})$`), methods: ["GET", "POST"], handle: handleAgent },
];

/**
 * Dispatch an `/api/*` request to the first matching route; answers 405 for
 * a known path with an unsupported method and returns false (caller 404s)
 * when nothing matches.
 */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  for (const route of API_ROUTES) {
    const match = matchRoute(route.match, url.pathname);
    if (match === null) continue;
    if (!route.methods.includes(req.method as HttpMethod)) {
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    await route.handle({ req, res, url, param: match.param });
    return true;
  }
  return false;
}