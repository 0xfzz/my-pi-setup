// The pi-web Fastify application factory.
//
// Constructing the app does not listen and installs no signal handlers: the
// composition root (`startWebServer` in main.ts) owns the listener, the build
// watcher and the exit guards. `createWebApp` only wires framework mechanisms:
// body parsing, cookies, security headers, the error/not-found policy and
// lifecycle hooks.
//
// Routes move onto native Fastify declarations in the following phases. Until a
// path is converted it falls through to `delegate`, the pre-existing dispatcher,
// through a single bounded wildcard. The delegate receives the untouched Node
// request/response pair: this app installs no-op content type parsers at the
// root so a delegated request's body is never consumed twice.

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import type { IncomingMessage, ServerResponse } from "node:http";

/** The general pi-web request body cap (base64 images, downscaled client-side). */
export const MAX_WEB_BODY_BYTES = 60_000_000;

export interface WebAppOptions {
  /**
   * Handles a request no native route claimed. It owns the response: the app
   * hijacks Fastify's reply and hands over the raw Node pair. Removed once
   * every path has a native route.
   */
  delegate: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
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
export async function createWebApp(options: WebAppOptions): Promise<FastifyInstance> {
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

  // Native routes register their own real parsers in a child scope; at the root
  // a delegated request's body must stay on the wire for the old dispatcher.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_request, _payload, done) => {
    done(null, undefined);
  });

  await app.register(cookie);
  await app.register(helmet, { global: true, ...SECURITY_HEADERS });

  app.setErrorHandler((error, request, reply) => {
    // Never leak a stack, credential or internal detail; the shape matches the
    // handwritten 500 the suites already assert on.
    request.log.error({ err: error }, "unhandled request error");
    if (reply.sent) return;
    void reply.code(500).header("cache-control", "no-store").send({ error: "internal error" });
  });

  app.setNotFoundHandler((request, reply) => {
    // The API never answers with an HTML shell.
    void reply.code(404).header("cache-control", "no-store").send({ error: "not found" });
  });

  app.all("/*", async (request, reply) => {
    reply.hijack();
    await options.delegate(request.raw, reply.raw);
  });

  return app;
}
