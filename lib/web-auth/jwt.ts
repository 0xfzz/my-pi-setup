/**
 * Minimal HS256 JWT on node:crypto — no dependency, no algorithm agility.
 *
 * Deliberately narrow, because every flexible JWT library has shipped the
 * same bugs (alg=none, RS/HS confusion, unchecked claims):
 *   - only HS256 is signed or accepted, and the header must say exactly that;
 *   - the signature is compared in constant time before any claim is read;
 *   - issuer, audience, token use (`use`), key id (`kid`) and `exp` are all
 *     required and checked;
 *   - access and refresh tokens use *different* keys (HKDF-derived from the one
 *     stored secret), so one can never be replayed as the other.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export const JWT_ISSUER = "pi-web";
export const JWT_AUDIENCE = "pi-web";
const MAX_TOKEN_LENGTH = 4096;

export type TokenUse = "access" | "refresh";

export interface JwtClaims {
  iss: string;
  aud: string;
  sub: string;
  use: TokenUse;
  /** Issued-at and expiry, in seconds since the epoch. */
  iat: number;
  exp: number;
  jti: string;
  /** Session id (access tokens) / refresh-token family id (refresh tokens). */
  sid: string;
}

export type JwtFailure = "malformed" | "bad_signature" | "wrong_key" | "wrong_claims" | "expired" | "not_yet_valid";

export type JwtResult = { ok: true; claims: JwtClaims } | { ok: false; reason: JwtFailure };

const b64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

/** A purpose-bound key: access and refresh tokens never share key material. */
export function deriveKey(secret: Buffer, purpose: TokenUse): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), `pi-web ${purpose} token v1`, 32));
}

export function signJwt(claims: JwtClaims, key: Buffer, kid: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT", kid }));
  const payload = b64url(JSON.stringify(claims));
  const signature = createHmac("sha256", key).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64url(signature)}`;
}

export interface VerifyOptions {
  key: Buffer;
  kid: string;
  use: TokenUse;
  /** Wall clock in milliseconds. */
  now: number;
  /** Tolerated clock skew in seconds, applied to `exp` and `iat`. */
  leewaySeconds: number;
}

function parseJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function verifyJwt(token: string, options: VerifyOptions): JwtResult {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

  const header = parseJson(headerSegment);
  if (header === null || header.alg !== "HS256" || header.typ !== "JWT") return { ok: false, reason: "malformed" };

  const expected = createHmac("sha256", options.key).update(`${headerSegment}.${payloadSegment}`).digest();
  const actual = Buffer.from(signatureSegment, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { ok: false, reason: "bad_signature" };
  // Signed by our key family but for a rotated secret: the password was changed.
  if (header.kid !== options.kid) return { ok: false, reason: "wrong_key" };

  const claims = parseJson(payloadSegment);
  if (claims === null) return { ok: false, reason: "malformed" };
  const { iss, aud, sub, use, iat, exp, jti, sid } = claims;
  if (
    iss !== JWT_ISSUER ||
    aud !== JWT_AUDIENCE ||
    use !== options.use ||
    typeof sub !== "string" ||
    typeof jti !== "string" ||
    typeof sid !== "string" ||
    typeof iat !== "number" ||
    typeof exp !== "number"
  ) {
    return { ok: false, reason: "wrong_claims" };
  }

  const nowSeconds = Math.floor(options.now / 1000);
  if (exp + options.leewaySeconds <= nowSeconds) return { ok: false, reason: "expired" };
  if (iat - options.leewaySeconds > nowSeconds) return { ok: false, reason: "not_yet_valid" };
  return { ok: true, claims: { iss, aud, sub, use: options.use, iat, exp, jti, sid } };
}
