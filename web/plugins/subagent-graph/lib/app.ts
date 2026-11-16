/**
 * app.ts — the subagent-graph Fastify application factory.
 *
 * PRD §5 draws the graph host as a *separate* Fastify factory that shares the
 * HTTP mechanisms with pi-web while keeping its own host, authentication and
 * state. That separation is why this file exists next to (rather than inside)
 * `web/core/server/app.ts`: the graph's security policy is stricter (origin
 * isolation headers) and its body caps come from `maxSnapshotBytes`, not from
 * pi-web's 60 MB general limit.
 *
 * Constructing the app does not listen and installs no signal handlers; the
 * runtime in `server.ts` owns the listener, the port fallback and shutdown.
 *
 * The runtime registers native API/bootstrap routes; @fastify/static serves
 * the allowlisted UI layouts. Producer routes scope their JSON compatibility
 * parser and byte cap; Fastify owns request consumption.
 */
import Fastify, { type FastifyInstance, type FastifyLoggerOptions } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import { fastifySSE } from "@fastify/sse";
import { registerGraphStatic } from "./static.ts";
import { HTTP_AJV_OPTIONS, firstQueryValues } from "../../../../lib/http-schema-policy.ts";
import type { FastifyRequest, FastifyReply } from "fastify";

export interface GraphAppOptions {
  /** Built graph UI root; missing builds use the local placeholder page. */
  staticRoot: string;
  /** Transport comment keepalive; zero disables it. */
  heartbeatInterval?: number;
  /**
   * The graph's loopback Host/Origin gate (PRD §6.1). Runs in `onRequest`
   * before parsing/validation, answers through Fastify when it refuses, and
   * returns false in that case. Kept as a callback so the
   * runtime's `#port` (known only after `listen`) and its Host/Origin policy
   * stay in `server.ts`.
   */
  guard?: (request: FastifyRequest, reply: FastifyReply) => boolean;
  /** Framework request diagnostics routed to the runtime's log sink (M14). */
  logger?: FastifyLoggerOptions;
}

/**
 * The graph host's header policy:
 * nosniff, no-referrer, frame-deny, plus resource/opener isolation.
 *
 * CSP is deliberately not global — the runtime sets it only on HTML responses,
 * so the graph's CSP is untouched by this configuration. HSTS, COEP and
 * agent-cluster are off for the same reason they are off on pi-web: this is a
 * loopback HTTP service, not a public HTTPS origin.
 */
const GRAPH_SECURITY_HEADERS = {
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: "same-origin" as const },
  crossOriginResourcePolicy: { policy: "same-origin" as const },
  originAgentCluster: false,
  strictTransportSecurity: false,
  xDnsPrefetchControl: false,
  xDownloadOptions: false,
  xPermittedCrossDomainPolicies: false,
  xssFilter: false,
  xFrameOptions: { action: "deny" as const },
  referrerPolicy: { policy: "no-referrer" as const },
  xContentTypeOptions: true,
};

/**
 * Build the subagent-graph Fastify app without listening.
 */
export async function createGraphApp(options: GraphAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    // The graph's static contract answers GET and HEAD explicitly; automatic
    // HEAD routes would add a second, differently-behaving path.
    exposeHeadRoutes: false,
    routerOptions: { ignoreTrailingSlash: false, querystringParser: firstQueryValues },
    ajv: { customOptions: HTTP_AJV_OPTIONS },
    // close() must tear down live SSE clients and half-open sockets.
    forceCloseConnections: true,
    logger: options.logger ?? false,
  });

  // Non-producer routes ignore bodies; producer routes override this parser
  // in their own scope with Fastify-owned accumulation and maxSnapshotBytes.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_request, _payload, done) => {
    done(null, undefined);
  });

  await app.register(fastifySSE, { heartbeatInterval: options.heartbeatInterval ?? 15_000 });
  await app.register(cookie);
  await app.register(helmet, { global: true, ...GRAPH_SECURITY_HEADERS });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "unhandled graph request error");
    if (reply.sent) return;
    void reply.code(500).header("cache-control", "no-store").send({ error: "internal error" });
  });

  if (options.guard) {
    const guard = options.guard;
    app.addHook("onRequest", async (request, reply) => {
      guard(request, reply);
    });
  }

  await registerGraphStatic(app, options.staticRoot);
  return app;
}