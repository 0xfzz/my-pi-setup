// Minimal pi-web server — static client assets, the plugin registry API,
// and the session core routes (list, new, events SSE, commands, history)
// per docs/prds/minimal-pi-web.md.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, resolve, sep } from "node:path";
import { attachBridge, getBridge, type BridgeState } from "./bridge.ts";
import {
  checkAndSetInFlightAction,
  getPluginDescriptor,
  getRegisteredPlugins,
  isKnownSession,
  recordActionAudit,
  relayActionRequest,
} from "./plugin-host.ts";
import { webPluginsStore } from "./plugin-host.ts";
import {
  ensureSession,
  getSession,
  listDiskSessions,
  listLiveSessions,
  parseSessionCommand,
  readHistory,
  registerSession,
  resolveSessionFile,
  sendCommand,
  startSession,
} from "./sessions.ts";
import { handlePiApiRequest } from "./pi-api.ts";
import { piBuiltinCommands } from "../../lib/web-pi-apis/index.ts";
import { annotateBuiltinCommands } from "../shared/commands.ts";
import { attachAgentEventStream } from "./event-stream.ts";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const DEFAULT_PORT = Number(process.env.PI_WEB_PORT ?? 30142);
const DEFAULT_HOST = process.env.PI_WEB_HOST ?? "127.0.0.1";
// Prompts can carry base64 images (downscaled client-side, ~6 MB each).
const MAX_BODY_BYTES = 60_000_000;

export interface WebServerHandle {
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

export interface StartWebServerOptions {
  host?: string;
  port?: number;
  clientDist?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/**
 * Resolve a request path to a file inside `root`.
 * Returns null when the path escapes the root or is unsafe.
 */
export function resolveStaticPath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("..") || decoded.includes("\0")) return null;
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

async function serveStatic(res: ServerResponse, root: string, pathname: string): Promise<void> {
  const target = resolveStaticPath(root, pathname);
  if (!target) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  try {
    const data = await readFile(target);
    const type = MIME_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(data);
  } catch {
    // SPA fallback: client-side routes (/plugins/todo, …) have no file behind
    // them; every extension-less GET falls back to the app shell.
    if (!extname(target)) {
      try {
        const index = await readFile(join(root, "index.html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        res.end(index);
        return;
      } catch {
        // Fall through to 404.
      }
    }
    sendJson(res, 404, { error: "not found" });
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown;
}

/**
 * POST /api/plugins/action — ported from the vendored app with identical
 * semantics: 404 before anything else, 403 when a declared confirm does not
 * match byte-identically, 409 while another action is in flight for the
 * session, then audit + relay over the session bus.
 */
async function handlePluginAction(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let body: { sessionId?: unknown; pluginId?: unknown; actionId?: unknown; confirm?: unknown };
  try {
    body = (await readJsonBody(req)) as typeof body;
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return true;
  }
  const { sessionId, pluginId, actionId, confirm } = body ?? {};

  // 1. Validate: sessionId/pluginId/actionId known (404 before anything else).
  if (typeof sessionId !== "string" || !isKnownSession(sessionId)) {
    sendJson(res, 404, { error: "Session not found" });
    return true;
  }
  if (typeof pluginId !== "string") {
    sendJson(res, 404, { error: "Plugin not found" });
    return true;
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
    return true;
  }
  if (typeof actionId !== "string") {
    sendJson(res, 404, { error: "Action not found" });
    return true;
  }
  const action = descriptor?.actions?.find((candidate) => candidate.id === actionId);
  if (!isWebCore && !action) {
    sendJson(res, 404, { error: "Action not found" });
    return true;
  }

  // 2. A declared confirm must match byte-identically (403, nothing emitted).
  //    An action without a declared confirm is the instant form: it submits
  //    without a typed string. The web core channel has no declared
  //    confirms — its picks are instant.
  if (action?.confirm !== undefined && (typeof confirm !== "string" || confirm !== action.confirm)) {
    sendJson(res, 403, { error: "Invalid confirmation string" });
    return true;
  }

  // 3. At most one in-flight action per session held for 60 s (409). The
  //    web core channel is exempt: its picker answers are instant
  //    fire-and-forget dispatches, not long-running plugin actions — a
  //    60 s lock there would block the next picker answer.
  const requestId = randomUUID();
  if (!isWebCore && !checkAndSetInFlightAction(sessionId, requestId, 60_000)) {
    sendJson(res, 409, { error: "Action already in flight for this session" });
    return true;
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
  return true;
}

function sessionIdFromPath(segments: RegExpExecArray): string {
  return decodeURIComponent(segments[1] ?? "");
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const { pathname } = url;
  const methodNotAllowed = (): boolean => {
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  };

  if (pathname === "/api/health") {
    if (req.method !== "GET") return methodNotAllowed();
    sendJson(res, 200, { ok: true, service: "pi-web-minimal" });
    return true;
  }
  if (pathname === "/api/plugins") {
    if (req.method !== "GET") return methodNotAllowed();
    sendJson(res, 200, { plugins: getRegisteredPlugins() });
    return true;
  }
  if (pathname === "/api/plugins/action") {
    if (req.method !== "POST") return methodNotAllowed();
    return handlePluginAction(req, res);
  }

  // The session bridge: a live TUI-owned session attaches here.
  const bridgeAttachMatch = /^\/api\/bridge\/([^/]+)\/attach$/.exec(pathname);
  if (bridgeAttachMatch !== null) {
    if (req.method !== "GET") return methodNotAllowed();
    const id = sessionIdFromPath(bridgeAttachMatch);
    const modelParam = url.searchParams.get("model");
    const modelSlash = modelParam !== null ? modelParam.indexOf("/") : -1;
    attachBridge({
      req,
      res,
      metadata: {
        sessionId: id,
        cwd: url.searchParams.get("cwd") ?? process.cwd(),
        sessionFile: url.searchParams.get("sessionFile") ?? undefined,
        model: modelSlash > 0 && modelParam !== null
          ? { provider: modelParam.slice(0, modelSlash), id: modelParam.slice(modelSlash + 1) }
          : undefined,
        thinkingLevel: url.searchParams.get("thinkingLevel") ?? undefined,
      },
    });
    return true;
  }

  const bridgeEventsMatch = /^\/api\/bridge\/([^/]+)\/events$/.exec(pathname);
  if (bridgeEventsMatch !== null) {
    if (req.method !== "POST") return methodNotAllowed();
    const id = sessionIdFromPath(bridgeEventsMatch);
    const bridge = getBridge(id);
    if (bridge === undefined) {
      sendJson(res, 404, { error: "Bridge not attached" });
      return true;
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
    return true;
  }

  const bridgeDetachMatch = /^\/api\/bridge\/([^/]+)\/detach$/.exec(pathname);
  if (bridgeDetachMatch !== null) {
    if (req.method !== "POST") return methodNotAllowed();
    const id = sessionIdFromPath(bridgeDetachMatch);
    const bridge = getBridge(id);
    if (bridge === undefined) {
      sendJson(res, 404, { error: "Bridge not attached" });
      return true;
    }
    bridge.close();
    sendJson(res, 200, { ok: true });
    return true;
  }
  const piApiMatch = /^\/api\/agent\/([^/]+)\/pi_api$/.exec(pathname);
  if (piApiMatch !== null) {
    if (req.method !== "POST") return methodNotAllowed();
    const id = sessionIdFromPath(piApiMatch);
    const handle = getSession(id);
    if (handle === undefined) {
      sendJson(res, 404, { error: "Session not found" });
      return true;
    }
    const body = await readJsonBody(req);
    const outcome = await handlePiApiRequest(handle.cwd, body);
    sendJson(res, outcome.status, outcome.body);
    return true;
  }

  if (pathname === "/api/directories") {
    if (req.method !== "GET") return methodNotAllowed();
    // The new-session picker: subdirectories of a path (hidden dirs skipped,
    // capped) plus the parent for navigation. A bad path is a 400, not an
    // error — the picker shows it inline.
    const requested = url.searchParams.get("path") ?? "";
    let dir: string;
    try {
      dir = resolve(requested === "" ? process.cwd() : requested);
    } catch {
      sendJson(res, 400, { error: "invalid path" });
      return true;
    }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      sendJson(res, 400, { error: `not a directory: ${dir}` });
      return true;
    }
    let dirents: Array<{ isDirectory: () => boolean; name: string }>;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      return true;
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
    return true;
  }
  if (pathname === "/api/sessions") {
    if (req.method !== "GET") return methodNotAllowed();
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
        })),
    ];
    sendJson(res, 200, { sessions });
    return true;
  }
  if (pathname === "/api/agent/new") {
    if (req.method !== "POST") return methodNotAllowed();
    try {
      const body = (await readJsonBody(req)) as { cwd?: unknown };
      const cwd = typeof body.cwd === "string" && body.cwd.trim() !== ""
        ? resolve(body.cwd)
        : process.cwd();
      if (!existsSync(cwd)) {
        sendJson(res, 400, { error: `cwd does not exist: ${cwd}` });
        return true;
      }
      const core = await startSession({ cwd });
      sendJson(res, 200, { sessionId: core.sessionId, cwd });
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  const eventsMatch = /^\/api\/agent\/([^/]+)\/events$/.exec(pathname);
  if (eventsMatch !== null) {
    if (req.method !== "GET") return methodNotAllowed();
    const id = sessionIdFromPath(eventsMatch);
    const sessionPromise = ensureSession(id);
    attachAgentEventStream(req, res, id, sessionPromise);
    return true;
  }

  const historyMatch = /^\/api\/agent\/([^/]+)\/history$/.exec(pathname);
  if (historyMatch !== null) {
    if (req.method !== "GET") return methodNotAllowed();
    const id = sessionIdFromPath(historyMatch);
    const live = getSession(id);
    const file = live?.sessionFile || (await resolveSessionFile(id));
    if (!file) {
      sendJson(res, 404, { error: "Session not found" });
      return true;
    }
    const history = await readHistory(file);
    sendJson(res, 200, { sessionId: id, entries: history.entries, toolResults: history.toolResults });
    return true;
  }

  const commandsMatch = /^\/api\/agent\/([^/]+)\/commands$/.exec(pathname);
  if (commandsMatch !== null) {
    if (req.method !== "GET") return methodNotAllowed();
    const id = sessionIdFromPath(commandsMatch);
    // Live sessions only — a disk-only session has no process to dispatch
    // a command, and resuming one just to list them is a heavy side effect.
    const core = getSession(id)?.core;
    if (core === undefined) {
      sendJson(res, 404, { error: "Session not found" });
      return true;
    }
    // pi's built-in list at runtime (BUILTIN_SLASH_COMMANDS via the
    // pi_api facade) annotated with the web's presentation flags, then the
    // session's live commands (extension/prompt/skill + web core registry).
    const builtins = annotateBuiltinCommands(await piBuiltinCommands());
    sendJson(res, 200, { sessionId: id, commands: [...builtins, ...(core.getCommands?.() ?? [])] });
    return true;
  }

  const treeMatch = /^\/api\/agent\/([^/]+)\/tree$/.exec(pathname);
  if (treeMatch !== null) {
    if (req.method !== "GET") return methodNotAllowed();
    const id = sessionIdFromPath(treeMatch);
    const core = getSession(id)?.core;
    if (core === undefined) {
      sendJson(res, 404, { error: "Session not found" });
      return true;
    }
    // pi's tree, projected for the web picker; the extension posts it for
    // bridged sessions (web_tree), the server builds it in-process.
    const nodes = core.getTreeNodes?.() ?? null;
    if (nodes === null) {
      sendJson(res, 404, { error: "Tree not posted yet" });
      return true;
    }
    sendJson(res, 200, { sessionId: id, nodes });
    return true;
  }

  const modelsMatch = /^\/api\/agent\/([^/]+)\/models$/.exec(pathname);
  if (modelsMatch !== null) {
    if (req.method !== "GET") return methodNotAllowed();
    const id = sessionIdFromPath(modelsMatch);
    const core = getSession(id)?.core;
    if (core === undefined) {
      sendJson(res, 404, { error: "Session not found" });
      return true;
    }
    sendJson(res, 200, { sessionId: id, ...(core.getModels?.() ?? { models: [] }) });
    return true;
  }

  const setModelMatch = /^\/api\/agent\/([^/]+)\/model$/.exec(pathname);
  if (setModelMatch !== null) {
    if (req.method !== "POST") return methodNotAllowed();
    const id = sessionIdFromPath(setModelMatch);
    const core = getSession(id)?.core;
    if (core === undefined || core.setModel === undefined) {
      sendJson(res, 404, { error: "Session not found" });
      return true;
    }
    try {
      const body = (await readJsonBody(req)) as { provider?: unknown; id?: unknown };
      if (typeof body.provider !== "string" || typeof body.id !== "string") {
        sendJson(res, 400, { error: "provider and id are required" });
        return true;
      }
      const applied = await core.setModel(body.provider, body.id);
      if (!applied) {
        sendJson(res, 400, { error: "model not available in this session" });
        return true;
      }
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  const setThinkingMatch = /^\/api\/agent\/([^/]+)\/thinking$/.exec(pathname);
  if (setThinkingMatch !== null) {
    if (req.method !== "POST") return methodNotAllowed();
    const id = sessionIdFromPath(setThinkingMatch);
    const core = getSession(id)?.core;
    if (core === undefined || core.setThinkingLevel === undefined) {
      sendJson(res, 404, { error: "Session not found" });
      return true;
    }
    try {
      const body = (await readJsonBody(req)) as { level?: unknown };
      if (typeof body.level !== "string") {
        sendJson(res, 400, { error: "level is required" });
        return true;
      }
      const applied = await core.setThinkingLevel(body.level);
      if (!applied) {
        sendJson(res, 400, { error: "thinking level rejected" });
        return true;
      }
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (pathname === "/api/changelog") {
    // The web port of /changelog: the installed pi package's changelog,
    // rendered as a dialog client-side. The package exports do not expose
    // the file, so resolve the entry and walk up to the package root.
    if (req.method !== "GET") return methodNotAllowed();
    try {
      const { dirname, join } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      // The package exports are ESM-only; import.meta.resolve gives the
      // entry, and the changelog sits at the package root beside dist/.
      let dir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
      let changelogPath: string | null = null;
      for (let i = 0; i < 3 && dir !== "/"; i++) {
        dir = dirname(dir);
        const candidate = join(dir, "CHANGELOG.md");
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
    return true;
  }

  const agentMatch = /^\/api\/agent\/([^/]+)$/.exec(pathname);
  if (agentMatch !== null) {
    if (req.method !== "POST" && req.method !== "GET") return methodNotAllowed();
    const id = sessionIdFromPath(agentMatch);
    try {
      if (req.method === "GET") {
        const core = await ensureSession(id);
        if (core === null) {
          sendJson(res, 404, { error: "Session not found" });
          return true;
        }
        sendJson(res, 200, { running: true, state: core.getState() });
        return true;
      }
      const body = await readJsonBody(req);
      const parsed = parseSessionCommand(body);
      if ("error" in parsed) {
        sendJson(res, 400, { error: parsed.error });
        return true;
      }
      const core = await ensureSession(id);
      if (core === null) {
        sendJson(res, 404, { error: "Session not found" });
        return true;
      }
      const result = await sendCommand(id, parsed);
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
    return true;
  }

  return false;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (pathnameIsApi(url.pathname)) {
      const handled = await handleApi(req, res, url);
      if (handled) return;
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (req.method === "GET") {
      await serveStatic(res, root, url.pathname);
      return;
    }
    sendJson(res, 405, { error: "method not allowed" });
  } catch {
    if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    else res.end();
  }
}

function pathnameIsApi(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function startWebServer(options: StartWebServerOptions = {}): Promise<WebServerHandle> {
  const root = options.clientDist
    ? resolve(options.clientDist)
    : fileURLToPath(new URL("../client/dist", import.meta.url));
  const host = options.host ?? DEFAULT_HOST;
  const requestedPort = options.port ?? DEFAULT_PORT;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, root);
  });

  return new Promise<WebServerHandle>((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(requestedPort, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : requestedPort;
      resolveStart({
        port,
        host,
        close: () =>
          new Promise<void>((resolveClose) => {
            // SSE streams never end on their own; close() must tear them down
            // or a lingering event stream keeps the server's close callback
            // from ever firing.
            server.closeAllConnections();
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

async function main(): Promise<void> {
  // A stable process title: the /web command's unmanaged-instance cleanup
  // matches it with pkill -f "pi-web-minimal" and nothing else. main() only
  // runs when the server is started directly, so test processes keep theirs.
  process.title = "pi-web-minimal";
  const handle = await startWebServer();
  console.log(`[pi-web-minimal] listening on http://${handle.host}:${handle.port}`);
  if (process.env.PI_WEB_TEST_PLUGIN_VIEWS === "1") {
    registerFixtureSession();
    console.log("[pi-web-minimal] fixture session registered (PI_WEB_TEST_PLUGIN_VIEWS=1)");
  }
}

/**
 * The fixture session for e2e runs (PI_WEB_TEST_PLUGIN_VIEWS=1): a live
 * session core with no real agent behind it. Its plugin views come from the
 * seeded store, its action requests flow through the seeded fixture bus, and
 * a prompt simulates a full agent turn — an assistant message with text and
 * a tool call, the tool execution and result, then a second assistant reply
 * streamed as markdown — emitted with small delays so realtime streaming,
 * collapsible tool calls and markdown rendering are observable in a browser.
 */
function registerFixtureSession(): void {
  const sessionId = "__test_session__";
  let listener: ((event: unknown) => void) | null = null;
  const emit = (event: unknown): void => {
    listener?.(event);
  };
  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  const firstText = "Checking the plans directory first…";
  const finalMarkdown = [
    "## Result",
    "",
    "The plan is **ready**:",
    "",
    "- port the slot adapters",
    "- verify the e2e suite",
    "",
    "```sh",
    "ls plans/",
    "```",
    "",
    "| step | state |",
    "| --- | --- |",
    "| slots | done |",
    "| e2e | pending |",
    "",
    "> verified locally",
    "",
    "All checks passed.",
  ].join("\n");

  const chunks = (text: string, size: number): string[] => {
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += size) {
      parts.push(text.slice(i, i + size));
    }
    return parts;
  };

  const simulateTurn = async (): Promise<void> => {
    emit({ type: "agent_start" });
    // Assistant message 1: text + a tool call.
    emit({ type: "message_start", message: { role: "assistant", content: [] } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    for (const chunk of chunks(firstText, 12)) {
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk } });
      await delay(45);
    }
    emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: firstText } });
    emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "call-1", toolName: "bash" } });
    emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"cmd":"ls plans/"}' } });
    emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: { id: "call-1", name: "bash", arguments: { cmd: "ls plans/" } },
      },
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: firstText },
          { type: "toolCall", toolCallId: "call-1", toolName: "bash", rawInput: '{"cmd":"ls plans/"}' },
        ],
      },
    });
    // The tool executes and returns its result.
    emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash" });
    await delay(150);
    emit({ type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", partialResult: { stdout: "plans.md" } });
    await delay(150);
    emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", isError: false });
    emit({
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: "plans.md" }],
      },
    });
    // Assistant message 2: the markdown reply, streamed.
    emit({ type: "message_start", message: { role: "assistant", content: [] } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    for (const chunk of chunks(finalMarkdown, 24)) {
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk } });
      await delay(35);
    }
    emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: finalMarkdown } });
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalMarkdown }] } });
    emit({ type: "agent_settled" });
  };

  registerSession(
    {
      sessionId,
      subscribe: (next: (event: unknown) => void) => {
        listener = next;
        emit({ type: "agent_start" });
        return () => {
          listener = null;
        };
      },
      prompt: async () => {
        void simulateTurn();
      },
      abort: async () => {},
      isStreaming: () => false,
      getState: () => ({
        sessionId,
        sessionFile: "",
        isStreaming: false,
        isBashRunning: false,
        isCompacting: false,
        model: undefined,
        contextUsage: null,
        thinkingLevel: "off",
      }),
    },
    process.cwd(),
    "",
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  void main();
}
