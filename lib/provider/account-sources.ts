// Credential sources for account pools.
//
// A source turns pool account entries into request credentials. Two are
// built in:
//   - static: each account carries its own `apiKey` string (literal, `$ENV`,
//     `${ENV}`, or leading `!command`), resolved here without leaking values.
//   - antigravity-accounts: reads the multi-login store written by
//     pi-antigravity so several Google accounts can share one provider.
//
// Sources never log secret values. Tokens stay inside the returned credential.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountConfig, PoolConfig } from "./account-pools.ts";

export type ResolvedCredential = {
  /** Value handed to the provider as its API key. */
  apiKey?: string;
  /** Extra headers for this request. */
  headers?: Record<string, string | null>;
  /** Provider-scoped environment. */
  env?: Record<string, string>;
};

export type SourceContext = {
  /** Pi agent directory; defaults to PI_CODING_AGENT_DIR or ~/.pi/agent. */
  agentDir: string;
  /** Injectable for tests. */
  now?: number;
  /** Injectable for tests. */
  readFile?: (path: string) => string | undefined;
  /** Injectable for tests: refresh an expired OAuth account. */
  refresh?: (account: StoredAntigravityAccount) => Promise<StoredAntigravityAccount>;
  /** Environment for `$VAR` key references; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
};

export type StoredAntigravityAccount = {
  accountId: string;
  access?: string;
  refresh?: string;
  expires?: number;
  email?: string;
  projectId?: string;
  [key: string]: unknown;
};

const REFRESH_SKEW_MS = 5 * 60 * 1000;

export const ANTIGRAVITY_SOURCE = "antigravity-accounts";
export const STATIC_SOURCE = "static";

function defaultAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || "", ".pi", "agent");
}

/** Path of the pi-antigravity multi-account store. */
export function antigravityAccountsPath(agentDir: string): string {
  return join(agentDir, "antigravity-accounts.json");
}

/** Path of models.json in agentDir. */
export function modelsJsonPath(agentDir: string): string {
  return join(agentDir, "models.json");
}

function readText(path: string, ctx: SourceContext): string | undefined {
  if (ctx.readFile) return ctx.readFile(path);
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/** Read linked Antigravity accounts without exposing tokens to callers that only list. */
export function readAntigravityAccounts(ctx: SourceContext): StoredAntigravityAccount[] {
  const text = readText(antigravityAccountsPath(ctx.agentDir), ctx);
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const accounts = (parsed as { accounts?: unknown }).accounts;
  if (!accounts || typeof accounts !== "object") return [];
  const entries: StoredAntigravityAccount[] = [];
  for (const [key, value] of Object.entries(accounts as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const account = value as Partial<StoredAntigravityAccount>;
    if (typeof account.refresh !== "string" || !account.refresh) continue;
    entries.push({ ...account, accountId: typeof account.accountId === "string" ? account.accountId : key });
  }
  return entries;
}

/** Mask an email for display: first two characters plus a stable suffix. */
export function maskAccountLabel(value: string): string {
  const at = value.indexOf("@");
  if (at <= 0) return value.length <= 3 ? "***" : `${value.slice(0, 2)}***`;
  return `${value.slice(0, 2)}***${value.slice(at)}`;
}

/**
 * Resolve a single-quoted static key expression without executing anything
 * beyond an explicit `!command`. Mirrors Pi's models.json syntax.
 */
export function resolveStaticKey(raw: string, env: Record<string, string | undefined> = process.env):
  { value: string } | { error: string } {
  if (raw.startsWith("$$")) return { value: raw.slice(1) };
  if (raw.startsWith("$!")) return { value: raw.slice(1) };
  if (raw.startsWith("!")) {
    const command = raw.slice(1).trim();
    if (!command) return { error: "empty command" };
    try {
      // execSync always runs the command through a shell.
      const output = execSync(command, { stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
      const value = String(output).trim();
      return value ? { value } : { error: "command produced no output" };
    } catch {
      return { error: `command failed: ${command}` };
    }
  }
  const match = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(raw);
  if (!match) return { value: raw };
  const name = match[1] ?? match[2];
  const value = env[name];
  return value === undefined || value === "" ? { error: `environment variable ${name} is not set` } : { value };
}

function antigravityKey(account: StoredAntigravityAccount): string {
  return JSON.stringify({
    token: account.access,
    ...(account.projectId ? { projectId: account.projectId } : {}),
  });
}

/** True when the stored access token is still valid for a request. */
export function accountIsFresh(account: StoredAntigravityAccount, now: number, skewMs = REFRESH_SKEW_MS): boolean {
  return typeof account.access === "string" && account.access.length > 0 &&
    typeof account.expires === "number" && account.expires > now + skewMs;
}

/**
 * Resolve request credentials for a pool account.
 * Returns an error string (safe to display) instead of throwing.
 */
export async function resolveAccountCredential(
  pool: PoolConfig,
  account: AccountConfig,
  ctx: SourceContext,
): Promise<ResolvedCredential | { error: string }> {
  const source = pool.source ?? STATIC_SOURCE;
  if (source === STATIC_SOURCE) {
    let key = account.apiKey;
    if (!key) {
      const fromModels = readModelsJsonAccounts(pool.provider, ctx);
      key = fromModels.find((a) => a.id === account.id)?.apiKey;
    }
    if (!key) return { error: `account "${account.id}" has no apiKey` };
    const resolved = resolveStaticKey(key, ctx.env);
    return "error" in resolved ? { error: `account "${account.id}": ${resolved.error}` } : { apiKey: resolved.value };
  }
  if (source !== ANTIGRAVITY_SOURCE) return { error: `pool "${pool.provider}": unknown source "${source}"` };

  const now = ctx.now ?? Date.now();
  const stored = readAntigravityAccounts(ctx).find((entry) => entry.accountId === account.id);
  if (!stored) return { error: `Antigravity account "${account.id}" is not linked` };
  let usable = stored;
  if (!accountIsFresh(usable, now)) {
    if (!ctx.refresh) return { error: `Antigravity account "${account.id}" needs re-login (token expired)` };
    try {
      usable = await ctx.refresh(stored);
    } catch (error) {
      return { error: `Antigravity account "${account.id}" refresh failed: ${(error as Error).message}` };
    }
    if (!accountIsFresh(usable, now, 0)) return { error: `Antigravity account "${account.id}" refresh returned no usable token` };
  }
  return { apiKey: antigravityKey(usable) };
}

/** Accounts to consider for a pool, honoring the configured source. */
export function poolAccounts(pool: PoolConfig, ctx: SourceContext): AccountConfig[] {
  if (pool.accounts?.length) return pool.accounts;
  if ((pool.source ?? STATIC_SOURCE) === ANTIGRAVITY_SOURCE) {
    // No explicit list: use every linked login, in store order.
    return readAntigravityAccounts(ctx).map((account) => ({
      id: account.accountId,
      ...(account.email ? { label: account.email } : {}),
    }));
  }
  return readModelsJsonAccounts(pool.provider, ctx);
}

/** Read accounts for a provider from models.json when no explicit list is configured. */
export function readModelsJsonAccounts(providerId: string, ctx: SourceContext): AccountConfig[] {
  const accounts: AccountConfig[] = [];
  const candidatePaths = [
    modelsJsonPath(ctx.agentDir),
    join(process.cwd(), ".pi", "models.json"),
    join(process.cwd(), "models.json"),
  ];
  for (const path of candidatePaths) {
    const text = readText(path, ctx);
    if (!text) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || !("providers" in parsed)) continue;
    const providers = (parsed as { providers?: Record<string, unknown> }).providers;
    if (!providers || typeof providers !== "object") continue;

    const members: Array<{ id: string; index: number; label?: string; apiKey?: string }> = [];
    for (const [id, raw] of Object.entries(providers)) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      const apiKey = typeof entry.apiKey === "string" ? entry.apiKey : undefined;
      const label = typeof entry.name === "string" ? entry.name : undefined;

      if (id === providerId) {
        members.push({ id, index: 1, ...(label ? { label } : {}), ...(apiKey ? { apiKey } : {}) });
      } else if (id.startsWith(`${providerId}-`)) {
        const suffix = id.slice(providerId.length + 1);
        const index = /^[1-9][0-9]*$/.test(suffix) ? Number(suffix) : 999;
        members.push({ id, index, ...(label ? { label } : {}), ...(apiKey ? { apiKey } : {}) });
      }
    }
    if (members.length) {
      members.sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
      for (const m of members) {
        if (!accounts.some((a) => a.id === m.id)) {
          accounts.push({
            id: m.id,
            ...(m.label ? { label: m.label } : {}),
            ...(m.apiKey ? { apiKey: m.apiKey } : {}),
          });
        }
      }
      break;
    }
  }
  return accounts;
}

export function sourceDefaultAgentDir(): string {
  return defaultAgentDir();
}
