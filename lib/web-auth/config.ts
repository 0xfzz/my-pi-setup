/**
 * The web password's on-disk record (`web-auth.json`, mode 0600).
 *
 * One file holds everything the server needs to check a login and sign tokens:
 *   - `passwordHash`  scrypt record (never the password);
 *   - `secret`        the JWT signing secret. Rotated on every password change,
 *                     which is what signs every existing session out;
 *   - `bridgeToken`   the credential the pi TUI uses for the bridge routes, so
 *                     it needs no browser session.
 *
 * Fail closed: a file that exists but cannot be read or parsed is `invalid`,
 * and the server then refuses everything instead of serving unprotected.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { hashPassword } from "./password.ts";

export interface WebAuthConfig {
  version: 1;
  passwordHash: string;
  /** base64url, 32 random bytes. */
  secret: string;
  /** hex, 32 random bytes. */
  bridgeToken: string;
  updatedAt: string;
}

export type WebAuthLoad =
  | { state: "disabled" }
  | { state: "enabled"; config: WebAuthConfig; kid: string }
  | { state: "invalid"; reason: string };

export const WEB_AUTH_FILE = "web-auth.json";
export const WEB_AUTH_SESSIONS_FILE = "web-auth-sessions.json";

export function webAuthDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** `PI_WEB_AUTH_FILE` overrides the location (and the sessions file beside it). */
export function webAuthConfigPath(): string {
  return process.env.PI_WEB_AUTH_FILE ?? join(webAuthDir(), WEB_AUTH_FILE);
}

export function webAuthSessionsPath(configPath: string): string {
  return join(dirname(configPath), WEB_AUTH_SESSIONS_FILE);
}

/** A short public fingerprint of the secret: lets tokens and stored sessions notice a rotation. */
export function keyId(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

function isConfig(value: unknown): value is WebAuthConfig {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.passwordHash === "string" &&
    record.passwordHash.startsWith("scrypt$") &&
    typeof record.secret === "string" &&
    Buffer.from(record.secret, "base64url").length >= 32 &&
    typeof record.bridgeToken === "string" &&
    record.bridgeToken.length >= 32
  );
}

export function loadWebAuthConfig(path: string): WebAuthLoad {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "disabled" };
    return { state: "invalid", reason: `cannot read ${path}: ${(error as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "invalid", reason: `${path} is not valid JSON` };
  }
  if (!isConfig(parsed)) return { state: "invalid", reason: `${path} is not a valid web auth record` };
  return { state: "enabled", config: parsed, kid: keyId(parsed.secret) };
}

/** Write a file privately and atomically: temp file with 0600, then rename over the target. */
export function writePrivateFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, contents, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Turn password protection on (or change the password). Every earlier session stops working. */
export async function writeWebPassword(password: string, path: string): Promise<WebAuthConfig> {
  const config: WebAuthConfig = {
    version: 1,
    passwordHash: await hashPassword(password),
    secret: randomBytes(32).toString("base64url"),
    bridgeToken: randomBytes(32).toString("hex"),
    updatedAt: new Date().toISOString(),
  };
  writePrivateFile(path, `${JSON.stringify(config, null, 2)}\n`);
  // The sessions file belongs to the old secret; the server also drops it on the key change.
  rmSync(webAuthSessionsPath(path), { force: true });
  return config;
}

/** Turn password protection off. True when there was a password to remove. */
export function removeWebPassword(path: string): boolean {
  const existed = loadWebAuthConfig(path).state !== "disabled";
  rmSync(path, { force: true });
  rmSync(webAuthSessionsPath(path), { force: true });
  return existed;
}

/**
 * A config reader that re-parses only when the file changes (inode, mtime and size
 * together; the atomic rename gives every write a new inode), so the server picks up
 * `/web set-password` without a restart and without reading the file per request.
 */
export class WebAuthConfigCache {
  readonly path: string;
  #key = "";
  #value: WebAuthLoad = { state: "disabled" };

  constructor(path: string) {
    this.path = path;
  }

  get(): WebAuthLoad {
    let key: string;
    try {
      const stat = statSync(this.path);
      key = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    } catch (error) {
      key = (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : `error:${(error as Error).message}`;
    }
    if (key !== this.#key) {
      this.#key = key;
      this.#value = loadWebAuthConfig(this.path);
    }
    return this.#value;
  }
}
