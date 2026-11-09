// Minimal pi-web server — static client assets, the plugin registry API,
// and the session core routes (list, new, events SSE, commands, history)
// per docs/prds/minimal-pi-web.md.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname, resolve, sep } from "node:path";
import { WEB_PLUGINS } from "../../web-plugins/index.ts";
import {
  ensureSession,
  getSession,
  listDiskSessions,
  listLiveSessions,
  parseSessionCommand,
  readHistory,
  resolveSessionFile,
  sendCommand,
  startSession,
} from "./sessions.ts";
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
const MAX_BODY_BYTES = 1_000_000;

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
    sendJson(res, 200, { plugins: WEB_PLUGINS });
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
    const entries = await readHistory(file);
    sendJson(res, 200, { sessionId: id, entries });
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
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

async function main(): Promise<void> {
  const handle = await startWebServer();
  console.log(`[pi-web-minimal] listening on http://${handle.host}:${handle.port}`);
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  void main();
}
