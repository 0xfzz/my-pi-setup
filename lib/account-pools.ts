// Account pools: route requests for one provider across several accounts
// (API keys or OAuth logins) instead of a single stored credential.
//
// Pure logic only: no Pi imports, no network, no filesystem side effects
// beyond the documented read/write helpers. The extension wires this to Pi.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Strategy = "round-robin" | "least-recently-used" | "priority" | "sticky";

export type AccountConfig = {
  id: string;
  label?: string;
  /** Static credential: literal, `$ENV`, `${ENV}`, or `!command` (resolved by Pi). */
  apiKey?: string;
  /** Source-specific data; never interpreted generically. */
  data?: Record<string, unknown>;
};

export type PoolConfig = {
  /** Provider id this pool applies to, e.g. "antigravity", "openrouter". */
  provider: string;
  strategy: Strategy;
  accounts: AccountConfig[];
  /**
   * Adapter that materializes credentials. `"antigravity-accounts"` reads the
   * login store written by pi-antigravity. Default: static `apiKey` entries.
   */
  source?: string;
  /** Mark an account unusable for this many ms after a rate-limit response. */
  cooldownMs?: number;
  /** Stop routing to an account after this many consecutive failures (0 = never). */
  maxConsecutiveFailures?: number;
};

export type RouterConfig = {
  pools: Record<string, PoolConfig>;
};

export type AccountHealth = {
  /** Consecutive failures since the last success. */
  failures: number;
  /** Epoch ms before which the account must not be used. */
  cooldownUntil?: number;
  /** Quota recovery must pass a small request before normal traffic resumes. */
  needsProbe?: boolean;
  /** Auth failure (e.g. 401 invalid token); skipped until reset or updated. */
  authFailed?: boolean;
  lastUsedAt?: number;
  lastError?: string;
  /** Epoch ms of the last successful request. */
  lastOkAt?: number;
};

export type RouterState = {
  version: 1;
  /** Per-pool, per-account health. */
  health: Record<string, Record<string, AccountHealth>>;
  /** Sticky/round-robin cursor per pool. */
  cursor: Record<string, string | undefined>;
};

export const DEFAULT_COOLDOWN_MS = 60_000;
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const STRATEGIES: Strategy[] = ["round-robin", "least-recently-used", "priority", "sticky"];

export function emptyState(): RouterState {
  return { version: 1, health: {}, cursor: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate one pool, returning either a normalized pool or a reason string. */
export function normalizePool(name: string, raw: unknown): PoolConfig | string {
  if (!isRecord(raw)) return `pool "${name}": expected an object`;
  const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
  if (!provider) return `pool "${name}": "provider" is required`;
  const strategy = (typeof raw.strategy === "string" ? raw.strategy : "round-robin") as Strategy;
  if (!STRATEGIES.includes(strategy)) {
    return `pool "${name}": unknown strategy "${String(raw.strategy)}" (use ${STRATEGIES.join(", ")})`;
  }
  const accountsRaw = raw.accounts;
  if (accountsRaw !== undefined && !Array.isArray(accountsRaw)) return `pool "${name}": "accounts" must be an array`;
  const accounts: AccountConfig[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of (accountsRaw ?? []).entries()) {
    if (!isRecord(entry)) return `pool "${name}": account ${index} must be an object`;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) return `pool "${name}": account ${index} requires a non-empty "id"`;
    if (seen.has(id)) return `pool "${name}": duplicate account id "${id}"`;
    seen.add(id);
    if (entry.apiKey !== undefined && typeof entry.apiKey !== "string") {
      return `pool "${name}" account "${id}": "apiKey" must be a string`;
    }
    accounts.push({
      id,
      ...(typeof entry.label === "string" && entry.label.trim() ? { label: entry.label.trim() } : {}),
      ...(typeof entry.apiKey === "string" ? { apiKey: entry.apiKey } : {}),
      ...(isRecord(entry.data) ? { data: entry.data } : {}),
    });
  }
  const cooldownMs = raw.cooldownMs;
  if (cooldownMs !== undefined && (typeof cooldownMs !== "number" || !Number.isFinite(cooldownMs) || cooldownMs < 0)) {
    return `pool "${name}": "cooldownMs" must be a non-negative number`;
  }
  const maxFailures = raw.maxConsecutiveFailures;
  if (maxFailures !== undefined && (typeof maxFailures !== "number" || !Number.isInteger(maxFailures) || maxFailures < 0)) {
    return `pool "${name}": "maxConsecutiveFailures" must be a non-negative integer`;
  }
  return {
    provider,
    strategy,
    accounts,
    ...(typeof raw.source === "string" && raw.source.trim() ? { source: raw.source.trim() } : {}),
    ...(cooldownMs !== undefined ? { cooldownMs: cooldownMs as number } : {}),
    ...(maxFailures !== undefined ? { maxConsecutiveFailures: maxFailures as number } : {}),
  };
}

/** Parse and validate a router config document. */
export function parseRouterConfig(raw: unknown): { config: RouterConfig; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw) || !isRecord(raw.pools)) {
    return { config: { pools: {} }, errors: ['expected a JSON object with a "pools" object'] };
  }
  const pools: Record<string, PoolConfig> = {};
  for (const [name, value] of Object.entries(raw.pools)) {
    const pool = normalizePool(name, value);
    if (typeof pool === "string") errors.push(pool);
    else pools[name] = pool;
  }
  return { config: { pools }, errors };
}

export function readRouterConfig(path: string): { config: RouterConfig; errors: string[] } {
  if (!existsSync(path)) return { config: { pools: {} }, errors: [] };
  try {
    return parseRouterConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    return { config: { pools: {} }, errors: [`${path}: ${(error as Error).message}`] };
  }
}

/** Merge global then project config; project pools win per pool name. */
export function mergeConfigs(...configs: RouterConfig[]): RouterConfig {
  const pools: Record<string, PoolConfig> = {};
  for (const config of configs) for (const [name, pool] of Object.entries(config.pools)) pools[name] = pool;
  return { pools };
}

export function normalizeState(raw: unknown): RouterState {
  const state = emptyState();
  if (!isRecord(raw) || raw.version !== 1) return state;
  if (isRecord(raw.health)) {
    for (const [pool, entries] of Object.entries(raw.health)) {
      if (!isRecord(entries)) continue;
      const accounts: Record<string, AccountHealth> = {};
      for (const [account, health] of Object.entries(entries)) {
        if (!isRecord(health)) continue;
        const failures = typeof health.failures === "number" && Number.isFinite(health.failures) ? health.failures : 0;
        // Upgrade old state that used a 60s cooldown despite a longer reset hint.
        const resetDelay = health.needsProbe !== true && typeof health.lastError === "string"
          ? quotaRetryMs(health.lastError) : undefined;
        const storedCooldown = typeof health.cooldownUntil === "number" ? health.cooldownUntil : undefined;
        const cooldownUntil = resetDelay && typeof health.lastUsedAt === "number"
          ? Math.max(storedCooldown ?? 0, health.lastUsedAt + resetDelay) : storedCooldown;
        accounts[account] = {
          failures,
          ...((health.needsProbe === true || isQuotaError(typeof health.lastError === "string" ? health.lastError : undefined))
            ? { needsProbe: true } : {}),
          ...(cooldownUntil !== undefined ? { cooldownUntil } : {}),
          ...(typeof health.lastUsedAt === "number" ? { lastUsedAt: health.lastUsedAt } : {}),
          ...(typeof health.lastOkAt === "number" ? { lastOkAt: health.lastOkAt } : {}),
          ...(typeof health.lastError === "string" ? { lastError: health.lastError } : {}),
        };
      }
      state.health[pool] = accounts;
    }
  }
  if (isRecord(raw.cursor)) {
    for (const [pool, account] of Object.entries(raw.cursor)) {
      if (typeof account === "string") state.cursor[pool] = account;
    }
  }
  return state;
}

export function readRouterState(path: string): RouterState {
  if (!existsSync(path)) return emptyState();
  try {
    return normalizeState(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return emptyState();
  }
}

/** Write state atomically with owner-only permissions. Never throws. */
export function writeRouterState(path: string, state: RouterState): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    chmodSync(path, 0o600);
    return true;
  } catch {
    return false;
  }
}

export function agentStatePath(agentDir: string): string {
  return join(agentDir, "account-router-state.json");
}

export function healthFor(state: RouterState, pool: string, account: string): AccountHealth {
  state.health[pool] ??= {};
  const health = state.health[pool];
  health[account] ??= { failures: 0 };
  return health[account];
}

function usable(pool: PoolConfig, health: AccountHealth, now: number): boolean {
  if (health.cooldownUntil !== undefined && health.cooldownUntil > now) return false;
  if (health.authFailed) return false;
  // A quota wall is recoverable even if repeated probes used up the failure budget.
  if (health.needsProbe) return true;
  const maxFailures = pool.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  if (maxFailures > 0 && health.failures >= maxFailures) return false;
  return true;
}

/**
 * Choose an account for the next request.
 *
 * Order is decided by the pool strategy; accounts that are cooling down or
 * have exhausted their failure budget are skipped. Never fall back to a
 * cooling account when the pool is exhausted. Quota-recovery candidates are
 * returned only after cooldown, and must be probed by the caller.
 *
 * Returns `undefined` when there is nothing to pick: no candidates at all
 * (empty pool, or everything excluded), or candidates exist but none are
 * usable right now (all cooling down / over their failure budget).
 *
 * `exhausted` is true when the picked account is the ONLY usable candidate,
 * i.e. after this request there is no fallback left in the pool. Callers can
 * use it to warn before the pool runs dry; it never changes the selection.
 */
export function selectAccount(
  pool: PoolConfig,
  state: RouterState,
  options: { now?: number; poolName?: string; exclude?: readonly string[] } = {},
): { account: AccountConfig; exhausted: boolean } | undefined {
  const now = options.now ?? Date.now();
  const name = options.poolName ?? pool.provider;
  const excluded = new Set(options.exclude ?? []);
  const candidates = pool.accounts.filter((account) => !excluded.has(account.id));
  if (!candidates.length) return undefined;

  const withHealth = candidates.map((account) => ({ account, health: healthFor(state, name, account.id) }));
  const available = withHealth.filter(({ health }) => usable(pool, health, now));
  if (!available.length) return undefined;
  const exhausted = available.length === 1;
  const usableSet = available;

  const byCursor = (list: typeof withHealth): typeof withHealth => {
    const cursor = state.cursor[name];
    if (!cursor) return list;
    const index = list.findIndex(({ account }) => account.id === cursor);
    if (index < 0) return list;
    return [...list.slice(index + 1), ...list.slice(0, index + 1)];
  };

  let ordered = usableSet;
  switch (pool.strategy) {
    case "priority":
      // Declaration order is priority; keep it.
      break;
    case "least-recently-used":
      ordered = [...usableSet].sort((a, b) =>
        (a.health.lastUsedAt ?? 0) - (b.health.lastUsedAt ?? 0) || a.account.id.localeCompare(b.account.id));
      break;
    case "sticky": {
      const cursor = state.cursor[name];
      const current = usableSet.find(({ account }) => account.id === cursor);
      if (current) ordered = [current, ...usableSet.filter((entry) => entry !== current)];
      else ordered = byCursor(usableSet);
      break;
    }
    case "round-robin":
    default:
      ordered = byCursor(usableSet);
      break;
  }
  return { account: ordered[0].account, exhausted };
}

/** Record a successful request for an account. */
export function recordSuccess(state: RouterState, poolName: string, accountId: string, now = Date.now()): void {
  const health = healthFor(state, poolName, accountId);
  health.failures = 0;
  delete health.needsProbe;
  delete health.authFailed;
  delete health.cooldownUntil;
  delete health.lastError;
  health.lastUsedAt = now;
  health.lastOkAt = now;
  state.cursor[poolName] = accountId;
}

/** Record a failed request; cool the account down when it looks like a quota wall. */
export function recordFailure(
  state: RouterState,
  poolName: string,
  accountId: string,
  error: string | undefined,
  options: { now?: number; cooldownMs?: number } = {},
): void {
  const now = options.now ?? Date.now();
  const health = healthFor(state, poolName, accountId);
  if (isModelConcurrencyError(error)) {
    // A cluster-wide concurrency limit is not this account's fault and affects
    // every account equally, so it must not spend the failure budget or cool
    // the account down. Keep the error visible for /router status only.
    health.lastUsedAt = now;
    if (error) health.lastError = error.slice(0, 300);
    return;
  }
  health.failures += 1;
  health.lastUsedAt = now;
  if (error) health.lastError = error.slice(0, 300);
  if (isAuthError(error)) health.authFailed = true;
  if (isQuotaError(error)) health.needsProbe = true;
  if (health.needsProbe) {
    // Honor a provider's long reset window, not just the pool's short default.
    // Keep failed recovery probes throttled even for non-quota failures. The
    // 1s floor absorbs sub-second hints so a cooldown is never effectively zero.
    const delay = Math.max(1000, options.cooldownMs ?? DEFAULT_COOLDOWN_MS, quotaRetryMs(error) ?? 0);
    health.cooldownUntil = Math.max(health.cooldownUntil ?? 0, now + delay);
  }
}

/** Parse provider reset delays such as "Please wait 54h10m43s" or "resets in 22h 21m". */
export function quotaRetryMs(error: string | undefined): number | undefined {
  if (!error || !isQuotaError(error)) return undefined;
  const duration = error.match(/(?:please\s+wait|retry\s+(?:in|after)|try\s+again\s+(?:in|after)|resets?\s+(?:in|after))\s+((?:\d+(?:\.\d+)?\s*(?:milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\s*)+)/i)?.[1];
  if (!duration) return undefined;
  let total = 0;
  // Unit table is a closed whitelist: ms < s < m(=minutes) < h < d. Anchored
  // here longest-first so a future unit (e.g. "months") cannot silently parse
  // as minutes via the `m` prefix.
  for (const part of duration.matchAll(/(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)/gi)) {
    const unit = part[2].toLowerCase();
    const factor = unit === "ms" || unit.startsWith("millisecond") ? 1
      : unit.startsWith("d") ? 86_400_000 : unit.startsWith("h") ? 3_600_000
      : unit.startsWith("m") ? 60_000 : 1000;
    total += Number(part[1]) * factor;
  }
  return Number.isFinite(total) && total > 0 ? Math.ceil(total) : undefined;
}

/** Detect rate-limit / quota-wall failures that should move to another account. */
export function isQuotaError(error: string | undefined): boolean {
  if (!error) return false;
  if (/model_concurrency|model is at concurrency capacity|not (?:necessarily )?an? account quota wall/i.test(error)) return false;
  return /\b429\b|rate.?limit|quota|resource.?exhausted|too many requests|\b402\b|budget_exceeded|free usage|out of credits|insufficient.?quota|exceeded your current quota|credit balance|billing/i.test(error);
}

/** Detect model-level concurrency capacity limits (cluster-wide, not per-account). */
export function isModelConcurrencyError(error: string | undefined): boolean {
  if (!error) return false;
  return /model_concurrency|model is at concurrency capacity/i.test(error);
}

/** Detect auth failures that mean this account needs a new login, not a retry. */
export function isAuthError(error: string | undefined): boolean {
  if (!error) return false;
  return /\b401\b|invalid_grant|invalid.?token|unauthorized|re-?authenticate|token (?:has )?expired|auth_error/i.test(error);
}

/** Human-readable account label: `label (id)` when both exist. */
export function accountLabel(account: AccountConfig): string {
  return account.label && account.label !== account.id ? `${account.label} (${account.id})` : account.id;
}

/** Short status line for one account. */
export function describeHealth(health: AccountHealth, now = Date.now()): string {
  if (health.cooldownUntil !== undefined && health.cooldownUntil > now) {
    const remSec = Math.ceil((health.cooldownUntil - now) / 1000);
    if (remSec >= 3600) return `cooling down ${Math.round(remSec / 3600)}h`;
    return `cooling down ${remSec}s`;
  }
  if (health.authFailed) return "auth failed";
  if (health.needsProbe) return "awaiting recovery probe";
  if (health.failures > 0) return `${health.failures} consecutive failure(s)`;
  if (health.lastOkAt) return "ok";
  return "unused";
}
