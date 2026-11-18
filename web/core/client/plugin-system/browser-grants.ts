/**
 * Persistence for browser-half operator grants. The decision to grant lives
 * in the protocol; this module only stores the result and a bounded audit
 * tail so a reload cannot silently resurrect a revoked hash.
 */
import {
  browserGrantUpdate,
  type BrowserGrant,
  type BrowserGrantAuditEntry,
} from "../../protocol/browser-runtime.ts";

export const BROWSER_GRANTS_KEY = "pi-web.browser-grants.v1";
export const BROWSER_AUDIT_KEY = "pi-web.browser-audit.v1";
const AUDIT_LIMIT = 100;

export interface BrowserGrantStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type GrantOutcome = Parameters<typeof browserGrantUpdate>[1];

export interface BrowserGrantStore {
  grants(): Readonly<Record<string, BrowserGrant>>;
  audit(): readonly BrowserGrantAuditEntry[];
  commit(outcome: GrantOutcome, now: number): BrowserGrantAuditEntry | undefined;
}

function readJson<T>(storage: BrowserGrantStorage, key: string, fallback: T): T {
  const text = storage.getItem(key);
  if (text === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed === null || typeof parsed !== "object" ? fallback : parsed as T;
  } catch {
    return fallback;
  }
}

export function createBrowserGrantStore(storage: BrowserGrantStorage): BrowserGrantStore {
  const grants = (): Readonly<Record<string, BrowserGrant>> =>
    readJson(storage, BROWSER_GRANTS_KEY, {} as Record<string, BrowserGrant>);
  const audit = (): readonly BrowserGrantAuditEntry[] =>
    readJson(storage, BROWSER_AUDIT_KEY, [] as BrowserGrantAuditEntry[]);

  return {
    grants,
    audit,
    commit(outcome, now) {
      const updated = browserGrantUpdate(grants(), outcome, now);
      storage.setItem(BROWSER_GRANTS_KEY, JSON.stringify(updated.grants));
      if (updated.audit === undefined) return undefined;
      const tail = [...audit(), updated.audit].slice(-AUDIT_LIMIT);
      storage.setItem(BROWSER_AUDIT_KEY, JSON.stringify(tail));
      return updated.audit;
    },
  };
}
