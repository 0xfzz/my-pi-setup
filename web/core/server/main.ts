// pi-web composition root: auth service, build watcher, native route groups,
// Fastify listener and bounded teardown. Static delivery is registered by the
// app factory; domain API handlers live in routes.ts.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { registerSession } from "./sessions.ts";
import { seedPluginFixtures } from "./plugin-fixtures.ts";
import { registerCoreRoutes } from "./routes.ts";
import { createAuthHttp, registerAuthRoutes, type AuthGateReply, type AuthGateRequest, type AuthHttp, type AuthHttpOptions } from "./auth.ts";
import { createWebApp } from "./app.ts";
import { httpLoggerOptions } from "../http/observability.ts";
import { registerPluginRoutes } from "./plugin-routes.ts";
import { getPluginHost } from "./plugin-host.ts";
import { runTeardown, teardownNote } from "./shutdown.ts";
import { announceBuildChanged } from "./sessions.ts";
import { setServedRoot, watchClientBuild } from "./client-build.ts";
import { webAuthConfigPath } from "../auth/config.ts";
import { WebAuthService } from "../auth/service.ts";

// Mark this process as the web server. It resumes sessions in-process, which
// loads the project extensions (including `web`) into THIS process; the `web`
// extension checks this flag so it does not bridge a web-resumed session back
// to the server that owns it.
process.env.PI_WEB_SERVER_PROCESS = "1";

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

/** The four public auth endpoints, which own their own method/error answers. */
const AUTH_ROUTE_PATHS = new Set([
  "/api/auth/status",
  "/api/auth/login",
  "/api/auth/refresh",
  "/api/auth/logout",
]);

function parseRequestUrl(url: string, host: string | undefined): URL | null {
  try {
    return new URL(url, `http://${host ?? "localhost"}`);
  } catch {
    return null;
  }
}

/**
 * The `/api` access gate (PRD §6.1), run in `onRequest` so an unauthenticated
 * caller is refused before any body is parsed. Public: liveness (the TUI's
 * health probe) and the four auth routes themselves. The static client is
 * public too — it has to load to show the login screen — but carries no data.
 */
function authorizeRequest(request: AuthGateRequest, reply: AuthGateReply, url: URL, auth: AuthHttp): boolean {
  if (!pathnameIsApi(url.pathname)) return true;
  if (url.pathname === "/api/health") return true;
  if (AUTH_ROUTE_PATHS.has(url.pathname)) return true;
  return auth.authorize(request, reply, url);
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
  // The build id is read from this directory on demand: a rebuild replaces it
  // while the process runs, and the served assets change with it.
  setServedRoot(root);

  const authHttp = options.authHttp ?? defaultAuthHttpOptions();
  const service = options.auth ?? defaultAuthService();
  const auth = createAuthHttp(service, authHttp);
  // A rebuild replaces the bundle on disk while this process keeps serving.
  // Tell open pages, so every tab converges on one client build instead of
  // each keeping whatever it was opened with.
  const stopWatchingBuild = watchClientBuild(root, (build) => announceBuildChanged(build.buildId));

  return createWebApp({
    // Framework diagnostics: request ids and redacted structured error logs.
    logger: httpLoggerOptions(),
    // The gate runs before parsing; auth endpoints and public paths pass through.
    authorize: (request, reply) => {
      const url = parseRequestUrl(request.url, request.headers.host);
      if (url === null) {
        void reply.code(400).header("cache-control", "no-store").send({ error: "bad request" });
        return false;
      }
      return authorizeRequest(request, reply, url, auth);
    },
    staticRoot: root,
    // Release residual auth response tracking during close(). Fastify's
    // forceCloseConnections policy owns the bounded socket teardown.
    onClose: () => auth.close(),
  }).then(async (app) => {
    // Plugin backend routes, the core API and the auth endpoints are native now;
    // the kernel matcher behind the plugin gateway stays dynamic.
    await registerPluginRoutes(app);
    await registerCoreRoutes(app);
    await registerAuthRoutes(app, service, authHttp);
    try {
      await app.listen({ port: requestedPort, host });
    } catch (error) {
      // A failed bind releases the watcher and the app; the caller sees the
      // original EADDRINUSE/EACCES rather than a leaked handle.
      stopWatchingBuild();
      await app.close().catch(() => {});
      throw error;
    }
    const address = app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : requestedPort;
    return {
      port,
      host,
      close: () => {
        stopWatchingBuild();
        // Fastify's forceCloseConnections tears down live SSE streams and
        // half-open sockets, so a lingering event stream cannot keep close()
        // from ever resolving.
        return app.close();
      },
    };
  });
}

/**
 * Exit deliberately, and say so.
 *
 * Two things go wrong without this hook:
 *
 * - The kernel's crash-loop guard counts process starts: two inside a minute
 *   boots safe mode, where only `core.*` plugins activate and every other
 *   plugin's actions answer 404 while its views still render. A restart the
 *   operator asked for (a dev reload, a supervisor restart, Ctrl-C) is not a
 *   crash, so the plugin host records an orderly shutdown first.
 * - Teardown is where a leak becomes an orphan. An unbounded close lets a hung
 *   SSE client or a plugin that never settles keep the process alive until the
 *   supervisor SIGKILLs it, and every child the host still tracked survives.
 *   The budget is what guarantees this process actually reaches `exit`.
 *
 * The `exit` hook is the last resort for the paths no signal handler sees — a
 * `process.exit()` from anywhere else, or an uncaught exception's exit — where
 * nothing can be awaited and only a synchronous kill is still possible.
 */
function installExitGuards(handle: WebServerHandle): void {
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      const host = getPluginHost();
      const outcome = await runTeardown([
        // A server that is already closing needs no second attempt: close() is
        // the step, and its failure is recorded rather than thrown.
        { name: "http server", run: () => handle.close() },
        { name: "plugin host", run: async () => host?.shutdown() },
      ]);
      console.log(`[pi-web-minimal] stopped (${signal})${teardownNote(outcome)}`);
      process.exit(0);
    })();
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("exit", () => {
    // Synchronous on purpose: an exit handler cannot await anything.
    getPluginHost()?.processes.killAllNow();
  });
}

export async function main(): Promise<void> {
  // A stable process title: the /web command's unmanaged-instance cleanup
  // matches it with pkill -f "pi-web-minimal" and nothing else. main() only
  // runs when the server is started directly, so test processes keep theirs.
  process.title = "pi-web-minimal";
  const auth = defaultAuthService();
  const handle = await startWebServer({ auth });
  installExitGuards(handle);
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
    // Seeding is explicit: the plugin modules carry no import-time side effect,
    // so the server decides when the fixture surfaces exist.
    seedPluginFixtures();
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
 * The turn then names the session, exactly as the auto-title extension does at
 * the end of a real turn, so the sidebar's rename path is observable too.
 */
/** The name the fixture turn writes, the way auto-title names a session. */
export const FIXTURE_SESSION_TITLE = "Plan review";

function registerFixtureSession(): void {
  const sessionId = "__test_session__";
  let sessionName: string | undefined;
  // Many listeners, like AgentSession.subscribe: the directory tap, the plugin
  // bridge and every browser stream subscribe to the same session. A
  // single-listener slot made the newest subscriber silently evict the others,
  // so the directory tap (running flags, renames) died as soon as a browser
  // opened the session — a fidelity gap no e2e could see past.
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown): void => {
    for (const listener of listeners) listener(event);
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

  /** The compaction the fixture is running, if any (reported as isCompacting). */
  let compacting: "manual" | "threshold" | null = null;

  /**
   * Simulate a compaction the way pi's own compact paths announce one: a start
   * event, the summarizing pause, then an end event. `instructions` picks the
   * outcome the e2e needs — "fail" ends with pi's failure text for an
   * automatic compaction (which has no HTTP response to carry the error, so
   * the browser's marker row is the only carrier), "abort" ends cancelled, and
   * anything else succeeds. No entry is written: the fixture has no session
   * file, and the transcript marker is covered against a seeded file.
   */
  const simulateCompaction = async (instructions: string): Promise<void> => {
    const reason = instructions === "fail" ? "threshold" : "manual";
    compacting = reason;
    emit({ type: "compaction_start", reason });
    await delay(600);
    compacting = null;
    if (instructions === "abort") {
      emit({ type: "compaction_end", reason, aborted: true, willRetry: false });
      return;
    }
    if (instructions === "fail") {
      emit({
        type: "compaction_end",
        reason,
        aborted: false,
        willRetry: false,
        errorMessage: "Auto-compaction failed: fixture says the summary would not reduce context",
      });
      return;
    }
    emit({
      type: "compaction_end",
      reason,
      aborted: false,
      willRetry: false,
      result: { tokensBefore: 128432, estimatedTokensAfter: 12000 },
    });
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
    // A real turn ends by naming the session (auto-title, or a /name). The
    // name is announced the way pi announces it, so the sidebar's rename path
    // — directory stream in, row label out — is exercised, not just the view.
    sessionName = FIXTURE_SESSION_TITLE;
    emit({ type: "session_info_changed", name: sessionName });
    emit({ type: "agent_settled" });
  };

  registerSession(
    {
      sessionId,
      subscribe: (next: (event: unknown) => void) => {
        listeners.add(next);
        // The stream's connect announcement goes to the newcomer only.
        next({ type: "agent_start" });
        return () => {
          listeners.delete(next);
        };
      },
      prompt: async () => {
        void simulateTurn();
      },
      // The core's own compaction path (web/core/server/sessions.ts): the
      // browser's /compact reaches the fixture exactly as it reaches a real
      // in-process session.
      compact: async (instructions?: string) => {
        await simulateCompaction(instructions ?? "");
      },
      abort: async () => {},
      isStreaming: () => false,
      getSessionName: () => sessionName,
      getState: () => ({
        sessionId,
        sessionFile: "",
        isStreaming: false,
        isBashRunning: false,
        isCompacting: compacting !== null,
        model: undefined,
        contextUsage: null,
        thinkingLevel: "off",
      }),
    },
    // Files share the real session root (process.cwd()); the viewer e2e
    // overrides it to a fixture directory so it can browse known files.
    process.env.PI_WEB_TEST_FILES_ROOT ?? process.cwd(),
    "",
  );
}