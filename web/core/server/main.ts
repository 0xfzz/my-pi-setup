// Minimal pi-web server — static client assets, auth wiring and the HTTP
// host. The plugin registry and session-core API live in routes.ts; the
// static/directory/auth/SSE serving stays here, per
// docs/prds/minimal-pi-web.md.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join, resolve, sep } from "node:path";
import { registerSession } from "./sessions.ts";
import { handleApi } from "./routes.ts";
import { sendJson } from "./http.ts";
import { createAuthHttp, type AuthHttp, type AuthHttpOptions } from "./auth.ts";
import { webAuthConfigPath } from "../../../lib/web-auth/config.ts";
import { WebAuthService } from "../../../lib/web-auth/service.ts";

// Mark this process as the web server. It resumes sessions in-process, which
// loads the project extensions (including `web`) into THIS process; the `web`
// extension checks this flag so it does not bridge a web-resumed session back
// to the server that owns it.
process.env.PI_WEB_SERVER_PROCESS = "1";

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
  /** The password/token service. Defaults to the one configured by `/web set-password`. */
  auth?: WebAuthService;
  /** Cookie, proxy and origin policy for the auth routes. Defaults come from PI_WEB_* env vars. */
  authHttp?: AuthHttpOptions;
}

function envNumber(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The password service the server runs with. Unit tests run with protection off unless they
 * inject their own, so a developer's real `/web set-password` cannot leak into the suite.
 */
function defaultAuthService(): WebAuthService {
  if (process.env.NODE_TEST_CONTEXT !== undefined) return new WebAuthService({ configPath: null });
  const refreshDays = envNumber("PI_WEB_REFRESH_TTL_DAYS");
  const accessSeconds = envNumber("PI_WEB_ACCESS_TTL_SECONDS");
  return new WebAuthService({
    configPath: webAuthConfigPath(),
    ...(accessSeconds !== undefined ? { accessTtlSeconds: accessSeconds } : {}),
    ...(refreshDays !== undefined ? { refreshTtlSeconds: refreshDays * 86_400 } : {}),
  });
}

function defaultAuthHttpOptions(): AuthHttpOptions {
  const trust = process.env.PI_WEB_TRUST_PROXY;
  return {
    trustProxy: trust === "1" || trust === "all" ? "all" : trust === "0" || trust === "off" ? "off" : "loopback",
    allowedOrigins: (process.env.PI_WEB_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
    forceSecureCookies: process.env.PI_WEB_COOKIE_SECURE === "1",
  };
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

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  auth: AuthHttp,
): Promise<void> {
  // Set before any writeHead, so every response (static, API, errors) carries them.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  } catch {
    sendJson(res, 400, { error: "bad request" });
    return;
  }
  try {
    if (pathnameIsApi(url.pathname)) {
      // Public: liveness (the TUI's health probe) and the auth routes themselves. The static
      // client is public too — it has to load to show the login screen — but carries no data.
      if (url.pathname !== "/api/health") {
        if (await auth.handleRoute(req, res, url)) return;
        if (!auth.authorize(req, res, url)) return;
      }
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

  const auth = createAuthHttp(options.auth ?? defaultAuthService(), options.authHttp ?? defaultAuthHttpOptions());
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, root, auth);
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
  const auth = defaultAuthService();
  const handle = await startWebServer({ auth });
  console.log(`[pi-web-minimal] listening on http://${handle.host}:${handle.port}`);
  const mode = auth.mode();
  if (mode === "enabled") {
    console.log("[pi-web-minimal] password protection: on");
  } else if (mode === "invalid") {
    console.error(`[pi-web-minimal] password protection is configured but unreadable (${auth.invalidReason() ?? "unknown"}); refusing all API requests until /web set-password is run again`);
  } else if (!["127.0.0.1", "::1", "localhost"].includes(handle.host)) {
    console.warn(`[pi-web-minimal] WARNING: listening on ${handle.host} with no password. Anyone who can reach this port controls your agent. Run /web set-password in pi.`);
  }
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
    "1. start the server",
    "2. run the suite",
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
    "```mermaid",
    "flowchart TD",
    "  A[Start] --> B{Done?}",
    "  B -->|yes| C[Ship]",
    "  B -->|no| A",
    "```",
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