/**
 * Password hashing for the web password: scrypt (memory-hard, in node:crypto),
 * a random per-password salt, and a self-describing record so the cost can be
 * raised later without invalidating stored hashes.
 *
 * Record format: `scrypt$N$r$p$<salt b64url>$<hash b64url>`.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 512;

const COST = { N: 1 << 15, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
/** Parameters read back from a stored record are bounded: the file is not trusted to pick the cost. */
const LIMITS = { N: 1 << 20, r: 16, p: 4 } as const;

function derive(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // NFKC so visually identical passwords typed on different keyboards match.
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { N, r, p, maxmem: 256 * N * r }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** The reason a password is unacceptable, or null when it is fine. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `use at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return `use at most ${MAX_PASSWORD_LENGTH} characters`;
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await derive(password, salt, COST.N, COST.r, COST.p);
  return ["scrypt", COST.N, COST.r, COST.p, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

/** False for a wrong password and for a malformed record alike. */
export async function verifyPassword(password: string, record: string): Promise<boolean> {
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  const parts = record.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const powerOfTwo = Number.isInteger(N) && N >= 2 && (N & (N - 1)) === 0;
  if (!powerOfTwo || N > LIMITS.N || !Number.isInteger(r) || r < 1 || r > LIMITS.r || !Number.isInteger(p) || p < 1 || p > LIMITS.p) {
    return false;
  }
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const expected = Buffer.from(parts[5] ?? "", "base64url");
  if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;
  const actual = await derive(password, salt, N, r, p);
  return timingSafeEqual(actual, expected);
}
