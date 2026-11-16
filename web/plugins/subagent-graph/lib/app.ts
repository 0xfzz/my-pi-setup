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
 * the allowlisted UI layouts. Root parsers remain no-ops until the producer
 * body reader is migrated; `readBody` still enforces `maxSnapshotBytes`.
 */
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import { fastifySSE } from "@fastify/sse";
import { registerGraphStatic } from "./static.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface GraphAppOptions {
  /** Built graph UI root; missing builds use the local placeholder page. */
  staticRoot: string;
  /** Transport comment keepalive; zero disables it. */
  heartbeatInterval?: number;
  /**
   * The graph's loopback Host/Origin gate (PRD §6.1). Runs in `onRequest`
   * before any route or the delegate, answers on the raw response itself when
   * it refuses, and returns false in that case. Kept as a callback so the
   * runtime's `#port` (known only after `listen`) and its Host/Origin policy
   * stay in `server.ts`.
   */
  guard?: (request: IncomingMessage, response: ServerResponse) => boolean;
}

/**
 * The graph host's actual header policy (see `securityHeaders` in server.ts):
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
    ignoreTrailingSlash: false,
    // close() must tear down live SSE clients and half-open sockets.
    forceCloseConnections: true,
    logger: false,
  });

  // Producer routes still own their raw body reader and maxSnapshotBytes;
  // the root parser must not consume that stream before the route sees it.
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
      if (guard(request.raw, reply.raw)) return;
      // The guard wrote its own 403 through the raw pair; stop Fastify from
      // sending a second response.
      reply.hijack();
    });
  }

  await registerGraphStatic(app, options.staticRoot);
  return app;
}