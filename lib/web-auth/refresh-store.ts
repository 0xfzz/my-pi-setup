/**
 * Server-side state for refresh tokens: one *family* per login.
 *
 * A refresh token is a signed JWT, but signing alone cannot make it single-use
 * or revocable, so each family records which token id (`jti`) is current. That
 * is what gives:
 *   - rotation: every refresh replaces the current token;
 *   - reuse detection: a token that is neither current nor the one just replaced
 *     means a copy leaked, so the whole family is revoked;
 *   - logout and "sign out everywhere";
 *   - an absolute lifetime cap on top of the sliding one.
 *
 * Persisted (0600, synchronous atomic write) so `/web reload` and server restarts
 * do not sign anyone out. It is written on every change: a refresh whose new token
 * reached the browser but not the disk would look like reuse after a crash.
 */
import { readFileSync } from "node:fs";
import { writePrivateFile } from "./config.ts";

export interface RefreshFamily {
  id: string;
  createdAt: number;
  lastUsedAt: number;
  /** Sliding expiry of the current refresh token (ms). */
  expiresAt: number;
  /** Hard cap on the family's whole life (ms): rotation never extends past it. */
  absoluteExpiresAt: number;
  currentJti: string;
  /** The token the current one replaced, honored briefly for concurrent refreshes. */
  previousJti?: string;
  rotatedAt?: number;
  userAgent?: string;
}

interface SessionsFile {
  version: 1;
  kid: string;
  families: RefreshFamily[];
}

/** More than this many live logins is not one person; the least recently used goes. */
const MAX_FAMILIES = 50;

function isFamily(value: unknown): value is RefreshFamily {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.id === "string" &&
    typeof f.createdAt === "number" &&
    typeof f.lastUsedAt === "number" &&
    typeof f.expiresAt === "number" &&
    typeof f.absoluteExpiresAt === "number" &&
    typeof f.currentJti === "string"
  );
}

export class RefreshFamilyStore {
  readonly #path: string | null;
  readonly #now: () => number;
  readonly #families = new Map<string, RefreshFamily>();
  #kid: string | null = null;

  /** `path` null keeps the store in memory only. */
  constructor(path: string | null, now: () => number) {
    this.#path = path;
    this.#now = now;
  }

  /**
   * Bind the store to the current signing key. A different key means the password was
   * changed: nothing from the old key can be valid, so the families are dropped.
   * Returns true when that happened.
   */
  bind(kid: string): boolean {
    if (this.#kid === kid) return false;
    const hadFamilies = this.#families.size > 0;
    const firstBind = this.#kid === null;
    this.#kid = kid;
    this.#families.clear();
    if (firstBind) {
      this.#load(kid);
      this.#prune();
      return false;
    }
    this.#save();
    return hadFamilies;
  }

  /** Forget everything (protection turned off). */
  unbind(): void {
    const had = this.#families.size > 0;
    this.#kid = null;
    this.#families.clear();
    if (had) this.#save();
  }

  get(id: string): RefreshFamily | undefined {
    return this.#families.get(id);
  }

  create(family: RefreshFamily): void {
    this.#prune();
    this.#families.set(family.id, family);
    while (this.#families.size > MAX_FAMILIES) {
      let oldest: RefreshFamily | undefined;
      for (const candidate of this.#families.values()) {
        if (oldest === undefined || candidate.lastUsedAt < oldest.lastUsedAt) oldest = candidate;
      }
      if (oldest === undefined) break;
      this.#families.delete(oldest.id);
    }
    this.#save();
  }

  /** Persist a mutation made to a family returned by `get`. */
  update(family: RefreshFamily): void {
    if (!this.#families.has(family.id)) return;
    this.#save();
  }

  revoke(id: string): boolean {
    const removed = this.#families.delete(id);
    if (removed) this.#save();
    return removed;
  }

  revokeAll(): void {
    if (this.#families.size === 0) return;
    this.#families.clear();
    this.#save();
  }

  size(): number {
    return this.#families.size;
  }

  #prune(): void {
    const now = this.#now();
    let changed = false;
    for (const [id, family] of this.#families) {
      if (family.expiresAt <= now || family.absoluteExpiresAt <= now) {
        this.#families.delete(id);
        changed = true;
      }
    }
    if (changed) this.#save();
  }

  #load(kid: string): void {
    if (this.#path === null) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#path, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return;
      const file = parsed as Partial<SessionsFile>;
      if (file.version !== 1 || file.kid !== kid || !Array.isArray(file.families)) return;
      for (const family of file.families) {
        if (isFamily(family)) this.#families.set(family.id, family);
      }
    } catch {
      // Missing or unreadable: start with no sessions. Everyone just logs in again.
    }
  }

  #save(): void {
    if (this.#path === null || this.#kid === null) return;
    const file: SessionsFile = { version: 1, kid: this.#kid, families: [...this.#families.values()] };
    try {
      writePrivateFile(this.#path, JSON.stringify(file));
    } catch {
      // A read-only agent dir must not take login down; sessions then last until restart.
    }
  }
}
