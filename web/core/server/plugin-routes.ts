// Dispatch for plugin-owned backend routes: /api/p/<pluginId>/<path>.
//
// A plugin registers handlers through its runtime context (`ctx.routes`), so the
// server itself has no per-plugin branch. Every request is authenticated by the
// normal /api gate first, the plugin must be active (its routes are removed on
// deactivate), the handler runs under the kernel's route budget, and a thrown or
// timed-out handler answers 502 instead of crashing the host.

import type { IncomingMessage, ServerResponse } from "node:http";
import { getPluginHost } from "./plugin-host.ts";
import { readJsonBody, sendJson } from "./http.ts";
import { resolveSessionRoot } from "./sessions.ts";
import type { PluginRouteRequest, PluginRouteResponse } from "../plugin-contracts/kernel/routes.ts";

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

/** Methods that carry no body: reading one would wait on the socket. */
const BODYLESS_METHODS = new Set(["GET", "DELETE", "HEAD"]);

async function requestBody(req: IncomingMessage, method: string): Promise<unknown> {
  if (BODYLESS_METHODS.has(method)) return undefined;
  try {
    return await readJsonBody(req);
  } catch {
    return undefined;
  }
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

function writeResponse(res: ServerResponse, response: PluginRouteResponse): void {
  const headers = response.headers ?? {};
  if (Object.keys(headers).length > 0) {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  }
  sendJson(res, response.status ?? 200, response.body ?? null);
}

/**
 * Handle a plugin route. Returns false when the path is not a plugin route so
 * the caller can continue to its own table; otherwise the response is written.
 */
export async function handlePluginRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const target = parsePluginRoutePath(url.pathname);
  if (target === null) return false;

  const host = getPluginHost();
  if (host === null) {
    sendJson(res, 503, { error: "plugin host not started", code: "plugin_host_unavailable" });
    return true;
  }

  const method = (req.method ?? "GET").toUpperCase();
  const resolved = host.routes.resolve(target.pluginId, method, target.path);
  if (!resolved.ok) {
    // 405 when the path exists for another method, 404 when nothing matches.
    const status = resolved.error === "method not allowed" ? 405 : 404;
    sendJson(res, status, { error: resolved.error, pluginId: target.pluginId });
    return true;
  }

  const body = await requestBody(req, method);
  const sessionId = sessionIdOf(url.searchParams, body);
  // Resolve the session root here: the host owns session lifecycle, so a plugin
  // route never needs the session registry to answer "which project is this?".
  const sessionRoot = sessionId === undefined ? null : await resolveSessionRoot(sessionId);
  const request: PluginRouteRequest = {
    method: resolved.route.method,
    path: target.path,
    params: resolved.params,
    query: url.searchParams,
    body,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(sessionRoot !== null ? { sessionRoot } : {}),
    transport: { request: req, response: res },
  };

  const outcome = await host.routes.invoke(resolved.handler, request);
  if (!outcome.ok) {
    sendJson(res, 502, {
      error: outcome.message,
      code: outcome.reason === "timeout" ? "plugin_route_timeout" : "plugin_route_failed",
      pluginId: target.pluginId,
    });
    return true;
  }
  if (outcome.response.handled === true) return true;
  writeResponse(res, outcome.response);
  return true;
}
