/**
 * Scoped plugin storage (PRD §5.4.2, R13). Key-value data in three scopes (global,
 * project, session), namespaced by plugin id, with a per-plugin byte quota.
 * Values are JSON. Writes are rejected once the quota would be exceeded, so one
 * plugin cannot fill the store. Nothing here touches the disk; the host decides
 * when to persist `snapshot()`.
 */
import { assertGranted, parseCapability, type Capability } from "./capabilities.ts";

export const STORAGE_SCOPES = ["global", "project", "session"] as const;
export type StorageScope = (typeof STORAGE_SCOPES)[number];
export const DEFAULT_QUOTA_BYTES = 256 * 1024;

const KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;

export interface StorageOwner {
  pluginId: string;
  grants: readonly Capability[];
}

export interface StorageSnapshot {
  version: 1;
  entries: Record<string, Record<string, Record<string, string>>>;
}

export interface ScopedStorage {
  get<T = unknown>(scope: StorageScope, key: string): T | undefined;
  set(scope: StorageScope, key: string, value: unknown): void;
  delete(scope: StorageScope, key: string): boolean;
  update<T = unknown>(scope: StorageScope, key: string, fn: (current: T | undefined) => T): T;
  bytesUsed(): number;
}

export class PluginStorage {
  private readonly data = new Map<string, Map<string, string>>();
  private readonly quota: number;

  constructor(options: { quotaBytes?: number } = {}) {
    this.quota = options.quotaBytes ?? DEFAULT_QUOTA_BYTES;
  }

  /** Storage for one plugin. Each scope needs the matching `storage:<scope>` grant. */
  forPlugin(owner: StorageOwner): ScopedStorage {
    const slot = (scope: StorageScope): Map<string, string> => {
      const key = `${owner.pluginId}\u0000${scope}`;
      let map = this.data.get(key);
      if (!map) {
        map = new Map();
        this.data.set(key, map);
      }
      return map;
    };
    const check = (scope: StorageScope) => {
      if (!(STORAGE_SCOPES as readonly string[]).includes(scope)) throw new Error(`unknown storage scope "${scope}"`);
      const requested = parseCapability(`storage:${scope}`);
      if (!requested.ok) throw new Error(requested.error);
      assertGranted(owner.pluginId, owner.grants, requested.value);
    };
    const checkKey = (key: string) => {
      if (!KEY_RE.test(key)) throw new Error(`storage key "${key}" is not a valid key`);
    };
    const bytesFor = (plugin: string): number => {
      let total = 0;
      for (const [k, map] of this.data) {
        if (!k.startsWith(`${plugin}\u0000`)) continue;
        for (const [key, value] of map) total += key.length + value.length;
      }
      return total;
    };
    return {
      get: <T,>(scope: StorageScope, key: string) => {
        check(scope);
        checkKey(key);
        const raw = slot(scope).get(key);
        return raw === undefined ? undefined : (JSON.parse(raw) as T);
      },
      set: (scope, key, value) => {
        check(scope);
        checkKey(key);
        const raw = JSON.stringify(value);
        if (raw === undefined) throw new Error(`storage value for "${key}" is not JSON-serialisable`);
        const map = slot(scope);
        const previous = map.get(key);
        const next = bytesFor(owner.pluginId) - (previous ? key.length + previous.length : 0) + key.length + raw.length;
        if (next > this.quota) {
          throw new Error(`Plugin "${owner.pluginId}" storage quota of ${this.quota} bytes would be exceeded`);
        }
        map.set(key, raw);
      },
      delete: (scope, key) => {
        check(scope);
        checkKey(key);
        return slot(scope).delete(key);
      },
      update: <T,>(scope: StorageScope, key: string, fn: (current: T | undefined) => T) => {
        check(scope);
        checkKey(key);
        const raw = slot(scope).get(key);
        const next = fn(raw === undefined ? undefined : (JSON.parse(raw) as T));
        const serialised = JSON.stringify(next);
        if (serialised === undefined) throw new Error(`storage value for "${key}" is not JSON-serialisable`);
        const previous = raw;
        const delta = key.length + serialised.length - (previous ? key.length + previous.length : 0);
        if (bytesFor(owner.pluginId) + delta > this.quota) {
          throw new Error(`Plugin "${owner.pluginId}" storage quota of ${this.quota} bytes would be exceeded`);
        }
        slot(scope).set(key, serialised);
        return next;
      },
      bytesUsed: () => bytesFor(owner.pluginId),
    };
  }

  /** Drop everything a plugin stored (uninstall, with the operator's confirmation). */
  purge(pluginId: string): void {
    for (const k of this.data.keys()) {
      if (k.startsWith(`${pluginId}\u0000`)) this.data.delete(k);
    }
  }

  snapshot(): StorageSnapshot {
    const entries: StorageSnapshot["entries"] = {};
    for (const [k, map] of this.data) {
      const [plugin, scope] = k.split("\u0000");
      entries[plugin] ??= {};
      entries[plugin][scope] = Object.fromEntries(map);
    }
    return { version: 1, entries };
  }

  restore(snapshot: StorageSnapshot): void {
    this.data.clear();
    for (const [plugin, scopes] of Object.entries(snapshot.entries)) {
      for (const [scope, map] of Object.entries(scopes)) {
        this.data.set(`${plugin}\u0000${scope}`, new Map(Object.entries(map)));
      }
    }
  }
}
