/**
 * HS256 JWT through the maintained `fast-jwt` codec.
 *
 * The codec owns the format work (compact-JWT parsing, the constant-time
 * signature check, the algorithm allow-list) and this module owns the policy.
 * The accepted set stays deliberately narrow, because every flexible JWT
 * library has shipped the same bugs (alg=none, RS/HS confusion, unchecked
 * claims):
 *   - only HS256 is signed or accepted, and the header must say exactly that;
 *   - the signature is verified before any claim is read;
 *   - issuer, audience, token use (`use`), key id (`kid`) and `exp` are all
 *     required and checked;
 *   - access and refresh tokens use *different* keys (HKDF-derived from the one
 *     stored secret), so one can never be replayed as the other.
 *
 * The clock and the skew leeway are validated here from the injected options
 * rather than by the library, so the service's injectable clock keeps working
 * and the expiry boundary stays exactly what it was.
 */
import { hkdfSync } from "node:crypto";
import { createSigner, createVerifier } from "fast-jwt";

export const JWT_ISSUER = "pi-web";
export const JWT_AUDIENCE = "pi-web";
const TOKEN_ALGORITHM = "HS256";
const TOKEN_TYPE = "JWT";
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

/** A purpose-bound key: access and refresh tokens never share key material. */
export function deriveKey(secret: Buffer, purpose: TokenUse): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), `pi-web ${purpose} token v1`, 32));
}

export function signJwt(claims: JwtClaims, key: Buffer, kid: string): string {
  const signer = createSigner({
    key,
    algorithm: TOKEN_ALGORITHM,
    // `iat` is taken from the claims (fast-jwt prefers an existing `payload.iat`),
    // so the injected clock, not the wall clock, decides the timestamp.
    header: { alg: TOKEN_ALGORITHM, typ: TOKEN_TYPE, kid },
  });
  return signer(claims);
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

/** Translate a fast-jwt failure into this module's reason vocabulary. */
function jwtFailureOf(error: unknown): JwtFailure {
  switch ((error as { code?: string } | null | undefined)?.code) {
    case "FAST_JWT_EXPIRED":
      return "expired";
    case "FAST_JWT_INACTIVE":
      return "not_yet_valid";
    case "FAST_JWT_INVALID_SIGNATURE":
    case "FAST_JWT_MISSING_SIGNATURE":
      return "bad_signature";
    case "FAST_JWT_MISSING_REQUIRED_CLAIM":
    case "FAST_JWT_INVALID_CLAIM_TYPE":
    case "FAST_JWT_INVALID_CLAIM_VALUE":
      return "wrong_claims";
    default:
      // Malformed input, a rejected algorithm or typecode, an unusable key.
      return "malformed";
  }
}

interface DecodedToken {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

export function verifyJwt(token: string, options: VerifyOptions): JwtResult {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };

  let decoded: DecodedToken;
  try {
    const verifier = createVerifier({
      key: options.key,
      algorithms: [TOKEN_ALGORITHM],
      checkTyp: TOKEN_TYPE,
      complete: true,
      // One verifier per call: the library binds the clock at construction and
      // the injected clock changes per call. The cache would also let a stale
      // clock decision through, so it stays off.
      cache: false,
      // Expiry and not-before are validated below against the injected clock
      // and leeway, so the library must not apply its own time policy.
      ignoreExpiration: true,
      ignoreNotBefore: true,
      clockTimestamp: options.now,
    });
    decoded = verifier(token) as DecodedToken;
  } catch (error) {
    return { ok: false, reason: jwtFailureOf(error) };
  }

  // Signed by our key family but under a rotated secret: the password changed.
  if (decoded.header.kid !== options.kid) return { ok: false, reason: "wrong_key" };

  const { iss, aud, sub, use, iat, exp, jti, sid } = decoded.payload;
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
