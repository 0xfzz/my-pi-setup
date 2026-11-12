// HTTP layer of the web password: the /api/auth routes, the request gate, cookies.
// The token logic itself is lib/web-auth/service.ts; this file only maps it onto HTTP.
//
// Browser sessions ride on two HttpOnly, SameSite=Strict cookies, so page script (and any
// XSS in it) can never read a token, and EventSource — which cannot set headers — still
// authenticates:
//   pi_web_at   the short-lived access JWT, sent to every route;
//   pi_web_rt   the long-lived refresh JWT, scoped to /api/auth so it travels nowhere else.
// Programmatic clients can instead ask for the tokens in the response body
// (`returnTokens: true`) and present `Authorization: Bearer <access token>`.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { IssuedTokens, WebAuthService } from "../../../lib/web-auth/service.ts";

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
}

export interface AuthHttp {
  /** Handle /api/auth/*. Returns false for a path that is not an auth route. */
  handleRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /**
   * The gate for every other /api route. True: carry on. False: the response (401, 403,
   * 503) has been sent. Passes everything through when no password is set.
   */
  authorize(req: IncomingMessage, res: ServerResponse, url: URL): boolean;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (header === undefined) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (name !== "" && !(name in cookies)) cookies[name] = part.slice(index + 1).trim();
  }
  return cookies;
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

/** Read a small JSON body, refusing anything larger: these routes are reachable before login. */
async function readSmallJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_AUTH_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createAuthHttp(service: WebAuthService, options: AuthHttpOptions = {}): AuthHttp {
  const trustProxy = options.trustProxy ?? "loopback";
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map((origin) => origin.replace(/\/+$/, "").toLowerCase()));
  // Open connections (event streams) by session, so logout and revocation can cut them.
  const connections = new Map<string, Set<ServerResponse>>();

  service.onRevoke((sessionId) => {
    const targets = sessionId === "all" ? [...connections.keys()] : [sessionId];
    for (const id of targets) {
      for (const res of connections.get(id) ?? []) res.destroy();
      connections.delete(id);
    }
  });

  const proxyTrusted = (req: IncomingMessage): boolean =>
    trustProxy === "all" || (trustProxy === "loopback" && isLoopback(req.socket.remoteAddress));

  /** The address throttling is keyed on: the peer, or the last X-Forwarded-For hop our own proxy appended. */
  const clientKey = (req: IncomingMessage): string => {
    if (proxyTrusted(req)) {
      const forwarded = firstHeader(req.headers["x-forwarded-for"]);
      const last = forwarded?.split(",").at(-1)?.trim();
      if (last !== undefined && last !== "") return last;
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  const secureRequest = (req: IncomingMessage): boolean => {
    if (options.forceSecureCookies === true) return true;
    if ((req.socket as { encrypted?: boolean }).encrypted === true) return true;
    if (proxyTrusted(req) && firstHeader(req.headers["x-forwarded-proto"])?.split(",").at(-1)?.trim() === "https") return true;
    // A browser sets Origin itself; an https page's own requests carry an https origin.
    return (firstHeader(req.headers.origin) ?? "").startsWith("https://");
  };

  /**
   * CSRF defence on top of SameSite=Strict (which sibling subdomains can still get around).
   * Browsers state where a request came from: Sec-Fetch-Site, or at least Origin. A browser
   * request from anywhere but this site is refused; non-browser clients send neither.
   */
  const crossSiteWrite = (req: IncomingMessage): boolean => {
    const method = req.method ?? "GET";
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
    const fetchSite = firstHeader(req.headers["sec-fetch-site"]);
    if (fetchSite !== undefined) return fetchSite !== "same-origin" && fetchSite !== "none";
    const origin = firstHeader(req.headers.origin);
    if (origin === undefined) return false;
    if (allowedOrigins.has(origin.replace(/\/+$/, "").toLowerCase())) return false;
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return true;
    }
    const host = (proxyTrusted(req) ? firstHeader(req.headers["x-forwarded-host"])?.split(",")[0]?.trim() : undefined) ?? req.headers.host;
    return host === undefined || originHost.toLowerCase() !== host.toLowerCase();
  };

  const cookie = (name: string, value: string, path: string, maxAgeSeconds: number, secure: boolean): string =>
    `${name}=${value}; Path=${path}; Max-Age=${Math.max(0, Math.ceil(maxAgeSeconds))}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;

  const accessCookie = (token: string, expiresAt: number, secure: boolean): string =>
    cookie(ACCESS_COOKIE, token, "/", (expiresAt - Date.now()) / 1000, secure);

  const authCookies = (tokens: IssuedTokens, secure: boolean): string[] => [
    accessCookie(tokens.accessToken, tokens.accessExpiresAt, secure),
    cookie(REFRESH_COOKIE, tokens.refreshToken, AUTH_COOKIE_PATH, (tokens.refreshExpiresAt - Date.now()) / 1000, secure),
  ];

  const clearCookies = (secure: boolean): string[] => [
    cookie(ACCESS_COOKIE, "", "/", 0, secure),
    cookie(REFRESH_COOKIE, "", AUTH_COOKIE_PATH, 0, secure),
  ];

  const unavailable = (res: ServerResponse): void => {
    sendJson(res, 503, {
      error: "Password protection is configured but unreadable, so the server is refusing all requests. Run /web set-password again.",
      code: "auth_unavailable",
    });
  };

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

  const accessTokenOf = (req: IncomingMessage): { token: string; viaCookie: boolean } | null => {
    const header = bearer(firstHeader(req.headers.authorization));
    if (header !== null) return { token: header, viaCookie: false };
    const fromCookie = parseCookies(req.headers.cookie)[ACCESS_COOKIE];
    return fromCookie !== undefined && fromCookie !== "" ? { token: fromCookie, viaCookie: true } : null;
  };

  const unauthorized = (res: ServerResponse, code: string, error: string): false => {
    sendJson(res, 401, { error, code }, { "WWW-Authenticate": 'Bearer realm="pi-web"' });
    return false;
  };

  const authorize = (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    const mode = service.mode();
    if (mode === "disabled") return true;
    if (mode === "invalid") {
      unavailable(res);
      return false;
    }

    // The bridge routes are for the pi TUI process, which holds the bridge token. A browser
    // session is deliberately not enough to impersonate a session's owner.
    if (url.pathname.startsWith("/api/bridge/")) {
      const presented = bearer(firstHeader(req.headers.authorization));
      if (presented !== null && service.verifyBridgeToken(presented)) return true;
      return unauthorized(res, "unauthenticated", "The pi bridge token is missing or wrong.");
    }

    const credentials = accessTokenOf(req);
    if (credentials === null) return unauthorized(res, "unauthenticated", "Sign in to continue.");
    const access = service.verifyAccess(credentials.token);
    if (!access.ok) {
      if (access.reason === "unavailable") {
        unavailable(res);
        return false;
      }
      return unauthorized(
        res,
        access.reason === "expired" ? "token_expired" : access.reason === "revoked" ? "session_revoked" : "unauthenticated",
        access.reason === "expired" ? "The access token expired; refresh it." : "Sign in to continue.",
      );
    }
    if (credentials.viaCookie && crossSiteWrite(req)) {
      sendJson(res, 403, { error: "Cross-site request blocked.", code: "cross_site" });
      return false;
    }
    track(access.sessionId, res);
    return true;
  };

  const status = (req: IncomingMessage, res: ServerResponse): void => {
    const mode = service.mode();
    if (mode === "disabled") {
      sendJson(res, 200, { required: false, authenticated: true });
      return;
    }
    if (mode === "invalid") {
      sendJson(res, 200, { required: true, authenticated: false, unavailable: true });
      return;
    }
    const credentials = accessTokenOf(req);
    const access = credentials === null ? null : service.verifyAccess(credentials.token);
    sendJson(res, 200, {
      required: true,
      authenticated: access?.ok === true,
      ...(access?.ok === true ? { accessExpiresAt: access.expiresAt } : {}),
    });
  };

  const login = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const mode = service.mode();
    if (mode === "disabled") {
      sendJson(res, 404, { error: "Password protection is off.", code: "auth_disabled" });
      return;
    }
    if (mode === "invalid") {
      unavailable(res);
      return;
    }
    if (crossSiteWrite(req)) {
      sendJson(res, 403, { error: "Cross-site request blocked.", code: "cross_site" });
      return;
    }
    const body = await readSmallJson(req);
    if (body === null || typeof body.password !== "string") {
      sendJson(res, 400, { error: "Send a JSON body with a password.", code: "bad_request" });
      return;
    }
    const result = await service.login(body.password, clientKey(req), firstHeader(req.headers["user-agent"]));
    if (!result.ok) {
      if (result.reason === "rate_limited") {
        sendJson(res, 429, { error: "Too many attempts. Try again later.", code: "rate_limited", retryAfterSeconds: result.retryAfterSeconds }, {
          "Retry-After": String(result.retryAfterSeconds),
        });
      } else if (result.reason === "unavailable") {
        unavailable(res);
      } else {
        sendJson(res, 401, { error: "Wrong password.", code: "invalid_credentials" });
      }
      return;
    }
    const { tokens } = result;
    if (body.returnTokens === true) {
      sendJson(res, 200, {
        ok: true,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessExpiresAt: tokens.accessExpiresAt,
        refreshExpiresAt: tokens.refreshExpiresAt,
      });
      return;
    }
    sendJson(
      res,
      200,
      { ok: true, accessExpiresAt: tokens.accessExpiresAt, refreshExpiresAt: tokens.refreshExpiresAt },
      { "Set-Cookie": authCookies(tokens, secureRequest(req)) },
    );
  };

  const refresh = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const mode = service.mode();
    if (mode === "disabled") {
      sendJson(res, 404, { error: "Password protection is off.", code: "auth_disabled" });
      return;
    }
    if (mode === "invalid") {
      unavailable(res);
      return;
    }
    const body = await readSmallJson(req);
    if (body === null) {
      sendJson(res, 400, { error: "Invalid request body.", code: "bad_request" });
      return;
    }
    // A token in the body is the programmatic mode (answered in the body); otherwise the cookie.
    const bodyToken = typeof body.refreshToken === "string" ? body.refreshToken : null;
    const cookieToken = parseCookies(req.headers.cookie)[REFRESH_COOKIE];
    const viaBody = bodyToken !== null;
    if (!viaBody && crossSiteWrite(req)) {
      sendJson(res, 403, { error: "Cross-site request blocked.", code: "cross_site" });
      return;
    }
    const token = bodyToken ?? (cookieToken !== undefined && cookieToken !== "" ? cookieToken : null);
    const secure = secureRequest(req);
    if (token === null) {
      sendJson(res, 401, { error: "No refresh token.", code: "refresh_missing" }, viaBody ? {} : { "Set-Cookie": clearCookies(secure) });
      return;
    }

    const result = service.refresh(token);
    if (!result.ok) {
      if (result.reason === "unavailable") {
        unavailable(res);
        return;
      }
      const code = result.reason === "reuse_detected" ? "refresh_reuse" : result.reason === "expired" ? "refresh_expired" : "refresh_invalid";
      sendJson(res, 401, { error: "Sign in again.", code }, viaBody ? {} : { "Set-Cookie": clearCookies(secure) });
      return;
    }
    if (result.rotated) {
      const { tokens } = result;
      const payload = { ok: true, accessExpiresAt: tokens.accessExpiresAt, refreshExpiresAt: tokens.refreshExpiresAt };
      if (viaBody) {
        sendJson(res, 200, { ...payload, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
      } else {
        sendJson(res, 200, payload, { "Set-Cookie": authCookies(tokens, secure) });
      }
      return;
    }
    // A duplicate of a refresh that just succeeded: a new access token, and the refresh
    // cookie the other request set is left alone (setting the older one would undo it).
    if (viaBody) {
      sendJson(res, 200, { ok: true, accessExpiresAt: result.accessExpiresAt, accessToken: result.accessToken });
    } else {
      sendJson(res, 200, { ok: true, accessExpiresAt: result.accessExpiresAt }, { "Set-Cookie": accessCookie(result.accessToken, result.accessExpiresAt, secure) });
    }
  };

  const logout = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const secure = secureRequest(req);
    const body = await readSmallJson(req);
    const bodyToken = typeof body?.refreshToken === "string" ? body.refreshToken : null;
    if (bodyToken === null && crossSiteWrite(req)) {
      sendJson(res, 403, { error: "Cross-site request blocked.", code: "cross_site" });
      return;
    }
    const cookies = parseCookies(req.headers.cookie);
    const refreshToken = bodyToken ?? cookies[REFRESH_COOKIE];
    let sessionId = refreshToken !== undefined ? service.sessionOfRefreshToken(refreshToken) : null;
    if (sessionId === null) {
      const credentials = accessTokenOf(req);
      const access = credentials === null ? null : service.verifyAccess(credentials.token);
      if (access?.ok === true) sessionId = access.sessionId;
    }
    if (sessionId !== null) service.logout(sessionId);
    sendJson(res, 200, { ok: true }, bodyToken === null ? { "Set-Cookie": clearCookies(secure) } : {});
  };

  const handleRoute = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const route = url.pathname;
    if (route !== "/api/auth/status" && route !== "/api/auth/login" && route !== "/api/auth/refresh" && route !== "/api/auth/logout") {
      return false;
    }
    const expected = route === "/api/auth/status" ? "GET" : "POST";
    if (req.method !== expected) {
      sendJson(res, 405, { error: "method not allowed" }, { Allow: expected });
      return true;
    }
    if (route === "/api/auth/status") status(req, res);
    else if (route === "/api/auth/login") await login(req, res);
    else if (route === "/api/auth/refresh") await refresh(req, res);
    else await logout(req, res);
    return true;
  };

  return { handleRoute, authorize };
}
