// Minimal pi-web server — static client assets plus the plugin registry API.
// Phase A skeleton per docs/prds/minimal-pi-web.md; the session core and
// plugin host land in later phases.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, resolve, sep } from "node:path";
import { WEB_PLUGINS } from "../../web-plugins/index.ts";

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

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, service: "pi-web-minimal" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/plugins") {
      sendJson(res, 200, { plugins: WEB_PLUGINS });
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
