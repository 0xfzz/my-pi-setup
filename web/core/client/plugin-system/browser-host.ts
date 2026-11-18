/**
 * Production browser-half runtime. The composition root declares halves; this
 * host checks lifecycle state, safe mode, operator grants and extension-point
 * rules before delegating the actual mount to loadBrowserHalf/mountBrowserHalf.
 */
import {
  BROWSER_MAX_BREAKER,
  browserGrantDecision,
  type BrowserGrant,
  type BrowserGrantAuditEntry,
} from "../../protocol/browser-runtime.ts";
import { PLUGIN_MANAGER_API, type PluginManagerReport } from "../../shared/plugin-manager.ts";
import { getJson } from "./api-client.ts";
import { confirmBrowserHalf, type BrowserGrantInfo, type ConfirmBrowserHalf } from "./browser-confirmation.ts";
import {
  createBrowserContributionRegistry,
  type BrowserContributionRegistry,
  type RegisteredBrowserContribution,
} from "./browser-contributions.ts";
import { createBrowserGrantStore, type BrowserGrantStorage } from "./browser-grants.ts";
import { mountBrowserHalf, type BrowserModule, type BrowserMountHost, type WebPluginContext } from "./browser-loader.ts";

export interface BrowserHalfDefinition extends Omit<BrowserGrantInfo, "hash"> {
  readonly module: BrowserModule;
  readonly trust?: "declarative" | "trusted";
  readonly corePlugin?: boolean;
  /** Precomputed source hash (used by modules fetched from a URL). */
  readonly hash?: string;
}

export interface BrowserRuntimeStatus {
  readonly safeMode: boolean;
  /** Kernel lifecycle state by plugin id, from the operator's manager report. */
  readonly states: Readonly<Record<string, string>>;
}

export interface BrowserRuntimeState {
  readonly mounted: readonly string[];
  readonly refused: Readonly<Record<string, string>>;
  readonly failures: Readonly<Record<string, number>>;
  readonly quarantined: readonly string[];
  readonly safeMode: boolean;
  readonly audit: readonly BrowserGrantAuditEntry[];
  readonly contributions: readonly RegisteredBrowserContribution[];
}

export interface BrowserRuntime {
  scan(): Promise<void>;
  /** Hot-swap an externally built plugin half without restarting the server. */
  addDefinition(definition: BrowserHalfDefinition): Promise<void>;
  removeDefinition(id: string): void;
  /** Re-run one half's mount in this page; the breaker state persists. */
  remount(id: string): Promise<void>;
  stop(): void;
  state(): BrowserRuntimeState;
  subscribe(listener: () => void): () => void;
}

export type BrowserHasher = (definition: BrowserHalfDefinition) => Promise<string>;
export type BrowserStatusFetcher = () => Promise<BrowserRuntimeStatus>;

export interface BrowserRuntimeOptions {
  readonly definitions: readonly BrowserHalfDefinition[];
  readonly element: HTMLElement;
  readonly context: Omit<WebPluginContext, "register" | "contributions">;
  readonly storage?: BrowserGrantStorage;
  readonly confirm?: ConfirmBrowserHalf;
  readonly hash?: BrowserHasher;
  readonly fetchStatus?: BrowserStatusFetcher;
  readonly registry?: BrowserContributionRegistry;
  readonly now?: () => number;
  /** Manager actions are operator-driven; a bounded poll keeps open tabs in sync. */
  readonly pollMs?: number;
}

async function sha256(material: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error("SHA-256 is unavailable in this browser");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(material));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** SHA-256 over the mounted code and the operator-visible metadata. */
export function hashBrowserHalf(definition: BrowserHalfDefinition): Promise<string> {
  return sha256(JSON.stringify({
    id: definition.id,
    version: definition.version,
    sourcePath: definition.sourcePath,
    capabilities: definition.capabilities,
    source: definition.module.mount.toString(),
  }));
}

/** Hash the exact source bytes fetched for a separately built plugin. */
export function hashBrowserSource(source: string): Promise<string> {
  return sha256(source);
}

/** A published hash is a grant: changed bytes must never be imported. */
export function verifyBrowserSourceHash(id: string, hash: string, expectedHash?: string): void {
  if (expectedHash !== undefined && hash !== expectedHash) {
    throw new Error(`browser half ${id} hash changed since the operator grant`);
  }
}

/** Fetch, hash, import and register one externally built browser half. */
export async function registerBrowserHalfFromUrl(
  runtime: BrowserRuntime,
  info: Omit<BrowserHalfDefinition, "module" | "hash"> & {
    readonly url: string;
    readonly expectedHash?: string;
  },
): Promise<void> {
  const response = await fetch(info.url, { cache: "no-store" });
  if (!response.ok) throw new Error(`browser half ${info.id} returned HTTP ${response.status}`);
  const source = await response.text();
  const hash = await hashBrowserSource(source);
  verifyBrowserSourceHash(info.id, hash, info.expectedHash);
  const { expectedHash: _expectedHash, ...definition } = info;
  const objectUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    const module = await import(/* @vite-ignore */ objectUrl) as BrowserModule;
    await runtime.addDefinition({ ...definition, hash, module });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** The kernel already owns safe mode and lifecycle; the browser reads its report. */
export async function fetchBrowserRuntimeStatus(): Promise<BrowserRuntimeStatus> {
  const result = await getJson<PluginManagerReport>(PLUGIN_MANAGER_API);
  if (!result.ok) return { safeMode: false, states: {} };
  return {
    safeMode: result.data.safeMode === true,
    states: Object.fromEntries(result.data.plugins.map((row) => [row.id, row.state])),
  };
}

function isLiveState(state: string | undefined): boolean {
  return state === undefined || ["active", "loaded", "activating", "enabled"].includes(state);
}

export function createBrowserRuntimeHost(options: BrowserRuntimeOptions): BrowserRuntime {
  const store = createBrowserGrantStore(options.storage ?? globalThis.localStorage);
  const registry = options.registry ?? createBrowserContributionRegistry();
  const hashOf = options.hash ?? hashBrowserHalf;
  const fetchStatus = options.fetchStatus ?? fetchBrowserRuntimeStatus;
  const confirm = options.confirm ?? confirmBrowserHalf;
  const now = options.now ?? Date.now;
  const hashes = new Map<string, string>();
  const mounted = new Map<string, () => void>();
  const mountedHash = new Map<string, string>();
  const failures = new Map<string, number>();
  const quarantined = new Set<string>();
  const refused = new Map<string, string>();
  const listeners = new Set<() => void>();
  const definitions = [...options.definitions];
  let safeMode = false;
  let scanning: Promise<void> | undefined;
  const announce = (): void => { for (const listener of listeners) listener(); };

  function unmount(id: string): void {
    const cleanup = mounted.get(id);
    mounted.delete(id);
    mountedHash.delete(id);
    registry.unregisterPlugin(id);
    cleanup?.();
  }

  function unmountAll(): void {
    for (const id of mounted.keys()) unmount(id);
  }

  function hostFor(id: string): BrowserMountHost {
    return {
      restoreBuiltIn: () => { unmount(id); },
      recordFailure: (failedId) => {
        const count = (failures.get(failedId) ?? 0) + 1;
        failures.set(failedId, count);
        if (count >= BROWSER_MAX_BREAKER) {
          quarantined.add(failedId);
          store.commit({ kind: "revoke", id: failedId, reason: `quarantined after ${count} render failures` }, now());
          unmount(failedId);
        }
      },
    };
  }

  async function prepareGrant(definition: BrowserHalfDefinition, hash: string): Promise<BrowserGrant | undefined> {
    const info: BrowserGrantInfo = {
      id: definition.id,
      version: definition.version,
      sourcePath: definition.sourcePath,
      hash,
      capabilities: definition.capabilities,
    };
    const existing = store.grants()[definition.id];
    if (existing !== undefined) {
      if (existing.hash === hash && existing.version === definition.version) return existing;
      const reason = existing.hash === hash ? "browser module version changed" : "browser module hash changed";
      store.commit({ kind: "revoke", id: definition.id, reason }, now());
      if (await confirm(info)) {
        store.commit({ kind: "confirm", id: definition.id, info }, now());
        return store.grants()[definition.id];
      }
      store.commit({ kind: "refusal", id: definition.id, reason: "operator refused the changed browser module" }, now());
      return undefined;
    }
    if (definition.corePlugin === true) {
      store.commit({ kind: "confirm", id: definition.id, info }, now());
      return store.grants()[definition.id];
    }
    if (await confirm(info)) {
      store.commit({ kind: "confirm", id: definition.id, info }, now());
      return store.grants()[definition.id];
    }
    store.commit({ kind: "refusal", id: definition.id, reason: "operator refused browser code" }, now());
    return undefined;
  }

  async function mountDefinition(definition: BrowserHalfDefinition, status: BrowserRuntimeStatus): Promise<void> {
    const state = status.states[definition.id];
    if (quarantined.has(definition.id) || (status.safeMode && definition.corePlugin !== true) || !isLiveState(state)) {
      unmount(definition.id);
      refused.set(definition.id, status.safeMode && definition.corePlugin !== true
        ? "safe mode loads Pi Web Core only"
        : `plugin ${state ?? "disabled"}`);
      return;
    }
    let hash = definition.hash ?? hashes.get(definition.id);
    if (hash === undefined) {
      hash = await hashOf(definition);
      hashes.set(definition.id, hash);
    }
    const grant = await prepareGrant(definition, hash);
    if (grant === undefined) {
      unmount(definition.id);
      refused.set(definition.id, "operator confirmation required");
      return;
    }
    const decision = browserGrantDecision({
      id: definition.id,
      version: definition.version,
      hash,
      sourcePath: definition.sourcePath,
      trust: "trusted",
      grant,
      now: now(),
    });
    if (mounted.has(definition.id) && mountedHash.get(definition.id) === hash) return;
    if (decision.kind !== "load") {
      unmount(definition.id);
      const reason = decision.kind === "revoke" ? decision.reason : "operator confirmation required";
      store.commit({ kind: "revoke", id: definition.id, reason }, now());
      refused.set(definition.id, reason);
      return;
    }
    const pluginContext: WebPluginContext = {
      ...options.context,
      contributions: registry,
      register: (point, key, value) => registry.register(definition.id, { point, key, value }).ok,
    };
    const result = mountBrowserHalf(
      { ...definition, hash, grant, trust: definition.trust ?? "trusted", safeMode: status.safeMode,
        corePlugin: definition.corePlugin === true, now: now(), quarantined: quarantined.has(definition.id) },
      pluginContext,
      options.element,
      hostFor(definition.id),
      failures.get(definition.id) ?? 0,
    );
    if (result.ok) {
      mounted.set(definition.id, result.unmount);
      mountedHash.set(definition.id, hash);
      refused.delete(definition.id);
    } else {
      unmount(definition.id);
      refused.set(definition.id, result.reason);
    }
  }

  const runtime: BrowserRuntime = {
    async addDefinition(definition) {
      const index = definitions.findIndex((entry) => entry.id === definition.id);
      if (index === -1) definitions.push(definition);
      else definitions[index] = definition;
      hashes.delete(definition.id);
      unmount(definition.id);
      refused.delete(definition.id);
      await runtime.scan();
    },
    removeDefinition(id) {
      const index = definitions.findIndex((entry) => entry.id === id);
      if (index !== -1) definitions.splice(index, 1);
      unmount(id);
      refused.delete(id);
    },
    async remount(id) {
      const definition = definitions.find((entry) => entry.id === id);
      if (definition === undefined) return;
      unmount(id);
      await mountDefinition(definition, await fetchStatus());
    },
    async scan() {
      if (scanning !== undefined) return scanning;
      scanning = (async () => {
        const status = await fetchStatus();
        safeMode = status.safeMode;
        for (const definition of definitions) await mountDefinition(definition, status);
        announce();
      })().finally(() => { scanning = undefined; });
      return scanning;
    },
    stop() {
      unmountAll();
      listeners.clear();
    },
    state() {
      return {
        mounted: [...mounted.keys()],
        refused: Object.fromEntries(refused),
        failures: Object.fromEntries(failures),
        quarantined: [...quarantined],
        safeMode,
        audit: store.audit(),
        contributions: registry.list(),
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };

  const pollMs = options.pollMs ?? 5_000;
  const timer = setInterval(() => { void runtime.scan(); }, pollMs);
  const originalStop = runtime.stop;
  runtime.stop = () => {
    clearInterval(timer);
    originalStop();
  };
  return runtime;
}
