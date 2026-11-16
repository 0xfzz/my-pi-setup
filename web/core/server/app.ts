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

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import { registerClientStatic } from "./client-static.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

/** The general pi-web request body cap (base64 images, downscaled client-side). */
const MAX_WEB_BODY_BYTES = 60_000_000;

/**
 * The minimal request/reply shape the app's seams accept. Declaring it here
 * keeps Fastify's types out of the callers (`main.ts`) while still letting a
 * `FastifyRequest`/`FastifyReply` satisfy it structurally.
 */
export interface HttpRequestFacade {
  readonly raw: IncomingMessage;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  /** Parsed by @fastify/cookie's onRequest hook, which runs before this gate. */
  readonly cookies: Record<string, string | undefined>;
}

export interface HttpReplyFacade {
  readonly raw: ServerResponse;
}

export interface WebAppOptions {
  /** Built client root; omit when constructing an API-only/test app. */
  staticRoot?: string;
  /**
   * The `/api` access gate. Returns true to let the request continue; false
   * when it has already answered through the raw pair. It runs in `onRequest`,
   * so an unauthenticated caller is refused **before** any body is parsed or
   * any schema is validated (PRD §6.1).
   */
  authorize?: (request: HttpRequestFacade, reply: HttpReplyFacade) => boolean | Promise<boolean>;
  /**
   * Releases app-owned resources when `app.close()` runs. With this pinned
   * Fastify release, forceCloseConnections tears down sockets before this
   * callback. The callback releases residual response tracking; it is not the
   * mechanism that makes socket shutdown bounded (PRD §M13).
   */
  onClose?: () => void | Promise<void>;
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
 * The same three headers, written straight onto the raw response. Helmet only
 * applies through Fastify's send path, so a transitional `reply.hijack()`
 * response (or an auth-gate 401) would otherwise lose them.
 */
function applyRawSecurityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
}

/**
 * Build the pi-web Fastify app without listening. Callers own `listen`,
 * `close`, and any signal handling.
 */
export async function createWebApp(options: WebAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // The primary host's GET routes must not acquire HEAD side effects.
    exposeHeadRoutes: false,
    // `/x` and `/x/` are different paths in the current contract.
    ignoreTrailingSlash: false,
    // close() must tear down live SSE streams and half-open sockets, exactly as
    // the old closeAllConnections() did.
    forceCloseConnections: true,
    bodyLimit: MAX_WEB_BODY_BYTES,
    // Diagnostics are not enabled yet; enabling the logger changes nothing for
    // clients and is deferred to the observability row (M14).
    logger: false,
  });

  // Native routes own their parser scopes. The root parser consumes nothing
  // for routes that do not take bodies, including static/method refusals.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_request, _payload, done) => {
    done(null, undefined);
  });

  await app.register(cookie);
  await app.register(helmet, { global: true, ...SECURITY_HEADERS });

  if (options.authorize !== undefined) {
    const authorize = options.authorize;
    app.addHook("onRequest", async (request, reply) => {
      applyRawSecurityHeaders(reply.raw);
      if (await authorize(request, reply)) return;
      // The gate wrote its own 401/403/503 through the raw pair; stop Fastify
      // from sending a second response.
      reply.hijack();
    });
  } else {
    app.addHook("onRequest", async (_request, reply) => {
      applyRawSecurityHeaders(reply.raw);
    });
  }

  if (options.onClose !== undefined) {
    const onClose = options.onClose;
    app.addHook("onClose", async () => {
      await onClose();
    });
  }

  app.setErrorHandler((error, request, reply) => {
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
