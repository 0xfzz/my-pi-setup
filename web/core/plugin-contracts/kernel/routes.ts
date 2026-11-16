/**
 * Plugin-owned HTTP routes (PRD §5.4.2, R13): `/api/p/<pluginId>/<path>`.
 *
 * A plugin registers a handler in `setup`/`activate` and the host dispatches
 * matching requests to it. Registration needs the `routes` capability, the
 * path stays inside the plugin's own namespace, and every call runs under a
 * time budget so a slow handler cannot wedge the server. Nothing here touches
 * HTTP directly: the server route adapts `IncomingMessage` to
 * `PluginRouteRequest` and writes the returned `PluginRouteResponse`.
 *
 * Matching is a maintained `find-my-way` router (the router Fastify itself
 * uses), one instance per plugin so each keeps its own namespace and one plugin
 * can never see or shadow another's routes. Fastify's router cannot register or
 * remove routes after `ready()`, but `find-my-way`'s add/remove/find API can, so
 * a live reload needs no restart and no Fastify-private mutation.
 *
 * Intentional difference from the previous handwritten matcher: matching was
 * first-registration-wins and is now `find-my-way`'s specificity precedence
 * (a static segment beats a `:param`). The capability, ownership, budget and
 * namespace policies are unchanged.
 */
import Router from "find-my-way";
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

export type RouteResolution =
  | { ok: true; route: RegisteredRoute; handler: PluginRouteHandler; params: Record<string, string> }
  | { ok: false; error: string };

/**
 * The slice of `find-my-way` this facade uses. Declaring it structurally keeps
 * the library's generic handler types out of the kernel contract and out of the
 * plugin-facing surface.
 */
interface FindMyWay {
  on(method: string, path: string, handler: unknown, store: unknown): void;
  off(method: string, path: string): void;
  find(
    method: string,
    path: string,
  ): { handler: unknown; params: Record<string, string | undefined>; store: unknown } | null;
}

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

/** The `find-my-way` pattern for a registration; the mount root is `/`. */
function patternFor(segments: readonly string[]): string {
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/**
 * The concrete path for a request, normalised the way registrations are: a
 * leading/trailing slash is stripped, so the mount root and `a/b/` behave as
 * before. `find-my-way` matches the exact path, so the trailing slash is
 * removed here rather than relying on `ignoreTrailingSlash`.
 */
function requestPath(rawPath: string): string {
  const trimmed = rawPath.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed === "" ? "/" : `/${trimmed}`;
}

/** Only the defined params, as a plain object (never the router's own shape). */
function paramValues(params: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export interface PluginRouteRegistryOptions {
  budgetMs?: number;
  clock?: () => number;
}

/** One plugin's live route table: a matcher plus the ownership index for teardown. */
interface PluginBucket {
  router: FindMyWay;
  entries: Map<string, RegisteredRoute>;
}

export class PluginRouteRegistry {
  private readonly buckets = new Map<string, PluginBucket>();
  private readonly budgetMs: number;
  private readonly clock: () => number;

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

    const route: RegisteredRoute = {
      pluginId: owner.pluginId,
      method: upper as PluginRouteMethod,
      path: segments.join("/"),
    };
    const key = `${upper} ${route.path}`;
    const bucket = this.bucket(owner.pluginId);
    if (bucket.entries.has(key)) {
      throw new Error(
        `Plugin "${owner.pluginId}": route ${upper} /${route.path} is already registered`,
      );
    }
    try {
      bucket.router.on(upper, patternFor(segments), handler, route);
    } catch (error) {
      throw new Error(
        `Plugin "${owner.pluginId}": route ${upper} /${route.path} could not be registered: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    bucket.entries.set(key, route);
    return () => {
      if (!bucket.entries.delete(key)) return;
      bucket.router.off(upper, patternFor(segments));
      if (bucket.entries.size === 0) this.buckets.delete(owner.pluginId);
    };
  }

  /** Remove every route a plugin registered (deactivate, rollback, quarantine). */
  removeOwner(pluginId: string): number {
    const removed = this.buckets.get(pluginId)?.entries.size ?? 0;
    // Dropping the plugin's whole matcher discards its routes atomically.
    this.buckets.delete(pluginId);
    return removed;
  }

  /** Every registered route, oldest first — the plugin manager's diagnostics view. */
  list(): RegisteredRoute[] {
    const out: RegisteredRoute[] = [];
    for (const bucket of this.buckets.values()) {
      for (const route of bucket.entries.values()) out.push(route);
    }
    return out.sort((a, b) => a.pluginId.localeCompare(b.pluginId) || a.path.localeCompare(b.path));
  }

  /** Whether a plugin registered any route at all. */
  hasRoutes(pluginId: string): boolean {
    return (this.buckets.get(pluginId)?.entries.size ?? 0) > 0;
  }

  /**
   * Find the handler for one request. A path that matches another method is
   * reported as such so the caller can answer 405 instead of 404.
   */
  resolve(pluginId: string, method: string, rawPath: string): RouteResolution {
    const upper = method.toUpperCase();
    const bucket = this.buckets.get(pluginId);
    if (bucket === undefined || bucket.entries.size === 0) {
      return { ok: false, error: "no routes registered" };
    }
    const path = requestPath(rawPath);
    const found = bucket.router.find(upper, path);
    if (found !== null) {
      return {
        ok: true,
        route: found.store as RegisteredRoute,
        handler: found.handler as unknown as PluginRouteHandler,
        params: paramValues(found.params),
      };
    }
    // Wrong-method detection is library lookups across the allowed methods, not
    // a second pattern matcher.
    const methodMismatch = PLUGIN_ROUTE_METHODS.some(
      (candidate) => candidate !== upper && bucket.router.find(candidate, path) !== null,
    );
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

  private bucket(pluginId: string): PluginBucket {
    const existing = this.buckets.get(pluginId);
    if (existing !== undefined) return existing;
    const created: PluginBucket = { router: Router() as unknown as FindMyWay, entries: new Map() };
    this.buckets.set(pluginId, created);
    return created;
  }
}
