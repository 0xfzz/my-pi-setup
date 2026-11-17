// Dispatch for plugin-owned backend routes: /api/p/<pluginId>/<path>.
//
// A plugin registers handlers through its runtime context (`ctx.routes`), so the
// server itself has no per-plugin branch. Authentication runs in the app's
// `onRequest` gate first, the plugin must be active (its routes are removed on
// deactivate), the handler runs under the kernel's route budget, and a thrown
// or timed-out handler answers 502 instead of crashing the host.
//
// This is a native Fastify route. The kernel's matcher (`resolve`) does the
// dynamic dispatch; Fastify only owns the path shape and the response.

import type { FastifyInstance, FastifyReply } from "fastify";
import { getPluginHost } from "./plugin-host.ts";
import { resolveSessionRoot } from "./sessions.ts";
import { disposePluginRouteStream, type PluginRouteRequest, type PluginRouteResponse, type PluginRouteStream } from "../plugin-contracts/kernel/routes.ts";
import { prepareLegacyPluginReply, settleLegacyPluginReply } from "./legacy-plugin-transport.ts";

/** `/api/p/<pluginId>/<rest>` — the plugin id is the first segment. */
const PLUGIN_ROUTE_PREFIX = "/api/p/";

export interface PluginRouteTarget {
  pluginId: string;
  path: string;
}

/** Split a plugin route pathname; null when the path is not a plugin route. */
export function parsePluginRoutePath(pathname: string): PluginRouteTarget | null {
  if (!pathname.startsWith(PLUGIN_ROUTE_PREFIX)) return null;
  const rest = pathname.slice(PLUGIN_ROUTE_PREFIX.length);
  const slash = rest.indexOf("/");
  const pluginId = slash === -1 ? rest : rest.slice(0, slash);
  if (pluginId === "") return null;
  return { pluginId, path: slash === -1 ? "" : rest.slice(slash + 1) };
}

/** The session a plugin route is scoped to: query string first, then the body. */
function sessionIdOf(query: URLSearchParams, body: unknown): string | undefined {
  const fromQuery = query.get("sessionId");
  if (fromQuery !== null && fromQuery !== "") return fromQuery;
  if (typeof body === "object" && body !== null) {
    const fromBody = (body as { sessionId?: unknown }).sessionId;
    if (typeof fromBody === "string" && fromBody !== "") return fromBody;
  }
  return undefined;
}

function sendJson(reply: FastifyReply, status: number, body: unknown): void {
  reply.code(status).header("cache-control", "no-store").send(body);
}

function writeResponse(reply: FastifyReply, response: PluginRouteResponse): void {
  const headers = response.headers ?? {};
  for (const [name, value] of Object.entries(headers)) reply.header(name, value);
  sendJson(reply, response.status ?? 200, response.body ?? null);
}

/**
 * Send a byte stream. The handler's `close` runs when the response settles, so
 * a descriptor released there is released on both completion and a mid-body
 * abort. Fastify destroys the reply when the client goes away, which is what
 * fires the response's own `close`.
 */
async function writeStream(reply: FastifyReply, result: PluginRouteStream): Promise<void> {
  const release = (): void => {
    void disposePluginRouteStream(result).catch(error => reply.log.error({ err: error }, "plugin stream cleanup failed"));
  };
  reply.raw.once("close", release);
  try {
    for (const [name, value] of Object.entries(result.headers ?? {})) reply.header(name, value);
    await reply.code(result.status ?? 200).send(result.stream);
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * Register the plugin HTTP entry point as a native route.
 *
 * Bodies have their own contract here: a plugin handler has always received a
 * JSON body parsed regardless of `Content-Type`, an empty body as `{}`, and a
 * malformed body as `undefined` (never a 400). The parser is scoped to this
 * route so it cannot change any other route's error ordering.
 */
export async function registerPluginRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    scope.addContentTypeParser("*", { parseAs: "string" }, (_request, body, done) => {
      const text = typeof body === "string" ? body : "";
      if (text === "") {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch {
        done(null, undefined);
      }
    });

    scope.all("/api/p/*", async (request, reply) => {
      const url = new URL(request.url, "http://localhost");
      const target = parsePluginRoutePath(url.pathname);
      if (target === null) {
        sendJson(reply, 404, { error: "not found" });
        return;
      }

      const host = getPluginHost();
      if (host === null) {
        sendJson(reply, 503, { error: "plugin host not started", code: "plugin_host_unavailable" });
        return;
      }

      const resolved = host.routes.resolve(target.pluginId, request.method.toUpperCase(), target.path);
      if (!resolved.ok) {
        // 405 when the path exists for another method, 404 when nothing matches.
        const status = resolved.error === "method not allowed" ? 405 : 404;
        sendJson(reply, status, { error: resolved.error, pluginId: target.pluginId });
        return;
      }

      const disconnected = new AbortController();
      reply.raw.once("close", () => disconnected.abort());
      const body = request.body;
      const sessionId = sessionIdOf(url.searchParams, body);
      // Resolve the session root here: the host owns session lifecycle, so a
      // plugin route never needs the session registry to answer "which project
      // is this?".
      const sessionRoot = sessionId === undefined ? null : await resolveSessionRoot(sessionId);
      const pluginRequest: PluginRouteRequest = {
        method: resolved.route.method,
        path: target.path,
        params: resolved.params,
        query: url.searchParams,
        body,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(sessionRoot !== null ? { sessionRoot } : {}),
        transport: { request: request.raw, response: reply.raw },
        headers: request.headers,
        signal: disconnected.signal,
      };

      prepareLegacyPluginReply(reply);
      const outcome = await host.routes.invoke(resolved.handler, pluginRequest);
      if (settleLegacyPluginReply(reply, outcome.ok ? outcome.response : undefined)) {
        if (outcome.ok && outcome.response.stream !== undefined) {
          await disposePluginRouteStream(outcome.response.stream);
        }
        return;
      }
      if (!outcome.ok) {
        request.log.error({
          err: new Error(outcome.message),
          reason: outcome.reason,
          pluginId: target.pluginId,
          sessionId,
          path: target.path,
        }, "plugin route failed");
        sendJson(reply, 502, {
          error: outcome.message,
          code: outcome.reason === "timeout" ? "plugin_route_timeout" : "plugin_route_failed",
          pluginId: target.pluginId,
        });
        return;
      }
      if (outcome.response.stream !== undefined) {
        await writeStream(reply, outcome.response.stream);
        return;
      }
      writeResponse(reply, outcome.response);
    });
  });
}
