// HTTP layer of the web password: the /api/auth routes and the request gate.
// The token logic itself is web/core/auth/service.ts; this file only maps it
// onto HTTP.
//
// Browser sessions ride on two HttpOnly, SameSite=Strict cookies, so page script
// (and any XSS in it) can never read a token, and EventSource — which cannot set
// headers — still authenticates:
//   pi_web_at   the short-lived access JWT, sent to every route;
//   pi_web_rt   the long-lived refresh JWT, scoped to /api/auth so it travels nowhere else.
// Programmatic clients can instead ask for the tokens in the response body
// (`returnTokens: true`) and present `Authorization: Bearer <access token>`.
//
// Cookie parsing and serialization are @fastify/cookie's: the gate reads
// `request.cookies` and the routes call `reply.setCookie`/`clearCookie`. Only the
// cookie *policy* (names, paths, expiry, Secure detection, credential
// precedence) stays here. The four routes are native Fastify routes.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { IssuedTokens, WebAuthService } from "../auth/service.ts";
import { registerLenientJsonParser, parsedJsonBody } from "../http/json-body.ts";
import { registerMethodFallback } from "../http/method-fallback.ts";
import { CSRF_HEADER, CSRF_HEADER_VALUE } from "../shared/csrf.ts";
import { AUTH_LOGIN_SCHEMA, AUTH_REFRESH_SCHEMA, PERMISSIVE_BODY_SCHEMA, coreRequestSchema } from "./request-schemas.ts";

export const ACCESS_COOKIE = "pi_web_at";
export const REFRESH_COOKIE = "pi_web_rt";
const AUTH_COOKIE_PATH = "/api/auth";
const MAX_AUTH_BODY_BYTES = 4096;

export interface AuthHttpOptions {
  /** "all": believe X-Forwarded-* from any peer. "off": never. Default: only from a loopback peer (a local proxy or tunnel). */
  trustProxy?: "all" | "off" | "loopback";
  /** Extra origins (scheme://host[:port]) allowed to make state-changing requests. */
  allowedOrigins?: readonly string[];
  /** Mark cookies Secure even when the request does not look like HTTPS. */
  forceSecureCookies?: boolean;
  /**
   * Require the first-party CSRF header on cookie-authenticated writes, even
   * when a stripped Origin/Sec-Fetch-Site leaves the browser check blind.
   */
  requireCsrfHeader?: boolean;
}

/** What the gate needs from the request; a FastifyRequest satisfies it structurally. */
export type AuthGateRequest = FastifyRequest;
export type AuthGateReply = FastifyReply;

export interface AuthHttp {
  /**
   * The gate for every /api route. True: carry on. False: the response (401, 403,
   * 503) has been sent through Fastify. Passes everything through when no
   * password is set.
   */
  authorize(request: AuthGateRequest, reply: AuthGateReply, url: URL): boolean;
  /**
   * Destroy any remaining tracked responses and forget them. The app's
   * `onClose` hook releases this tracking after Fastify starts force-closing
   * sockets; forceCloseConnections, not this callback, bounds socket shutdown.
   */
  close(): void;
}

interface CookiePolicy {
  readonly trustProxy: "all" | "off" | "loopback";
  readonly allowedOrigins: Set<string>;
  readonly forceSecureCookies: boolean;
  readonly requireCsrfHeader: boolean;
}

function policyOf(options: AuthHttpOptions): CookiePolicy {
  return {
    trustProxy: options.trustProxy ?? "loopback",
    allowedOrigins: new Set((options.allowedOrigins ?? []).map((origin) => origin.replace(/\/+$/, "").toLowerCase())),
    forceSecureCookies: options.forceSecureCookies === true,
    requireCsrfHeader: options.requireCsrfHeader === true,
  };
}

function bearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function proxyTrusted(req: IncomingMessage, policy: CookiePolicy): boolean {
  return policy.trustProxy === "all" || (policy.trustProxy === "loopback" && isLoopback(req.socket.remoteAddress));
}

/**
 * The address throttling is keyed on: the peer, or the last X-Forwarded-For hop
 * our own proxy appended (so a client cannot spoof the key by prepending).
 */
function clientKey(req: IncomingMessage, policy: CookiePolicy): string {
  if (proxyTrusted(req, policy)) {
    const forwarded = firstHeader(req.headers["x-forwarded-for"]);
    const last = forwarded?.split(",").at(-1)?.trim();
    if (last !== undefined && last !== "") return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}

function secureRequest(req: IncomingMessage, policy: CookiePolicy): boolean {
  if (policy.forceSecureCookies) return true;
  if ((req.socket as { encrypted?: boolean }).encrypted === true) return true;
  if (proxyTrusted(req, policy) && firstHeader(req.headers["x-forwarded-proto"])?.split(",").at(-1)?.trim() === "https") return true;
  // A browser sets Origin itself; an https page's own requests carry an https origin.
  return (firstHeader(req.headers.origin) ?? "").startsWith("https://");
}

/**
 * CSRF defence on top of SameSite=Strict (which sibling subdomains can still get
 * around). Browsers state where a request came from: Sec-Fetch-Site, or at least
 * Origin. A browser request from anywhere but this site is refused; non-browser
 * clients send neither.
 */
function crossSiteWrite(req: IncomingMessage, policy: CookiePolicy): boolean {
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  // A programmatic client with no cookie keeps the historical bearer/body-token
  // flow: only cookie-authenticated writes need the extra header.
  if (policy.requireCsrfHeader && req.headers.cookie !== undefined
    && firstHeader(req.headers[CSRF_HEADER]) !== CSRF_HEADER_VALUE) return true;
  const fetchSite = firstHeader(req.headers["sec-fetch-site"]);
  if (fetchSite !== undefined) return fetchSite !== "same-origin" && fetchSite !== "none";
  const origin = firstHeader(req.headers.origin);
  if (origin === undefined) return false;
  if (policy.allowedOrigins.has(origin.replace(/\/+$/, "").toLowerCase())) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  const host = (proxyTrusted(req, policy) ? firstHeader(req.headers["x-forwarded-host"])?.split(",")[0]?.trim() : undefined) ?? req.headers.host;
  return host === undefined || originHost.toLowerCase() !== host.toLowerCase();
}

function cookieOptions(path: string, maxAgeSeconds: number, secure: boolean) {
  return {
    path,
    maxAge: Math.max(0, Math.ceil(maxAgeSeconds)),
    httpOnly: true,
    sameSite: "strict" as const,
    secure,
  };
}

function json(reply: FastifyReply, status: number, body: unknown): void {
  void reply.code(status).header("cache-control", "no-store").send(body);
}

/**
 * Parse an auth body the way the handwritten `readSmallJson` did: `{}` for an
 * empty body, an object or `null` (unusable) otherwise. The route's scoped
 * parser has already capped the byte length, so this only maps the shape.
 */
function parseAuthBody(request: FastifyRequest): Record<string, unknown> | null {
  try {
    const value = parsedJsonBody(request);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function setAuthCookies(reply: FastifyReply, tokens: IssuedTokens, secure: boolean): void {
  reply.setCookie(ACCESS_COOKIE, tokens.accessToken, cookieOptions("/", (tokens.accessExpiresAt - Date.now()) / 1000, secure));
  reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, cookieOptions(AUTH_COOKIE_PATH, (tokens.refreshExpiresAt - Date.now()) / 1000, secure));
}

function clearAuthCookies(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(ACCESS_COOKIE, cookieOptions("/", 0, secure));
  reply.clearCookie(REFRESH_COOKIE, cookieOptions(AUTH_COOKIE_PATH, 0, secure));
}

function unavailable(reply: FastifyReply): void {
  json(reply, 503, {
    error: "Password protection is configured but unreadable, so the server is refusing all requests. Run /web set-password again.",
    code: "auth_unavailable",
  });
}

// ── Route handlers ──────────────────────────────────────────────────────────

function handleStatus(service: WebAuthService, policy: CookiePolicy, request: FastifyRequest, reply: FastifyReply): void {
  const mode = service.mode();
  if (mode === "disabled") {
    json(reply, 200, { required: false, authenticated: true });
    return;
  }
  if (mode === "invalid") {
    json(reply, 200, { required: true, authenticated: false, unavailable: true });
    return;
  }
  const credentials = accessTokenOf(request);
  const access = credentials === null ? null : service.verifyAccess(credentials.token);
  json(reply, 200, {
    required: true,
    authenticated: access?.ok === true,
    ...(access?.ok === true ? { accessExpiresAt: access.expiresAt } : {}),
  });
}

async function handleLogin(service: WebAuthService, policy: CookiePolicy, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const mode = service.mode();
  if (mode === "disabled") {
    json(reply, 404, { error: "Password protection is off.", code: "auth_disabled" });
    return;
  }
  if (mode === "invalid") {
    unavailable(reply);
    return;
  }
  if (crossSiteWrite(request.raw, policy)) {
    json(reply, 403, { error: "Cross-site request blocked.", code: "cross_site" });
    return;
  }
  const body = parseAuthBody(request);
  if (body === null || request.validationError) {
    json(reply, 400, { error: "Send a JSON body with a password.", code: "bad_request" });
    return;
  }
  const result = await service.login(body.password as string, clientKey(request.raw, policy), firstHeader(request.headers["user-agent"]));
  if (!result.ok) {
    if (result.reason === "rate_limited") {
      void reply
        .code(429)
        .header("cache-control", "no-store")
        .header("retry-after", String(result.retryAfterSeconds))
        .send({ error: "Too many attempts. Try again later.", code: "rate_limited", retryAfterSeconds: result.retryAfterSeconds });
    } else if (result.reason === "unavailable") {
      unavailable(reply);
    } else {
      json(reply, 401, { error: "Wrong password.", code: "invalid_credentials" });
    }
    return;
  }
  const { tokens } = result;
  if (body.returnTokens === true) {
    json(reply, 200, {
      ok: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAt: tokens.accessExpiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt,
    });
    return;
  }
  setAuthCookies(reply, tokens, secureRequest(request.raw, policy));
  json(reply, 200, { ok: true, accessExpiresAt: tokens.accessExpiresAt, refreshExpiresAt: tokens.refreshExpiresAt });
}

function handleRefresh(service: WebAuthService, policy: CookiePolicy, request: FastifyRequest, reply: FastifyReply): void {
  const mode = service.mode();
  if (mode === "disabled") {
    json(reply, 404, { error: "Password protection is off.", code: "auth_disabled" });
    return;
  }
  if (mode === "invalid") {
    unavailable(reply);
    return;
  }
  const body = parseAuthBody(request);
  if (body === null || request.validationError) {
    json(reply, 400, { error: "Invalid request body.", code: "bad_request" });
    return;
  }
  // A token in the body is the programmatic mode (answered in the body); otherwise the cookie.
  const bodyToken = typeof body.refreshToken === "string" ? body.refreshToken : null;
  const cookieToken = request.cookies[REFRESH_COOKIE];
  const viaBody = bodyToken !== null;
  if (!viaBody && crossSiteWrite(request.raw, policy)) {
    json(reply, 403, { error: "Cross-site request blocked.", code: "cross_site" });
    return;
  }
  const token = bodyToken ?? (cookieToken !== undefined && cookieToken !== "" ? cookieToken : null);
  const secure = secureRequest(request.raw, policy);
  if (token === null) {
    if (!viaBody) clearAuthCookies(reply, secure);
    json(reply, 401, { error: "No refresh token.", code: "refresh_missing" });
    return;
  }

  const result = service.refresh(token);
  if (!result.ok) {
    if (result.reason === "unavailable") {
      unavailable(reply);
      return;
    }
    if (!viaBody) clearAuthCookies(reply, secure);
    const code = result.reason === "reuse_detected" ? "refresh_reuse" : result.reason === "expired" ? "refresh_expired" : "refresh_invalid";
    json(reply, 401, { error: "Sign in again.", code });
    return;
  }
  if (result.rotated) {
    const payload = { ok: true, accessExpiresAt: result.tokens.accessExpiresAt, refreshExpiresAt: result.tokens.refreshExpiresAt };
    if (viaBody) {
      json(reply, 200, { ...payload, accessToken: result.tokens.accessToken, refreshToken: result.tokens.refreshToken });
    } else {
      setAuthCookies(reply, result.tokens, secure);
      json(reply, 200, payload);
    }
    return;
  }
  // A duplicate of a refresh that just succeeded: a new access token, and the
  // refresh cookie the other request set is left alone.
  if (viaBody) {
    json(reply, 200, { ok: true, accessExpiresAt: result.accessExpiresAt, accessToken: result.accessToken });
  } else {
    reply.setCookie(ACCESS_COOKIE, result.accessToken, cookieOptions("/", (result.accessExpiresAt - Date.now()) / 1000, secure));
    json(reply, 200, { ok: true, accessExpiresAt: result.accessExpiresAt });
  }
}

function handleLogout(service: WebAuthService, policy: CookiePolicy, request: FastifyRequest, reply: FastifyReply): void {
  const secure = secureRequest(request.raw, policy);
  const body = parseAuthBody(request) ?? {};
  const bodyToken = typeof body.refreshToken === "string" ? body.refreshToken : null;
  if (bodyToken === null && crossSiteWrite(request.raw, policy)) {
    json(reply, 403, { error: "Cross-site request blocked.", code: "cross_site" });
    return;
  }
  const cookieToken = request.cookies[REFRESH_COOKIE];
  const refreshToken = bodyToken ?? cookieToken;
  let sessionId = refreshToken !== undefined ? service.sessionOfRefreshToken(refreshToken) : null;
  if (sessionId === null) {
    const credentials = accessTokenOf(request);
    const access = credentials === null ? null : service.verifyAccess(credentials.token);
    if (access?.ok === true) sessionId = access.sessionId;
  }
  if (sessionId !== null) service.logout(sessionId);
  if (bodyToken === null) clearAuthCookies(reply, secure);
  json(reply, 200, { ok: true });
}

// ── Routes ──────────────────────────────────────────────────────────────────

interface AuthRouteSpec {
  path: string;
  method: "GET" | "POST";
  handle: (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;
  body?: Record<string, unknown>;
}

/**
 * Register the four public auth endpoints as native Fastify routes. The body
 * reader is scoped here with a 4,096-byte limit that Fastify enforces as bytes
 * arrive; the scope's error handler maps an over-limit (or unparseable) body
 * back to the historical per-endpoint answer instead of a global 413.
 */
export async function registerAuthRoutes(
  app: FastifyInstance,
  service: WebAuthService,
  options: AuthHttpOptions = {},
): Promise<void> {
  const policy = policyOf(options);
  await app.register(async (scope) => {
    registerLenientJsonParser(scope);
    scope.setErrorHandler((error, request, reply) => {
      const code = (error as { code?: string }).code;
      if (code === "FST_ERR_CTP_BODY_TOO_LARGE") {
        const pathname = new URL(request.url, "http://localhost").pathname;
        // Logout historically treated an unusable body as absent and cleared the
        // cookies; the other endpoints answered 400, never a global 413.
        if (pathname === "/api/auth/logout") {
          clearAuthCookies(reply, secureRequest(request.raw, policy));
          json(reply, 200, { ok: true });
          return;
        }
        json(reply, 400, { error: "Invalid request body.", code: "bad_request" });
        return;
      }
      json(reply, 500, { error: "internal error" });
    });

    const routes: readonly AuthRouteSpec[] = [
      { path: "/api/auth/status", method: "GET", handle: (request, reply) => handleStatus(service, policy, request, reply) },
      { path: "/api/auth/login", method: "POST", body: AUTH_LOGIN_SCHEMA, handle: (request, reply) => handleLogin(service, policy, request, reply) },
      { path: "/api/auth/refresh", method: "POST", body: AUTH_REFRESH_SCHEMA, handle: (request, reply) => handleRefresh(service, policy, request, reply) },
      { path: "/api/auth/logout", method: "POST", handle: (request, reply) => handleLogout(service, policy, request, reply) },
    ];
    for (const route of routes) {
      scope.route({
        method: route.method, url: route.path, bodyLimit: MAX_AUTH_BODY_BYTES,
        attachValidation: true,
        schema: coreRequestSchema({ path: route.path, ...(route.method === "POST" ? { body: route.body ?? PERMISSIVE_BODY_SCHEMA } : {}) }),
        handler: route.handle,
      });
      registerMethodFallback(scope, {
        path: route.path, methods: [route.method],
        refuse: async (_request, reply) => {
          void reply.code(405).header("allow", route.method).header("cache-control", "no-store").send({ error: "method not allowed" });
        },
      });
    }
  });
}

// ── The request gate ────────────────────────────────────────────────────────

/** The credential the request presents: the Bearer header first, then the access cookie. */
function accessTokenOf(request: { headers: Record<string, string | string[] | undefined>; cookies: Record<string, string | undefined> }): { token: string; viaCookie: boolean } | null {
  const header = bearer(firstHeader(request.headers.authorization));
  if (header !== null) return { token: header, viaCookie: false };
  const fromCookie = request.cookies[ACCESS_COOKIE];
  return fromCookie !== undefined && fromCookie !== "" ? { token: fromCookie, viaCookie: true } : null;
}

export function createAuthHttp(service: WebAuthService, options: AuthHttpOptions = {}): AuthHttp {
  const policy = policyOf(options);
  // Open connections (event streams) by session, so logout and revocation can cut them.
  const connections = new Map<string, Set<ServerResponse>>();

  service.onRevoke((sessionId) => {
    const targets = sessionId === "all" ? [...connections.keys()] : [sessionId];
    for (const id of targets) {
      for (const res of connections.get(id) ?? []) res.destroy();
      connections.delete(id);
    }
  });

  const track = (sessionId: string, res: ServerResponse): void => {
    let set = connections.get(sessionId);
    if (set === undefined) {
      set = new Set();
      connections.set(sessionId, set);
    }
    const owned = set;
    owned.add(res);
    res.once("close", () => {
      owned.delete(res);
      if (owned.size === 0 && connections.get(sessionId) === owned) connections.delete(sessionId);
    });
  };

  const unauthorized = (reply: FastifyReply, code: string, error: string): false => {
    void reply.code(401).header("cache-control", "no-store").header("www-authenticate", 'Bearer realm="pi-web"').send({ error, code });
    return false;
  };

  const authorize = (request: AuthGateRequest, reply: AuthGateReply, url: URL): boolean => {
    const res = reply.raw;
    const mode = service.mode();
    if (mode === "disabled") return true;
    if (mode === "invalid") {
      unavailable(reply);
      return false;
    }

    // The bridge routes are for the pi TUI process, which holds the bridge token. A browser
    // session is deliberately not enough to impersonate a session's owner.
    if (url.pathname.startsWith("/api/bridge/")) {
      const presented = bearer(firstHeader(request.headers.authorization));
      if (presented !== null && service.verifyBridgeToken(presented)) return true;
      return unauthorized(reply, "unauthenticated", "The pi bridge token is missing or wrong.");
    }

    const credentials = accessTokenOf(request);
    if (credentials === null) return unauthorized(reply, "unauthenticated", "Sign in to continue.");
    const access = service.verifyAccess(credentials.token);
    if (!access.ok) {
      if (access.reason === "unavailable") {
        unavailable(reply);
        return false;
      }
      return unauthorized(
        reply,
        access.reason === "expired" ? "token_expired" : access.reason === "revoked" ? "session_revoked" : "unauthenticated",
        access.reason === "expired" ? "The access token expired; refresh it." : "Sign in to continue.",
      );
    }
    if (credentials.viaCookie && crossSiteWrite(request.raw, policy)) {
      json(reply, 403, { error: "Cross-site request blocked.", code: "cross_site" });
      return false;
    }
    track(access.sessionId, res);
    return true;
  };

  const close = (): void => {
    for (const set of connections.values()) {
      for (const res of set) res.destroy();
    }
    connections.clear();
  };

  return { authorize, close };
}
