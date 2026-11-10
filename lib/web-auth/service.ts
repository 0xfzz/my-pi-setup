/**
 * The web auth service: password login, short-lived JWT access tokens, and rotating
 * long-lived JWT refresh tokens. HTTP-agnostic — web/server/auth.ts maps it to routes
 * and cookies, and tests drive it with a fake clock.
 *
 * Token model (the standard rotation-with-reuse-detection design):
 *   access token   15 min, HS256 JWT, checked on every request. Also checked against the
 *                  live session, so logout and reuse revocation bite immediately.
 *   refresh token  30 days sliding, 1 year absolute, HS256 JWT under a different key.
 *                  Each use returns a new one and retires the old one.
 *
 * What keeps ordinary use from breaking (the failure this design is built around):
 *   - the access token carries its expiry, so a client refreshes *before* it lapses;
 *   - a refresh presented again within `rotationGraceSeconds` of its rotation is the
 *     benign "two requests refreshed at once" case: it gets a fresh access token and
 *     the session survives. Only a retired token used after that window counts as a
 *     leak and revokes the family;
 *   - clock skew is tolerated (`leewaySeconds`);
 *   - the signing key and sessions survive restarts, and a password change rotates the
 *     key, so it signs everything out at once.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { WebAuthConfigCache, webAuthSessionsPath, type WebAuthConfig } from "./config.ts";
import { JWT_AUDIENCE, JWT_ISSUER, deriveKey, signJwt, verifyJwt, type JwtClaims, type TokenUse } from "./jwt.ts";
import { verifyPassword } from "./password.ts";
import { RefreshFamilyStore, type RefreshFamily } from "./refresh-store.ts";
import { DEFAULT_THROTTLE, LoginThrottle, type ThrottleOptions } from "./throttle.ts";

const DAY_SECONDS = 24 * 60 * 60;
const SUBJECT = "owner";

export interface WebAuthOptions {
  /** Path of web-auth.json; null disables protection entirely (tests, no config). */
  configPath: string | null;
  /** Where refresh families persist; undefined derives it beside the config, null keeps them in memory. */
  sessionsPath?: string | null;
  now?: () => number;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
  absoluteTtlSeconds?: number;
  rotationGraceSeconds?: number;
  leewaySeconds?: number;
  throttle?: Partial<ThrottleOptions>;
}

export type AuthMode = "disabled" | "enabled" | "invalid";

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds, so clients can schedule a refresh without decoding the JWT. */
  accessExpiresAt: number;
  refreshExpiresAt: number;
  sessionId: string;
}

export type LoginResult =
  | { ok: true; tokens: IssuedTokens }
  | { ok: false; reason: "invalid_credentials" }
  | { ok: false; reason: "rate_limited"; retryAfterSeconds: number }
  | { ok: false; reason: "unavailable" };

export type RefreshResult =
  | { ok: true; rotated: true; tokens: IssuedTokens }
  /** Concurrent duplicate within the grace window: a new access token only, the cookie jar already holds the newer refresh token. */
  | { ok: true; rotated: false; accessToken: string; accessExpiresAt: number; sessionId: string }
  | { ok: false; reason: "invalid" | "expired" | "reuse_detected" | "unavailable" };

export type AccessResult =
  | { ok: true; sessionId: string; expiresAt: number }
  | { ok: false; reason: "expired" | "invalid" | "revoked" | "unavailable" };

type RevokeListener = (sessionId: string | "all") => void;

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();

/** Constant-time string equality (compares digests, so length is not leaked either). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

export class WebAuthService {
  readonly #cache: WebAuthConfigCache | null;
  readonly #store: RefreshFamilyStore;
  readonly #throttle: LoginThrottle;
  readonly #now: () => number;
  readonly #accessTtl: number;
  readonly #refreshTtl: number;
  readonly #absoluteTtl: number;
  readonly #graceMs: number;
  readonly #leeway: number;
  readonly #listeners = new Set<RevokeListener>();
  #keys: { kid: string; access: Buffer; refresh: Buffer } | null = null;

  constructor(options: WebAuthOptions) {
    this.#now = options.now ?? (() => Date.now());
    this.#cache = options.configPath === null ? null : new WebAuthConfigCache(options.configPath);
    const sessionsPath =
      options.sessionsPath === undefined
        ? options.configPath === null
          ? null
          : webAuthSessionsPath(options.configPath)
        : options.sessionsPath;
    this.#store = new RefreshFamilyStore(sessionsPath, this.#now);
    this.#throttle = new LoginThrottle({ ...DEFAULT_THROTTLE, ...options.throttle }, this.#now);
    this.#accessTtl = options.accessTtlSeconds ?? 15 * 60;
    this.#refreshTtl = options.refreshTtlSeconds ?? 30 * DAY_SECONDS;
    this.#absoluteTtl = options.absoluteTtlSeconds ?? 365 * DAY_SECONDS;
    this.#graceMs = (options.rotationGraceSeconds ?? 10) * 1000;
    this.#leeway = options.leewaySeconds ?? 5;
  }

  /** Notified when sessions are revoked (one id, or "all"): the HTTP layer drops their open streams. */
  onRevoke(listener: RevokeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Whether requests need credentials. `invalid` means a config exists but is unusable: callers must refuse, not serve. */
  mode(): AuthMode {
    return this.#sync().mode;
  }

  /** The config problem when `mode()` is "invalid". */
  invalidReason(): string | null {
    const loaded = this.#cache?.get();
    return loaded?.state === "invalid" ? loaded.reason : null;
  }

  /** The credential the pi TUI presents on the bridge routes. */
  verifyBridgeToken(token: string): boolean {
    const { config } = this.#sync();
    return config !== null && safeEqual(token, config.bridgeToken);
  }

  accessTtlSeconds(): number {
    return this.#accessTtl;
  }

  async login(password: string, client: string, userAgent?: string): Promise<LoginResult> {
    const state = this.#sync();
    if (state.mode !== "enabled" || state.config === null) return { ok: false, reason: "unavailable" };
    const decision = this.#throttle.check(client);
    if (!decision.allowed) return { ok: false, reason: "rate_limited", retryAfterSeconds: decision.retryAfterSeconds };

    // Charge the attempt before the slow hash so parallel guesses cannot slip past the limit.
    this.#throttle.failure(client);
    const valid = await verifyPassword(password, state.config.passwordHash);
    // The password may have been changed while scrypt ran; a login must not outlive that.
    if (valid && this.#sync().config?.passwordHash !== state.config.passwordHash) {
      return { ok: false, reason: "invalid_credentials" };
    }
    if (!valid) return { ok: false, reason: "invalid_credentials" };
    this.#throttle.success(client);

    const now = this.#now();
    const family: RefreshFamily = {
      id: randomUUID(),
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + this.#refreshTtl * 1000,
      absoluteExpiresAt: now + this.#absoluteTtl * 1000,
      currentJti: randomUUID(),
      ...(userAgent !== undefined ? { userAgent: userAgent.slice(0, 200) } : {}),
    };
    this.#store.create(family);
    return { ok: true, tokens: this.#issue(family) };
  }

  refresh(refreshToken: string): RefreshResult {
    const keys = this.#sync().keys;
    if (keys === null) return { ok: false, reason: "unavailable" };
    const verified = verifyJwt(refreshToken, {
      key: keys.refresh,
      kid: keys.kid,
      use: "refresh",
      now: this.#now(),
      leewaySeconds: this.#leeway,
    });
    if (!verified.ok) return { ok: false, reason: verified.reason === "expired" ? "expired" : "invalid" };
    const { claims } = verified;

    const family = this.#store.get(claims.sid);
    if (family === undefined) return { ok: false, reason: "invalid" };
    const now = this.#now();
    if (family.absoluteExpiresAt <= now || family.expiresAt <= now) {
      this.#revoke(family.id);
      return { ok: false, reason: "expired" };
    }

    if (claims.jti === family.currentJti) {
      family.previousJti = family.currentJti;
      family.currentJti = randomUUID();
      family.rotatedAt = now;
      family.lastUsedAt = now;
      family.expiresAt = Math.min(now + this.#refreshTtl * 1000, family.absoluteExpiresAt);
      this.#store.update(family);
      return { ok: true, rotated: true, tokens: this.#issue(family) };
    }

    if (
      claims.jti === family.previousJti &&
      family.rotatedAt !== undefined &&
      now - family.rotatedAt <= this.#graceMs
    ) {
      const access = this.#signAccess(family.id, keys);
      return { ok: true, rotated: false, accessToken: access.token, accessExpiresAt: access.expiresAt, sessionId: family.id };
    }

    // A retired token, used after the grace window: someone is replaying a copy.
    this.#revoke(family.id);
    return { ok: false, reason: "reuse_detected" };
  }

  verifyAccess(accessToken: string): AccessResult {
    const keys = this.#sync().keys;
    if (keys === null) return { ok: false, reason: "unavailable" };
    const verified = verifyJwt(accessToken, {
      key: keys.access,
      kid: keys.kid,
      use: "access",
      now: this.#now(),
      leewaySeconds: this.#leeway,
    });
    if (!verified.ok) return { ok: false, reason: verified.reason === "expired" ? "expired" : "invalid" };
    // The session must still exist: logout and reuse revocation take effect on the next request.
    const family = this.#store.get(verified.claims.sid);
    if (family === undefined || family.absoluteExpiresAt <= this.#now()) return { ok: false, reason: "revoked" };
    return { ok: true, sessionId: family.id, expiresAt: verified.claims.exp * 1000 };
  }

  /** The session a refresh token belongs to, if its signature is genuine (an expired one still identifies its session for logout). */
  sessionOfRefreshToken(refreshToken: string): string | null {
    const keys = this.#sync().keys;
    if (keys === null) return null;
    const verified = verifyJwt(refreshToken, {
      key: keys.refresh,
      kid: keys.kid,
      use: "refresh",
      now: this.#now(),
      leewaySeconds: Number.MAX_SAFE_INTEGER / 4,
    });
    return verified.ok ? verified.claims.sid : null;
  }

  logout(sessionId: string): void {
    this.#sync();
    this.#revoke(sessionId);
  }

  #revoke(sessionId: string): void {
    if (this.#store.revoke(sessionId)) {
      for (const listener of this.#listeners) listener(sessionId);
    }
  }

  /** Reload the config if the file changed, and keep keys and sessions bound to it. */
  #sync(): { mode: AuthMode; config: WebAuthConfig | null; keys: { kid: string; access: Buffer; refresh: Buffer } | null } {
    const loaded = this.#cache?.get() ?? { state: "disabled" as const };
    if (loaded.state === "enabled") {
      if (this.#keys?.kid !== loaded.kid) {
        const secret = Buffer.from(loaded.config.secret, "base64url");
        this.#keys = { kid: loaded.kid, access: deriveKey(secret, "access"), refresh: deriveKey(secret, "refresh") };
        if (this.#store.bind(loaded.kid)) {
          for (const listener of this.#listeners) listener("all");
        }
      }
      return { mode: "enabled", config: loaded.config, keys: this.#keys };
    }
    if (this.#keys !== null) {
      // Protection was turned off (or the file broke): no old token may be honored.
      this.#keys = null;
      this.#store.unbind();
      for (const listener of this.#listeners) listener("all");
    }
    return { mode: loaded.state, config: null, keys: null };
  }

  #issue(family: RefreshFamily): IssuedTokens {
    const keys = this.#keys;
    if (keys === null) throw new Error("web auth is not enabled");
    const now = this.#now();
    const iat = Math.floor(now / 1000);
    const refreshExp = Math.floor(family.expiresAt / 1000);
    const refreshClaims: JwtClaims = {
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      sub: SUBJECT,
      use: "refresh",
      iat,
      exp: refreshExp,
      jti: family.currentJti,
      sid: family.id,
    };
    const access = this.#signAccess(family.id, keys);
    return {
      accessToken: access.token,
      refreshToken: signJwt(refreshClaims, keys.refresh, keys.kid),
      accessExpiresAt: access.expiresAt,
      refreshExpiresAt: refreshExp * 1000,
      sessionId: family.id,
    };
  }

  #signAccess(sessionId: string, keys: { kid: string; access: Buffer }): { token: string; expiresAt: number } {
    const iat = Math.floor(this.#now() / 1000);
    const exp = iat + this.#accessTtl;
    const use: TokenUse = "access";
    const claims: JwtClaims = {
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      sub: SUBJECT,
      use,
      iat,
      exp,
      jti: randomUUID(),
      sid: sessionId,
    };
    return { token: signJwt(claims, keys.access, keys.kid), expiresAt: exp * 1000 };
  }
}
