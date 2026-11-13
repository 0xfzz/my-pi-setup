/**
 * Login throttling. A password is the only thing standing between the internet and
 * a shell-capable agent, so guessing must be slow:
 *   - per client: `maxFailures` wrong passwords inside `windowMs` lock that client out
 *     for `lockMs`; a correct password clears its record;
 *   - overall: a backstop across all clients (a botnet rotating addresses), at a
 *     higher threshold so one attacker cannot trivially lock the owner out.
 */
export interface ThrottleOptions {
  maxFailures: number;
  windowMs: number;
  lockMs: number;
  /** Failures across every client inside `windowMs` that pause all logins. */
  globalMaxFailures: number;
}

export const DEFAULT_THROTTLE: ThrottleOptions = {
  maxFailures: 5,
  windowMs: 15 * 60_000,
  lockMs: 15 * 60_000,
  globalMaxFailures: 100,
};

export type ThrottleDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

interface ClientRecord {
  failures: number[];
  lockedUntil: number;
}

const MAX_TRACKED_CLIENTS = 10_000;

export class LoginThrottle {
  readonly #options: ThrottleOptions;
  readonly #now: () => number;
  readonly #clients = new Map<string, ClientRecord>();
  #global: number[] = [];

  constructor(options: ThrottleOptions, now: () => number) {
    this.#options = options;
    this.#now = now;
  }

  check(client: string): ThrottleDecision {
    const now = this.#now();
    this.#global = this.#global.filter((at) => at > now - this.#options.windowMs);
    if (this.#global.length >= this.#options.globalMaxFailures) {
      const oldest = this.#global[0] ?? now;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.#options.windowMs - now) / 1000)) };
    }
    const record = this.#clients.get(client);
    if (record !== undefined && record.lockedUntil > now) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((record.lockedUntil - now) / 1000)) };
    }
    return { allowed: true };
  }

  /**
   * Charge an attempt. Callers charge *before* checking the password and `success`
   * refunds it, so a burst of parallel guesses is counted even though none has finished.
   */
  failure(client: string): void {
    const now = this.#now();
    this.#global.push(now);
    let record = this.#clients.get(client);
    if (record === undefined) {
      this.#evictIfFull(now);
      record = { failures: [], lockedUntil: 0 };
      this.#clients.set(client, record);
    }
    record.failures = record.failures.filter((at) => at > now - this.#options.windowMs);
    record.failures.push(now);
    if (record.failures.length >= this.#options.maxFailures) {
      record.lockedUntil = now + this.#options.lockMs;
      record.failures = [];
    }
  }

  /** A correct password: clear the client and refund the attempt that was charged up front. */
  success(client: string): void {
    this.#clients.delete(client);
    this.#global.pop();
  }

  #evictIfFull(now: number): void {
    if (this.#clients.size < MAX_TRACKED_CLIENTS) return;
    for (const [client, record] of this.#clients) {
      const stale = record.lockedUntil <= now && record.failures.every((at) => at <= now - this.#options.windowMs);
      if (stale) this.#clients.delete(client);
    }
    // Still full of live records: drop the oldest so a flood of addresses cannot grow memory.
    if (this.#clients.size >= MAX_TRACKED_CLIENTS) {
      const first = this.#clients.keys().next();
      if (!first.done) this.#clients.delete(first.value);
    }
  }
}
