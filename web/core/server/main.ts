// pi-web composition root: auth service, build watcher, native route groups,
// Fastify listener and bounded teardown. Static delivery is registered by the
// app factory; domain API handlers live in routes.ts.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { registerCoreRoutes } from "./routes.ts";
import { createAuthHttp, registerAuthRoutes, type AuthGateReply, type AuthGateRequest, type AuthHttp, type AuthHttpOptions } from "./auth.ts";
import { createWebApp } from "./app.ts";
import { httpLoggerOptions } from "../http/observability.ts";
import { createWebLogger, installCrashLogging, setWebLogger, type WebLoggerBundle } from "../http/logging.ts";
import { registerPluginRoutes } from "./plugin-routes.ts";
import { registerBrowserHalfRoutes } from "./browser-half-routes.ts";
import { flushPluginHostWarnings, getPluginHost } from "./plugin-host.ts";
import { runTeardown, teardownNote } from "./shutdown.ts";
import { announceBuildChanged } from "./sessions.ts";
import { beginDrain } from "./drain.ts";
import { closeAllEventChannels } from "../http/sse.ts";
import { setServedRoot, watchClientBuild } from "./client-build.ts";
import { webAuthConfigPath } from "../auth/config.ts";
import { WebAuthService } from "../auth/service.ts";
import { webExposureRefusal } from "../../../lib/web-exposure-policy.ts";

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
  /** Structured logging bundle. The direct server entry owns one; tests stay quiet by default. */
  logging?: WebLoggerBundle;
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
    // Framework diagnostics: request ids and redacted structured logs. The
    // direct entry passes its file/pretty stream so requests share the file.
    logger: options.logging
      ? httpLoggerOptions({ level: options.logging.level, stream: options.logging.stream })
      : httpLoggerOptions(),
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
    await registerBrowserHalfRoutes(app);
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
/** Give the final SSE frame a chance to reach browsers before sockets are force-closed. */
const DRAIN_FLUSH_MS = 250;

function installExitGuards(handle: WebServerHandle, logging: WebLoggerBundle): void {
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      beginDrain();
      closeAllEventChannels("There are code changes — reloading…");
      await new Promise((resolve) => setTimeout(resolve, DRAIN_FLUSH_MS));
      const host = getPluginHost();
      const outcome = await runTeardown([
        // A server that is already closing needs no second attempt: close() is
        // the step, and its failure is recorded rather than thrown.
        { name: "http server", run: () => handle.close() },
        { name: "plugin host", run: async () => host?.shutdown() },
      ]);
      logging.logger.info({ signal, outcome: teardownNote(outcome) }, `pi-web-minimal stopped (${signal})`);
      logging.flush();
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

export interface MainOptions {
  /** Called after the server is listening, before main resolves. */
  onStarted?: () => void;
}

export async function main(options: MainOptions = {}): Promise<void> {
  // A stable process title: the /web command's unmanaged-instance cleanup
  // matches it with pkill -f "pi-web-minimal" and nothing else. main() only
  // runs when the server is started directly, so test processes keep theirs.
  process.title = "pi-web-minimal";
  const logging = createWebLogger();
  setWebLogger(logging.logger);
  flushPluginHostWarnings();
  installCrashLogging(logging.logger);
  // A real server owns web sessions in detached pi processes by default, so a
  // reload drops only the bridge. Tests start the server directly and keep the
  // in-process fallback; PI_WEB_SESSION_HOST=0 is the operator opt-out.
  if (process.env.NODE_TEST_CONTEXT === undefined) process.env.PI_WEB_SESSION_HOST ??= "1";
  const auth = defaultAuthService();
  const refusal = webExposureRefusal({
    host: DEFAULT_HOST,
    authMode: auth.mode(),
    trustProxy: defaultAuthHttpOptions().trustProxy ?? "loopback",
    allowUnprotected: process.env.PI_WEB_ALLOW_UNPROTECTED === "1",
    allowTrustAllProxy: process.env.PI_WEB_ALLOW_TRUST_ALL_PROXY === "1",
  });
  if (refusal !== null) throw new Error(refusal);
  const handle = await startWebServer({ auth, logging });
  installExitGuards(handle, logging);
  const url = `http://${handle.host}:${handle.port}`;
  logging.logger.info({
    url,
    host: handle.host,
    port: handle.port,
    level: logging.level,
    logFile: logging.file ?? null,
    logFileFormat: logging.fileFormat ?? null,
  }, `pi-web-minimal listening on ${url}`);
  const mode = auth.mode();
  if (mode === "enabled") {
    logging.logger.info("password protection: on");
  } else if (mode === "invalid") {
    logging.logger.error({ reason: auth.invalidReason() ?? "unknown" }, "password protection is configured but unreadable; refusing API requests until /web set-password is run again");
  } else if (!["127.0.0.1", "::1", "localhost"].includes(handle.host)) {
    logging.logger.warn({ host: handle.host }, "listening without a password: anyone who can reach this port controls your agent");
  }
  options.onStarted?.();
}
