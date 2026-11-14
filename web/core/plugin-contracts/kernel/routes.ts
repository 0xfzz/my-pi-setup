/**
 * Plugin-owned HTTP routes (PRD §5.4.2, R13): `/api/p/<pluginId>/<path>`.
 *
 * A plugin registers a handler in `setup`/`activate` and the host dispatches
 * matching requests to it. Registration needs the `routes` capability, the
 * path stays inside the plugin's own namespace, and every call runs under a
 * time budget so a slow handler cannot wedge the server. Nothing here touches
 * HTTP directly: the server route adapts `IncomingMessage` to
 * `PluginRouteRequest` and writes the returned `PluginRouteResponse`.
 */
import { assertGranted, parseCapability, type Capability } from "./capabilities.ts";
import { runWithBudget } from "./budget.ts";

export const PLUGIN_ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type PluginRouteMethod = (typeof PLUGIN_ROUTE_METHODS)[number];

/** Default budget for one plugin route call. */
export const DEFAULT_ROUTE_BUDGET_MS = 10_000;

/**
 * Raw transport for handlers that must own the response (streaming a file,
 * long-lived writes). The objects are the server's own `IncomingMessage` and
 * `ServerResponse`; the handler casts them and returns `{ handled: true }`, and
 * the dispatcher writes nothing further.
 */
export interface PluginRouteTransport {
  readonly request: unknown;
  readonly response: unknown;
}

/** The request a plugin handler receives. `path` is relative to its own mount. */
export interface PluginRouteRequest {
  method: PluginRouteMethod;
  /** Path after `/api/p/<pluginId>/`, without a leading slash. */
  path: string;
  /** `:param` values captured from the registered path pattern. */
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON body, or undefined for GET/DELETE and empty bodies. */
  body: unknown;
  /** The caller's session id when it supplied one (`?sessionId=` or body). */
  sessionId?: string;
  /**
   * The session's project root, resolved by the host before dispatch. Present
   * whenever `sessionId` names a live session, so a plugin never has to reach
   * into the session registry itself.
   */
  sessionRoot?: string;
  /**
   * Present only for handlers that need the real request/response pair, such as
   * a byte stream. Everything else uses the plain `body` shape above.
   */
  transport?: PluginRouteTransport;
}

export interface PluginRouteResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** The handler already wrote the response itself (see `transport`). */
  handled?: boolean;
}

export type PluginRouteHandler = (
  request: PluginRouteRequest,
) => PluginRouteResponse | void | Promise<PluginRouteResponse | void>;

export interface RouteOwner {
  pluginId: string;
  grants: readonly Capability[];
}

export interface RegisteredRoute {
  pluginId: string;
  method: PluginRouteMethod;
  /** Normalised pattern, e.g. `summary/:id`. */
  path: string;
}

interface RouteEntry extends RegisteredRoute {
  segments: string[];
  handler: PluginRouteHandler;
  seq: number;
}

export type RouteResolution =
  | { ok: true; route: RegisteredRoute; handler: PluginRouteHandler; params: Record<string, string> }
  | { ok: false; error: string };

/** Path segments of a registration: no leading slash, no `..`, no empty segment. */
function normalisePath(raw: unknown): string[] | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed === "") return [];
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
    if (segment.startsWith(":") && !/^:[A-Za-z][A-Za-z0-9_]*$/.test(segment)) return null;
    if (segment.includes("*")) return null;
  }
  return segments;
}

function splitRequestPath(raw: string): string[] {
  const trimmed = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed === "" ? [] : trimmed.split("/");
}

/** Match concrete segments against a pattern; `:name` captures one segment. */
function matchSegments(pattern: string[], concrete: string[]): Record<string, string> | null {
  if (pattern.length !== concrete.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const expected = pattern[i];
    const actual = concrete[i];
    if (expected.startsWith(":")) {
      if (actual === "") return null;
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

export interface PluginRouteRegistryOptions {
  budgetMs?: number;
  clock?: () => number;
}

export class PluginRouteRegistry {
  private readonly entries = new Map<string, RouteEntry[]>();
  private readonly budgetMs: number;
  private readonly clock: () => number;
  private seq = 1;

  constructor(options: PluginRouteRegistryOptions = {}) {
    this.budgetMs = options.budgetMs ?? DEFAULT_ROUTE_BUDGET_MS;
    this.clock = options.clock ?? Date.now;
  }

  /**
   * Register one handler. Throws for an unknown method, a malformed path, or a
   * missing `routes` grant; returns the unregister function.
   */
  register(owner: RouteOwner, method: string, path: unknown, handler: PluginRouteHandler): () => void {
    const upper = String(method).toUpperCase();
    if (!(PLUGIN_ROUTE_METHODS as readonly string[]).includes(upper)) {
      throw new Error(`Plugin "${owner.pluginId}": unsupported route method "${String(method)}"`);
    }
    const segments = normalisePath(path);
    if (segments === null) {
      throw new Error(`Plugin "${owner.pluginId}": invalid route path "${String(path)}"`);
    }
    if (typeof handler !== "function") {
      throw new Error(`Plugin "${owner.pluginId}": route "${String(path)}" needs a handler function`);
    }
    const requested = parseCapability("routes");
    if (!requested.ok) throw new Error(`Plugin "${owner.pluginId}": ${requested.error}`);
    assertGranted(owner.pluginId, owner.grants, requested.value);

    const list = this.entries.get(owner.pluginId) ?? [];
    const clash = list.find((entry) => entry.method === upper && entry.path === segments.join("/"));
    if (clash) {
      throw new Error(
        `Plugin "${owner.pluginId}": route ${upper} /${segments.join("/")} is already registered`,
      );
    }
    const entry: RouteEntry = {
      pluginId: owner.pluginId,
      method: upper as PluginRouteMethod,
      path: segments.join("/"),
      segments,
      handler,
      seq: this.seq++,
    };
    this.entries.set(owner.pluginId, [...list, entry]);
    return () => {
      const current = this.entries.get(owner.pluginId) ?? [];
      this.entries.set(owner.pluginId, current.filter((candidate) => candidate !== entry));
    };
  }

  /** Remove every route a plugin registered (deactivate, rollback, quarantine). */
  removeOwner(pluginId: string): number {
    const removed = this.entries.get(pluginId)?.length ?? 0;
    this.entries.delete(pluginId);
    return removed;
  }

  /** Every registered route, oldest first — the plugin manager's diagnostics view. */
  list(): RegisteredRoute[] {
    const out: RegisteredRoute[] = [];
    for (const list of this.entries.values()) {
      for (const entry of list) out.push({ pluginId: entry.pluginId, method: entry.method, path: entry.path });
    }
    return out.sort((a, b) => a.pluginId.localeCompare(b.pluginId) || a.path.localeCompare(b.path));
  }

  /** Whether a plugin registered any route at all. */
  hasRoutes(pluginId: string): boolean {
    return (this.entries.get(pluginId)?.length ?? 0) > 0;
  }

  /**
   * Find the handler for one request. A path that matches another method is
   * reported as such so the caller can answer 405 instead of 404.
   */
  resolve(pluginId: string, method: string, rawPath: string): RouteResolution {
    const upper = method.toUpperCase();
    const list = this.entries.get(pluginId) ?? [];
    if (list.length === 0) return { ok: false, error: "no routes registered" };
    const concrete = splitRequestPath(rawPath);
    let methodMismatch = false;
    for (const entry of list) {
      const params = matchSegments(entry.segments, concrete);
      if (params === null) continue;
      if (entry.method !== upper) {
        methodMismatch = true;
        continue;
      }
      return {
        ok: true,
        route: { pluginId: entry.pluginId, method: entry.method, path: entry.path },
        handler: entry.handler,
        params,
      };
    }
    return { ok: false, error: methodMismatch ? "method not allowed" : "not found" };
  }

  /** Run one handler under the route budget; a throw or timeout becomes an error response. */
  async invoke(
    handler: PluginRouteHandler,
    request: PluginRouteRequest,
  ): Promise<{ ok: true; response: PluginRouteResponse } | { ok: false; reason: string; message: string }> {
    const outcome = await runWithBudget(
      `${request.method} ${request.path}`,
      this.budgetMs,
      () => handler(request),
      this.clock,
    );
    if (!outcome.ok) return { ok: false, reason: outcome.reason, message: outcome.error };
    const response = outcome.value;
    return { ok: true, response: response && typeof response === "object" ? response : {} };
  }
}
