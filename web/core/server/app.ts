// The pi-web Fastify application factory.
//
// Constructing the app does not listen and installs no signal handlers: the
// composition root (`startWebServer` in main.ts) owns the listener, the build
// watcher and the exit guards. `createWebApp` only wires framework mechanisms:
// body parsing, cookies, security headers, the error/not-found policy and
// lifecycle hooks.
//
// Native route groups own their parser scopes and @fastify/static serves the
// configured build root. There is no production catch-all dispatcher.

import Fastify, { type FastifyInstance, type FastifyLoggerOptions, type FastifyRequest, type FastifyReply } from "fastify";
import type { LoggerOptions as PinoLoggerOptions } from "pino";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import { fastifySSE } from "@fastify/sse";
import { registerClientStatic } from "./client-static.ts";
import { HTTP_AJV_OPTIONS, firstQueryValues } from "../../../lib/http-schema-policy.ts";

/** The general pi-web request body cap (base64 images, downscaled client-side). */
const MAX_WEB_BODY_BYTES = 60_000_000;

export interface WebAppOptions {
  /** Built client root; omit when constructing an API-only/test app. */
  staticRoot?: string;
  /**
   * The `/api` access gate. Returns true to let the request continue; false
   * when it has already answered through Fastify. It runs in `onRequest`,
   * so an unauthenticated caller is refused **before** any body is parsed or
   * any schema is validated (PRD §6.1).
   */
  authorize?: (request: FastifyRequest, reply: FastifyReply) => boolean | Promise<boolean>;
  /**
   * Releases app-owned resources when `app.close()` runs. With this pinned
   * Fastify release, forceCloseConnections tears down sockets before this
   * callback. The callback releases residual response tracking; it is not the
   * mechanism that makes socket shutdown bounded (PRD §M13).
   */
  onClose?: () => void | Promise<void>;
  /**
   * Framework request diagnostics (M14). Production passes the shared
   * redacted logger; the default keeps factories quiet for tests.
   */
  logger?: FastifyLoggerOptions & PinoLoggerOptions;
}

/**
 * Security headers every pi-web response carries. The list is explicit and
 * minimal on purpose: helmet's defaults would add a CSP, HSTS and COEP that the
 * TUI bridge, the viewers and a plain-HTTP localhost deployment must not
 * acquire (PRD §6.4). Only the three headers the handwritten server always set
 * are enabled.
 */
const SECURITY_HEADERS = {
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
  originAgentCluster: false,
  strictTransportSecurity: false,
  xDnsPrefetchControl: false,
  xDownloadOptions: false,
  xPermittedCrossDomainPolicies: false,
  xssFilter: false,
  // X-Frame-Options default is SAMEORIGIN; the web host has always sent DENY.
  xFrameOptions: { action: "deny" as const },
  referrerPolicy: { policy: "no-referrer" as const },
  xContentTypeOptions: true,
};

/**
 * Build the pi-web Fastify app without listening. Callers own `listen`,
 * `close`, and any signal handling.
 */
export async function createWebApp(options: WebAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // The primary host's GET routes must not acquire HEAD side effects.
    exposeHeadRoutes: false,
    // `/x` and `/x/` are different paths in the current contract.
    routerOptions: { ignoreTrailingSlash: false, querystringParser: firstQueryValues },
    ajv: { customOptions: HTTP_AJV_OPTIONS },
    // close() must tear down live SSE streams and half-open sockets, exactly as
    // the old closeAllConnections() did.
    forceCloseConnections: true,
    bodyLimit: MAX_WEB_BODY_BYTES,
    // Diagnostics are opt-in from the composition root: request ids always
    // exist, and the shared policy redacts credentials when logging is on.
    logger: options.logger ?? false,
  });

  // Native routes own their parser scopes. The root parser consumes nothing
  // for routes that do not take bodies, including static/method refusals.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_request, _payload, done) => {
    done(null, undefined);
  });

  await app.register(fastifySSE);
  await app.register(cookie);
  await app.register(helmet, { global: true, ...SECURITY_HEADERS });

  if (options.authorize !== undefined) {
    const authorize = options.authorize;
    app.addHook("onRequest", async (request, reply) => {
      if (!await authorize(request, reply)) return reply;
    });
  }

  if (options.onClose !== undefined) {
    const onClose = options.onClose;
    app.addHook("onClose", async () => {
      await onClose();
    });
  }

  app.setErrorHandler((error, request, reply) => {
    // An oversize body is the client's fault. The historical handlers answered
    // 400 with this message, so it is not a server error and must not be logged
    // as one.
    if (errorCodeOf(error) === "FST_ERR_CTP_BODY_TOO_LARGE") {
      void reply.code(400).header("cache-control", "no-store").send({ error: "request body too large" });
      return;
    }
    // Never leak a stack, credential or internal detail; the shape matches the
    // handwritten 500 the suites already assert on.
    request.log.error({ err: error }, "unhandled request error");
    if (reply.sent) return;
    void reply.code(500).header("cache-control", "no-store").send({ error: "internal error" });
  });

  if (options.staticRoot !== undefined) {
    await registerClientStatic(app, options.staticRoot);
  } else {
    app.setNotFoundHandler((_request, reply) => {
      void reply.code(404).header("cache-control", "no-store").send({ error: "not found" });
    });
  }

  return app;
}

function errorCodeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
