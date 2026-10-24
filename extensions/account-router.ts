// Account router: virtual models that route each request to any registered
// provider/model, with per-provider account pools for multi-account rotation.
//
// Two independent layers, both provider-agnostic:
//
//   1. Routes — a virtual model (`router/<name>`) with an ordered fallback
//      chain of `provider/model` targets. Selection is sticky across tool
//      continuations so prompt caches and thinking signatures stay valid, and
//      a failed target advances the chain.
//
//   2. Pools  — a set of accounts for one provider, rotated by strategy with
//      cooldown on quota walls and a failure budget. Pools work for *any*
//      provider because a pool is exposed as a shadow provider that injects
//      the chosen account's credential into each request. The request-time
//      `apiKey` option wins over the provider's stored auth, so no provider
//      needs special support.
//
// Config files, global then project (project wins per route/pool name):
//   ~/.pi/agent/account-router.json
//   .pi/account-router.json
//
// Shape:
//   {
//     "routes": [{ "name": "auto", "targets": ["antigravity/gemini-3-pro", "openai/gpt-5"] }],
//     "pools":  { "ag": { "provider": "antigravity", "source": "antigravity-accounts",
//                         "strategy": "round-robin" } }
//   }
//
// A target may name a pool: `"targets": [{ "model": "antigravity/gemini-3-pro", "pool": "ag" }]`.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream, getApiProvider, normalizeContext,
  type Api, type AssistantMessage, type AssistantMessageEvent, type Model, type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import {
  accountLabel, agentStatePath, describeHealth, emptyState, healthFor, mergeConfigs, normalizeState,
  parseRouterConfig, readRouterConfig, readRouterState, recordFailure, recordSuccess, selectAccount,
  writeRouterState,
  type AccountConfig, type PoolConfig, type RouterConfig, type RouterState,
} from "../lib/account-pools.ts";
import {
  ANTIGRAVITY_SOURCE, poolAccounts, resolveAccountCredential, sourceDefaultAgentDir,
  type SourceContext, type StoredAntigravityAccount,
} from "../lib/account-sources.ts";
import {
  advanceChain, findRoute, mergeRouteTables, parseModelRef, readRouteTable, routeTargets,
  targetPool, type RouteConfig, type RouteTable, type RouteTarget,
} from "../lib/model-routes.ts";
import { refreshAntigravityToken } from "../vendor/antigravity/auth/oauth.ts";
import { getCurrentAntigravityCatalog } from "../vendor/antigravity/models/models.ts";
import { ANTIGRAVITY_API } from "../vendor/antigravity/types/types.ts";
import { offerSection, REFRESH_EVENT } from "../lib/sidebar-channel.ts";

const STATE_ENTRY = "account-router:v1";
const DEFAULT_ROUTER_PROVIDER = "router";
/** Prefix for the shadow provider that fronts a pool's accounts. */
const POOL_PROVIDER_PREFIX = "pool:";
const COMMAND = "router";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Provider id of the shadow provider that fronts `poolName`. */
export function poolProviderId(poolName: string): string {
  return `${POOL_PROVIDER_PREFIX}${poolName}`;
}

/** The pool name behind a shadow provider id, if any. */
export function poolNameFromProvider(providerId: string): string | undefined {
  return providerId.startsWith(POOL_PROVIDER_PREFIX) ? providerId.slice(POOL_PROVIDER_PREFIX.length) : undefined;
}

/** Providers a config references, for diagnostics and auth checks. */
export function referencedProviders(config: RouterConfig, table: RouteTable): string[] {
  const providers = new Set<string>();
  for (const pool of Object.values(config.pools)) providers.add(pool.provider);
  for (const route of table.routes) {
    for (const target of route.targets) {
      const parsed = parseModelRef(target.model);
      if (parsed) providers.add(parsed.provider);
    }
  }
  return [...providers].sort();
}

/** Minimal error message for an aborted-or-failed provider request. */
function errorMessage(message: unknown): string {
  return message instanceof Error ? message.message : String(message);
}

export default async function accountRouterExtension(pi: ExtensionAPI): Promise<void> {
  const agentDir = (() => {
    try { return getAgentDir(); } catch { return sourceDefaultAgentDir(); }
  })();

  let activeCwd = process.cwd();
  if (typeof pi.exec === "function") {
    try {
      const res = await pi.exec(process.execPath, ["-e", "process.stdout.write(process.cwd())"]);
      if (res.code === 0 && res.stdout) {
        activeCwd = res.stdout.trim();
      }
    } catch {}
  }

  let config: RouterConfig = { pools: {} };
  let table: RouteTable = { provider: DEFAULT_ROUTER_PROVIDER, routes: [] };
  let state: RouterState = emptyState();
  let configErrors: string[] = [];
  let lastError: string | undefined;
  /** Shadow provider id → pool name. */
  let shadows = new Map<string, string>();
  /** Account used for the in-flight request, so health lands on the right one. */
  let inFlight: { pool: string; accountId: string } | undefined;
  let uiCtx: ExtensionContext | undefined;
  /** Only one recovery probe per pool/account at a time. */
  const probing = new Set<string>();

  const statePath = agentStatePath(agentDir);

  const sourceContext = (): SourceContext => ({
    agentDir,
    // Refresh through the vendored implementation, so token rotation stays in
    // one place and the router has no npm dependency on pi-antigravity.
    refresh: async (account: StoredAntigravityAccount) =>
      await refreshAntigravityToken(account as never) as StoredAntigravityAccount,
  });

  const persistState = (): void => { writeRouterState(statePath, state); };

  const loadConfig = (cwd: string): void => {
    const globalPath = join(agentDir, "account-router.json");
    const projectPath = join(cwd, ".pi", "account-router.json");
    const global = readRouterConfig(globalPath);
    const project = readRouterConfig(projectPath);
    config = mergeConfigs(global.config, project.config);
    table = mergeRouteTables(
      readRouteTable(globalPath, DEFAULT_ROUTER_PROVIDER).table,
      readRouteTable(projectPath, DEFAULT_ROUTER_PROVIDER).table,
    );
    configErrors = [
      ...global.errors, ...project.errors,
      ...readRouteTable(globalPath, DEFAULT_ROUTER_PROVIDER).errors,
      ...readRouteTable(projectPath, DEFAULT_ROUTER_PROVIDER).errors,
    ];
    lastError = configErrors[0] ?? lastError;
  };

  /** Restore router state from the session branch, falling back to disk. */
  const restore = (ctx: ExtensionContext): void => {
    let restored = emptyState();
    let found = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
      restored = normalizeState(entry.data);
      found = true;
    }
    state = found ? restored : readRouterState(statePath);
  };

  const persist = (ctx: ExtensionContext): void => {
    pi.appendEntry(STATE_ENTRY, structuredClone(state) as never);
    persistState();
    void ctx;
  };

  /** Accounts for a pool, honoring its source (explicit list or discovered logins). */
  const accountsOf = (pool: PoolConfig): AccountConfig[] => poolAccounts(pool, sourceContext());

  /**
   * Resolve credentials for the next request on a pool, walking accounts until
   * one yields a usable credential. Returns a display-safe error otherwise.
   */
  const acquire = async (
    pool: PoolConfig,
    poolName: string,
    exclude: readonly string[] = [],
  ): Promise<{ account: AccountConfig; apiKey?: string } | { error: string }> => {
    const accounts = accountsOf(pool);
    if (!accounts.length) {
      return { error: `pool "${poolName}" has no accounts (add accounts or link a login)` };
    }
    const effective: PoolConfig = { ...pool, accounts };
    const tried = new Set<string>(exclude);
    let lastProblem = `pool "${poolName}": no usable account (accounts are cooling down, recovering, or disabled)`;
    while (tried.size < accounts.length) {
      const picked = selectAccount(effective, state, { poolName, exclude: [...tried] });
      if (!picked) break;
      if (probing.has(`${poolName}/${picked.account.id}`)) {
        tried.add(picked.account.id);
        continue;
      }
      const resolved = await resolveAccountCredential(effective, picked.account, sourceContext());
      if ("error" in resolved) {
        tried.add(picked.account.id);
        recordFailure(state, poolName, picked.account.id, resolved.error, { cooldownMs: pool.cooldownMs });
        persistState();
        lastProblem = resolved.error;
        continue;
      }
      persistState();
      return { account: picked.account, ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}) };
    }
    return { error: lastProblem };
  };

  // ── Shadow providers: one provider per pool ────────────────────────────────

  /**
   * Stream a request for `poolName`, substituting the selected account's
   * credential. The underlying API implementation is called directly with a
   * request-scoped `apiKey`, which Pi's auth resolution treats as an override.
   */
  /**
   * Build the stream handler for a pool's shadow provider. The underlying API
   * implementation owns the wire format; only the credential is swapped here.
   */
  const makePoolStream = (poolName: string) =>
    (
      model: Model<Api>,
      context: TranscriptContext,
      options?: SimpleStreamOptions,
    ): ReturnType<typeof createAssistantMessageEventStream> => {
      const ctx = uiCtx;
      if (!ctx) throw new Error("account router is not initialized yet");
      const stream = createAssistantMessageEventStream();
      const recoveryUsage: AssistantMessage["usage"] = {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const addUsage = (total: AssistantMessage["usage"], extra: AssistantMessage["usage"]): void => {
        ensureUsageCost(total);
        ensureUsageCost(extra);
        for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
          total[field] += extra[field] ?? 0;
        }
        for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
          total.cost[field] += extra.cost[field] ?? 0;
        }
      };
      const run = async (): Promise<void> => {
        const pool = config.pools[poolName];
        if (!pool) throw new Error(`unknown pool "${poolName}"`);
        const tried = new Set<string>();
        while (true) {
          if (options?.signal?.aborted) throw new Error("Request aborted");
          const acquired = await acquire(pool, poolName, [...tried]);
          if ("error" in acquired) throw new Error(acquired.error);
          if (options?.signal?.aborted) throw new Error("Request aborted");
          const accountId = acquired.account.id;
          const probeKey = `${poolName}/${accountId}`;
          // Credential resolution is async; another request may have claimed
          // this probe or put the selected account back into cooldown.
          if (probing.has(probeKey) || !selectAccount({ ...pool, accounts: [acquired.account] }, state, { poolName })) {
            tried.add(accountId);
            continue;
          }
          const needsProbe = healthFor(state, poolName, accountId).needsProbe === true;
          if (needsProbe) probing.add(probeKey);
          let recovering = needsProbe;
          inFlight = { pool: poolName, accountId };
          updateSidebar();
          try {
            // Use the selected member's implementation, not a sibling's endpoint/auth.
            const memberProvider = ctx.modelRegistry.getProvider(accountId);
            const source = memberProvider ?? catalogProviderFor(ctx, pool.provider);
            if (!source) throw new Error(`provider "${pool.provider}" is not registered`);
            const physical = { ...model, provider: memberProvider ? accountId : pool.provider } as Model<Api>;
            const requestOptions: SimpleStreamOptions = {
              ...options,
              ...(acquired.apiKey ? { apiKey: acquired.apiKey } : {}),
            };
            if (needsProbe) {
              // No transcript, tools, session/cache id, or request-transform hooks:
              // recovery must stay tiny and never act on the user's conversation.
              const signal = AbortSignal.any([
                AbortSignal.timeout(15_000), ...(options?.signal ? [options.signal] : []),
              ]);
              const probe = source.streamSimple(physical, normalizeContext({
                messages: [{ role: "user", content: [{ type: "text", text: "Reply OK." }], timestamp: Date.now() }],
              }), {
                apiKey: acquired.apiKey, headers: options?.headers,
                env: options?.env, fetch: options?.fetch,
                // Omitting reasoning means off in pi-ai's simple-stream API.
                signal, timeoutMs: 15_000, maxTokens: 16, maxRetries: 0,
                cacheRetention: "none", transport: "sse",
              });
              let result: AssistantMessage | undefined;
              for await (const event of probe as AsyncIterable<AssistantMessageEvent>) {
                if (event.type === "done") result = event.message;
                else if (event.type === "error") result = event.error;
              }
              if (result?.usage) addUsage(recoveryUsage, result.usage);
              if (!result || result.stopReason === "error" || result.stopReason === "aborted") {
                throw new Error(result?.errorMessage ?? "Recovery probe ended without a successful result");
              }
              if (options?.signal?.aborted) throw new Error("Request aborted");
              recordSuccess(state, poolName, accountId);
              persistState();
              probing.delete(probeKey);
              recovering = false;
            }
            const inner = source.streamSimple(physical, context, requestOptions);
            let final: AssistantMessage | undefined;
            for await (const event of inner as AsyncIterable<AssistantMessageEvent>) {
              if (event.type === "done" && event.message?.usage) addUsage(event.message.usage, recoveryUsage);
              else if (event.type === "error" && event.error?.usage) addUsage(event.error.usage, recoveryUsage);
              stream.push(event);
              if (event.type === "done") final = event.message;
              else if (event.type === "error") final = event.error;
            }
            if (!final) throw new Error("provider stream ended without a result");
            if (final.stopReason === "error") {
              recordFailure(state, poolName, accountId, final.errorMessage, { cooldownMs: pool.cooldownMs });
              lastError = final.errorMessage?.slice(0, 300) ?? lastError;
            } else if (final.stopReason !== "aborted") {
              recordSuccess(state, poolName, accountId);
            }
            persistState();
            stream.end(final);
            return;
          } catch (error) {
            if (options?.signal?.aborted) throw error;
            recordFailure(state, poolName, accountId, errorMessage(error), { cooldownMs: pool.cooldownMs });
            lastError = errorMessage(error).slice(0, 300);
            persistState();
            // A failed probe never gets the full request; try another account.
            if (!recovering) throw error;
            tried.add(accountId);
          } finally {
            probing.delete(probeKey);
            inFlight = undefined;
            updateSidebar();
          }
        }
      };
      void run().catch((error: unknown) => {
        inFlight = undefined;
        updateSidebar();
        const message = errorMessage(error);
        lastError = message.slice(0, 300);
        const failure: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api as Api,
          provider: model.provider,
          model: model.id,
          usage: recoveryUsage,
          stopReason: options?.signal?.aborted ? "aborted" : "error",
          errorMessage: message,
          timestamp: Date.now(),
        };
        stream.push({
          type: "error",
          reason: options?.signal?.aborted ? "aborted" : "error",
          error: failure,
        });
        stream.end(failure);
      });
      return stream;
    };

  /**
   * Register shadow providers that front a pool's accounts.
   *
   * Pi dispatches an extension's `streamSimple` only when the model's `api`
   * matches the provider's top-level `api`, and it rejects a provider that
   * declares `streamSimple` without one. So models are grouped by API and each
   * group gets its own shadow provider; every request is intercepted and its
   * credential replaced.
   */
  /**
   * The provider whose catalog a pool mirrors.
   *
   * Normally the pool's own provider. When that id is not registered but an
   * account family is (`antigravity` → `antigravity-1`, `antigravity-2`, …), the
   * first member supplies the catalog: the models are identical and the
   * credential for each request still comes from the pool's own account store.
   */
  const catalogProviderFor = (ctx: ExtensionContext, providerId: string) => {
    const knownProviderIds = new Set<string>([
      ...ctx.modelRegistry.getRegisteredProviderIds(),
      ...ctx.modelRegistry.getAll().map((m) => m.provider),
    ]);
    const members = [...knownProviderIds]
      .filter((id) => id.startsWith(`${providerId}-`))
      .map((id) => ({ id, index: Number(id.slice(providerId.length + 1)) }))
      .filter((entry) => Number.isInteger(entry.index) && entry.index > 0)
      .sort((a, b) => a.index - b.index);

    for (const member of members) {
      const provider = ctx.modelRegistry.getProvider(member.id);
      if (provider && provider.getModels().length) return provider;
    }

    const exact = ctx.modelRegistry.getProvider(providerId);
    if (exact && exact.getModels().length) return exact;
    return exact ?? undefined;
  };

  const getStartupModels = (
    providerId: string,
    poolName: string,
    pool: PoolConfig,
  ): { name?: string; models: Model<Api>[] } | undefined => {
    if (providerId === "antigravity" || pool.source === "antigravity-accounts") {
      const catalog = getCurrentAntigravityCatalog();
      return {
        name: "Antigravity",
        models: catalog.models as Model<Api>[],
      };
    }

    for (const p of [
      join(activeCwd, ".pi", "models.json"),
      join(activeCwd, "models.json"),
      join(agentDir, "models.json"),
    ]) {
      if (existsSync(p)) {
        try {
          const parsed = JSON.parse(readFileSync(p, "utf8"));
          let entry = parsed?.providers?.[providerId];
          if (!entry || !entry.models || !Array.isArray(entry.models) || !entry.models.length) {
            const memberKeys = Object.keys(parsed?.providers ?? {})
              .filter((k) => k.startsWith(`${providerId}-`))
              .map((k) => ({ key: k, index: Number(k.slice(providerId.length + 1)) }))
              .filter((e) => Number.isInteger(e.index) && e.index > 0)
              .sort((a, b) => a.index - b.index);
            if (memberKeys.length && memberKeys[0]) {
              entry = parsed.providers[memberKeys[0].key];
            }
          }
          if (entry?.models && Array.isArray(entry.models) && entry.models.length) {
            return {
              name: entry.name ?? providerId,
              models: entry.models as Model<Api>[],
            };
          }
        } catch {}
      }
    }

    if ((pool as { models?: Model<Api>[] }).models && Array.isArray((pool as { models?: Model<Api>[] }).models)) {
      return {
        name: providerId,
        models: (pool as { models?: Model<Api>[] }).models!,
      };
    }

    const inferred: Model<Api>[] = [];
    for (const route of table.routes) {
      for (const target of route.targets) {
        if (targetPool(route, target) === poolName || target.model.startsWith(`${providerId}/`)) {
          const parsed = parseModelRef(target.model);
          if (parsed && (parsed.provider === providerId || targetPool(route, target) === poolName)) {
            if (!inferred.some((m) => m.id === parsed.modelId)) {
              inferred.push({
                id: parsed.modelId,
                name: parsed.modelId,
                api: "openai-completions" as Api,
                input: ["text"],
                reasoning: false,
                contextWindow: 100_000,
                maxTokens: 2_000,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              } as Model<Api>);
            }
          }
        }
      }
    }
    if (inferred.length) {
      return { name: providerId, models: inferred };
    }

    return undefined;
  };

  const registerPools = (ctx?: ExtensionContext): void => {
    const next = new Map<string, string>();
    for (const [poolName, pool] of Object.entries(config.pools)) {
      let sourceName: string = pool.provider;
      let chatModels: Model<Api>[] = [];

      if (ctx) {
        const source = catalogProviderFor(ctx, pool.provider);
        if (source) {
          sourceName = source.name ?? pool.provider;
          chatModels = source.getModels().filter((model) => model.type === undefined || model.type === "chat");
        }
      }

      if (!chatModels.length) {
        const startupCatalog = getStartupModels(pool.provider, poolName, pool);
        if (startupCatalog) {
          sourceName = startupCatalog.name ?? pool.provider;
          chatModels = startupCatalog.models.filter((model) => model.type === undefined || model.type === "chat");
        }
      }

      if (!chatModels.length) {
        if (ctx) {
          configErrors.push(
            `pool "${poolName}": provider "${pool.provider}" is not registered` +
            (pool.provider === "antigravity"
              ? '; with per-account providers, use "antigravity" only if accounts are linked (/antigravity), or target antigravity-N directly'
              : ""),
          );
        }
        continue;
      }

      const byApi = new Map<string, typeof chatModels>();
      for (const model of chatModels) {
        const effectiveApi = model.api ?? (
          pool.provider === "antigravity" || pool.source === "antigravity-accounts"
            ? ANTIGRAVITY_API
            : "openai-completions"
        );
        const group = byApi.get(effectiveApi) ?? [];
        group.push({ ...model, api: effectiveApi as Api });
        byApi.set(effectiveApi, group);
      }
      for (const [api, models] of byApi) {
        // One API needs no marker; several get a stable suffix per API.
        const providerId = byApi.size === 1
          ? poolProviderId(poolName)
          : `${poolProviderId(poolName)}#${api}`;
        const baseUrl = models.find((m) => m.baseUrl)?.baseUrl ?? (
          pool.provider === "antigravity" || pool.source === "antigravity-accounts"
            ? "https://cloudcode-pa.googleapis.com"
            : "http://127.0.0.1:1/v1"
        );
        try {
          pi.registerProvider(providerId, {
            name: `${sourceName} (${poolName}${byApi.size === 1 ? "" : ` ${api}`})`,
            api: api as Api,
            baseUrl,
            // Every request overwrites this; a literal keeps the provider
            // "configured" so Pi never filters the pool out of the catalog.
            apiKey: "pool-managed",
            models: models.map((model) => ({
              id: model.id,
              name: model.name ?? model.id,
              api: (model.api ?? api) as Api,
              baseUrl: model.baseUrl ?? baseUrl,
              input: model.input ?? ["text"],
              cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              reasoning: model.reasoning ?? false,
              contextWindow: model.contextWindow ?? 100_000,
              maxTokens: model.maxTokens ?? 2_000,
              ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
              ...(model.compat ? { compat: model.compat } : {}),
            })),
            streamSimple: makePoolStream(poolName) as never,
          });
          next.set(providerId, poolName);
        } catch (error) {
          configErrors.push(`pool "${poolName}": ${errorMessage(error)}`);
        }
      }
    }
    shadows = next;
  };

  /** Physical model for a target, preferring the pool's shadow provider. */
  const resolveTarget = (
    ctx: ExtensionContext,
    route: RouteConfig,
    target: RouteTarget,
  ): { model: Model<Api>; via?: string } | { error: string } => {
    const parsed = parseModelRef(target.model);
    if (!parsed) return { error: `invalid target "${target.model}"` };
    const poolName = targetPool(route, target);
    if (poolName) {
      const pool = config.pools[poolName];
      if (!pool) return { error: `route "${route.name}" names unknown pool "${poolName}"` };
      // Models of a pool are split across one shadow provider per API.
      const exposed: string[] = [];
      for (const providerId of shadows.keys()) {
        if (shadows.get(providerId) !== poolName) continue;
        const model = ctx.modelRegistry.find(providerId, parsed.modelId);
        if (model) return { model, via: poolName };
        exposed.push(...ctx.modelRegistry.getProvider(providerId)?.getModels().map((entry) => entry.id) ?? []);
      }
      const unique = [...new Set(exposed)].sort();
      return {
        error: `pool "${poolName}" (provider "${pool.provider}") does not expose ${parsed.modelId}` +
          (unique.length ? `; it exposes: ${unique.slice(0, 8).join(", ")}${unique.length > 8 ? ", …" : ""}` : "; is that provider registered?"),
      };
    }
    const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
    if (!model) {
      const known = ctx.modelRegistry.getProvider(parsed.provider);
      return {
        error: known
          ? `provider "${parsed.provider}" has no model "${parsed.modelId}"`
          : `provider "${parsed.provider}" is not registered (check the provider id in your route target)`,
      };
    }
    if (!ctx.modelRegistry.hasConfiguredAuth(model)) return { error: `${target.model} has no credentials` };
    return { model };
  };

  /**
   * Whether a target is the model that answered a request.
   *
   * Pi reports the *dispatched* model, which for a pooled target is the shadow
   * provider (`pool:ag/gemini-3.8-flash`) rather than the target's own
   * `antigravity/gemini-3.8-flash`. Matching on the model id and accepting
   * either provider keeps continuations on the answering model instead of
   * silently re-routing to the head of the chain.
   */
  const targetMatches = (
    route: RouteConfig,
    target: RouteTarget,
    provider: string,
    modelId: string,
  ): boolean => {
    const parsed = parseModelRef(target.model);
    if (!parsed || parsed.modelId !== modelId) return false;
    if (parsed.provider === provider) return true;
    const poolName = targetPool(route, target);
    if (!poolName) return false;
    if (shadows.get(provider) === poolName) return true;
    const pool = config.pools[poolName];
    if (pool?.accounts.some((a) => a.id === provider)) return true;
    return provider.startsWith(`${parsed.provider}-`);
  };

  /**
   * Expand a target into the concrete providers that can serve it.
   *
   * A target that names an account family — `antigravity/gemini-3.1-pro` — and
   * whose base provider is not registered fans out over the registered members
   * (`antigravity-1`, `antigravity-2`, …, ordered by slot). That keeps route
   * config portable: linking or removing an account does not require editing it.
   * A target resolving normally, or one that names a pool, is left untouched.
   */
  const expandTarget = (
    ctx: ExtensionContext,
    route: RouteConfig,
    target: RouteTarget,
  ): RouteTarget[] => {
    if (targetPool(route, target)) return [target];
    const parsed = parseModelRef(target.model);
    if (!parsed) return [target];

    const knownProviderIds = new Set<string>([
      ...ctx.modelRegistry.getRegisteredProviderIds(),
      ...ctx.modelRegistry.getAll().map((m) => m.provider),
    ]);
    const members = [...knownProviderIds]
      .filter((id) => id.startsWith(`${parsed.provider}-`))
      .map((id) => ({ id, index: Number(id.slice(parsed.provider.length + 1)) }))
      .filter((entry) => Number.isInteger(entry.index) && entry.index > 0)
      .filter((entry) => ctx.modelRegistry.find(entry.id, parsed.modelId) !== undefined)
      .sort((a, b) => a.index - b.index);

    if (members.length) {
      const exactModel = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
      if (exactModel && ctx.modelRegistry.hasConfiguredAuth(exactModel)) {
        return [target];
      }
      return members.map((entry) => ({ ...target, model: `${entry.id}/${parsed.modelId}` }));
    }

    // The exact provider works, or exists and simply lacks this model (a real
    // error worth reporting rather than papering over with a sibling).
    if (ctx.modelRegistry.find(parsed.provider, parsed.modelId)) return [target];
    if (ctx.modelRegistry.getProvider(parsed.provider)) return [target];

    return [target];
  };

  /** Ordered candidates for a request, accounting for stickiness and retries. */
  const candidateChain = (
    ctx: ExtensionContext,
    route: RouteConfig,
    reason: string,
    previous?: { provider: string; modelId: string },
    failed?: { provider: string; modelId: string },
  ): RouteTarget[] => {
    const expanded = routeTargets(route).flatMap((target) => expandTarget(ctx, route, target));
    const base = reason === "retry" && failed
      ? advanceChain(
        { ...route, targets: expanded },
        (target) => targetMatches(route, target, failed.provider, failed.modelId),
      )
      : expanded;
    if (reason === "user" || !previous || route.sticky === false) return base;
    const same = base.filter((target) => targetMatches(route, target, previous.provider, previous.modelId));
    return same.length ? same : base;
  };

  const choose = (
    ctx: ExtensionContext,
    route: RouteConfig,
    reason: string,
    previous?: { provider: string; modelId: string },
    failed?: { provider: string; modelId: string },
  ): { model: Model<Api>; thinking?: string; via?: string } | { error: string } => {
    const problems: string[] = [];
    for (const target of candidateChain(ctx, route, reason, previous, failed)) {
      const resolved = resolveTarget(ctx, route, target);
      if ("error" in resolved) { problems.push(resolved.error); continue; }
      return { model: resolved.model, thinking: target.thinking, via: resolved.via };
    }
    return { error: problems[0] ?? `route "${route.name}" has no usable target` };
  };

  // ── Virtual models ─────────────────────────────────────────────────────────

  const registerRoutes = (): void => {
    for (const route of table.routes) {
      pi.registerVirtualModel({
        provider: table.provider,
        id: route.name,
        name: route.label ?? route.name,
        ...(route.description ? { description: route.description } : {}),
        thinkingLevels: ["off", "low", "medium", "high"],
        route(request, ctx) {
          const previous = request.previous
            ? { provider: request.previous.model.provider, modelId: request.previous.model.id }
            : undefined;
          const failed = request.failed
            ? { provider: request.failed.model.provider, modelId: request.failed.model.id }
            : undefined;
          // `direct` requests (compaction, extension calls) get the primary target.
          const reason = request.reason === "direct" ? "user" : request.reason;
          const picked = choose(ctx as unknown as ExtensionContext, route, reason, previous, failed);
          if ("error" in picked) {
            lastError = picked.error;
            throw new Error(picked.error);
          }
          return {
            model: picked.model,
            thinkingLevel: ((picked.thinking ?? request.thinkingLevel) as never),
          };
        },
      });
    }
  };

  // ── Early registration ────────────────────────────────────────────────────

  // Register routes and known pools during extension factory execution so they
  // are queued in pending registrations and present when Pi resolves scoped models.
  loadConfig(activeCwd);
  registerRoutes();
  registerPools();

  // ── Sidebar section ────────────────────────────────────────────────────────

  const resolveActivePool = (): { poolName: string; pool: PoolConfig } | undefined => {
    // 1. In-flight request pool
    if (inFlight) {
      const pool = config.pools[inFlight.pool];
      if (pool) return { poolName: inFlight.pool, pool };
    }

    // 2. Currently selected model in session
    const currentModel = uiCtx?.model;
    if (currentModel) {
      const directPool = poolNameFromProvider(currentModel.provider);
      if (directPool) {
        const baseName = directPool.split("#")[0] ?? directPool;
        if (config.pools[baseName]) return { poolName: baseName, pool: config.pools[baseName]! };
        if (config.pools[directPool]) return { poolName: directPool, pool: config.pools[directPool]! };
      }
      if (currentModel.provider === table.provider) {
        const route = findRoute(table, currentModel.id);
        if (route) {
          for (const target of route.targets) {
            const p = targetPool(route, target);
            if (p && config.pools[p]) return { poolName: p, pool: config.pools[p]! };
          }
        }
      }
    }

    // 3. Fallback: if there is only 1 configured pool, use it
    const poolNames = Object.keys(config.pools);
    if (poolNames.length === 1 && poolNames[0]) {
      const p = poolNames[0];
      return { poolName: p, pool: config.pools[p]! };
    }

    return undefined;
  };

  const updateSidebar = (): void => {
    const active = resolveActivePool();
    if (!active) {
      offerSection(pi, { id: "account", title: "Account", rows: [], hint: "/router" });
      return;
    }

    const { poolName, pool } = active;
    const accounts = accountsOf(pool);
    if (!accounts.length) {
      offerSection(pi, {
        id: "account",
        title: `Account (${poolName})`,
        tone: "warning",
        rows: ["No accounts configured"],
        hint: pool.source === "antigravity-accounts" ? "/antigravity login" : "/router",
      });
      return;
    }

    // Determine the current account:
    // If in flight, that account is currently answering.
    // Otherwise, the last selected account (or the first account if none selected yet).
    let currentAccountId: string | undefined = inFlight?.pool === poolName ? inFlight.accountId : undefined;
    if (!currentAccountId) {
      const last = state.cursor[poolName];
      if (last && accounts.some((a) => a.id === last)) {
        currentAccountId = last;
      } else {
        currentAccountId = accounts[0]!.id;
      }
    }

    const account = accounts.find((a) => a.id === currentAccountId) ?? accounts[0]!;
    const index = accounts.findIndex((a) => a.id === account.id);
    const counter = index >= 0 ? `(${index + 1}/${accounts.length})` : `(${accounts.length})`;
    const label = account.label ?? account.id;

    const health = healthFor(state, poolName, account.id);
    const now = Date.now();
    const isCooling = health.cooldownUntil !== undefined && health.cooldownUntil > now;

    const rows: string[] = [];
    rows.push(`● ${label} ${counter}`);

    if (isCooling) {
      const remSec = Math.ceil((health.cooldownUntil! - now) / 1000);
      rows.push(`cooling down (${remSec}s)`);
    } else if (health.needsProbe) {
      rows.push(probing.has(`${poolName}/${account.id}`) ? "checking recovery…" : "awaiting recovery probe");
    } else if (inFlight) {
      rows.push(`active · ${pool.strategy}`);
    } else {
      rows.push(`${pool.strategy} · ${accounts.length} accts`);
    }

    offerSection(pi, {
      id: "account",
      title: `Account (${poolName})`,
      tone: isCooling ? "warning" : "accent",
      rows,
      hint: "/router · cycle on request",
    });
  };

  const ensureUsageCost = (usage: any): void => {
    if (usage && (!usage.cost || typeof usage.cost.total === "undefined")) {
      usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    }
  };

  const sanitizeSessionEntries = (ctx: ExtensionContext): void => {
    try {
      const entries = ctx.sessionManager?.getEntries?.() ?? [];
      for (const entry of entries) {
        if (entry.type === "usage") ensureUsageCost(entry.usage);
        if (entry.type === "message" && "usage" in entry.message && (entry.message as any).usage) {
          ensureUsageCost((entry.message as any).usage);
        }
        if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) ensureUsageCost(entry.usage);
      }
    } catch {}
  };

  // ── Events ─────────────────────────────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    uiCtx = ctx;
    sanitizeSessionEntries(ctx);
    if (ctx.cwd) activeCwd = ctx.cwd;
    loadConfig(activeCwd);
    restore(ctx);
    registerPools(ctx);
    registerRoutes();
    updateSidebar();
  });

  pi.on("session_tree", (_event, ctx) => { uiCtx = ctx; sanitizeSessionEntries(ctx); restore(ctx); updateSidebar(); });
  pi.on("turn_start", () => { inFlight = undefined; updateSidebar(); });
  pi.on("model_select", (_event, ctx) => { uiCtx = ctx; updateSidebar(); });

  // The request-local stream owns health updates. HTTP/message callbacks can
  // run concurrently and must not attribute a failure via the UI's inFlight slot.
  pi.on("message_end", (event) => {
    const msg = event.message as any;
    if (msg?.usage) ensureUsageCost(msg.usage);
  });

  pi.on("session_shutdown", () => { persistState(); uiCtx = undefined; });

  pi.events?.on(REFRESH_EVENT, () => { updateSidebar(); });
  pi.events?.on("account-router:open", () => {
    if (uiCtx) {
      emit(uiCtx as never, formatStatus(), "info");
    }
  });


  // ── Command ────────────────────────────────────────────────────────────────

  const emit = (ctx: ExtensionCommandContext, text: string, type: "info" | "warning" | "error" = "info"): void => {
    if (ctx.hasUI) { ctx.ui.notify(text, type); return; }
    if (type === "info") console.log(text); else console.error(text);
  };

  const formatStatus = (): string => {
    if (!table.routes.length && !Object.keys(config.pools).length) {
      return [
        "Account router: nothing configured yet.",
        `Create ${join(agentDir, "account-router.json")} (global) or .pi/account-router.json (project).`,
        "Run /router help for the config shape.",
      ].join("\n");
    }
    const lines: string[] = [];
    if (table.routes.length) {
      lines.push(`Routes (virtual provider "${table.provider}"):`);
      for (const route of table.routes) {
        const chain = route.targets
          .map((target) => {
            const poolName = targetPool(route, target);
            const thinking = target.thinking ? `:${target.thinking}` : "";
            return `${target.model}${thinking}${poolName ? ` [${poolName}]` : ""}`;
          })
          .join(" → ");
        lines.push(`  ${table.provider}/${route.name}: ${chain}`);
      }
    }
    const poolNames = Object.keys(config.pools);
    if (poolNames.length) {
      lines.push("Pools:");
      for (const name of poolNames) {
        const pool = config.pools[name];
        const accounts = accountsOf(pool);
        const now = Date.now();
        const maxFailures = pool.maxConsecutiveFailures ?? 3;
        const usable = accounts.filter((account) => {
          const health = healthFor(state, name, account.id);
          if (health.cooldownUntil && health.cooldownUntil > now) return false;
          return !health.needsProbe && !(maxFailures > 0 && health.failures >= maxFailures);
        }).length;
        const source = pool.source ? `, ${pool.source}` : "";
        lines.push(`  ${name} → ${pool.provider} (${pool.strategy}, ${usable}/${accounts.length} usable${source})`);
      }
    }
    if (configErrors.length) lines.push(`Config warnings:\n${configErrors.map((line) => `  ${line}`).join("\n")}`);
    if (lastError) lines.push(`Last error: ${lastError}`);
    return lines.join("\n");
  };

  const formatAccounts = (poolName?: string): string => {
    const names = poolName ? [poolName] : Object.keys(config.pools);
    if (!names.length) return "No pools configured.";
    const lines: string[] = [];
    for (const name of names) {
      const pool = config.pools[name];
      if (!pool) { lines.push(`Unknown pool "${name}". Known: ${Object.keys(config.pools).join(", ") || "(none)"}`); continue; }
      const accounts = accountsOf(pool);
      lines.push(`Pool ${name} → ${pool.provider} (${pool.strategy}, cursor ${state.cursor[name] ?? "none"})`);
      if (!accounts.length) lines.push("  (no accounts)");
      for (const account of accounts) {
        lines.push(`  ${accountLabel(account)}: ${describeHealth(healthFor(state, name, account.id))}`);
      }
    }
    return lines.join("\n");
  };

  pi.registerCommand(COMMAND, {
    description: "Account router: status, accounts, use, reset, reload",
    handler: async (args, ctx) => {
      const input = (args ?? "").trim();
      const [verb, ...rest] = input.split(/\s+/).filter(Boolean);
      const arg = rest.join(" ");
      switch (verb) {
        case undefined:
        case "status":
          emit(ctx, formatStatus());
          return;
        case "accounts":
        case "list":
          emit(ctx, formatAccounts(arg || undefined));
          return;
        case "help":
          emit(ctx, [
            "Account router:",
            "  /router                    routes and pools",
            "  /router accounts [pool]    per-account health",
            "  /router use <pool> <id>    pin a pool to one account",
            "  /router reset [pool]       clear health and pins",
            "  /router reload             re-read config files",
            "",
            "Config (global ~/.pi/agent/account-router.json or project .pi/account-router.json):",
            '  "routes": [{ "name": "auto", "targets": ["antigravity/gemini-3-pro", "openai/gpt-5"] }]',
            '  "pools":  { "ag": { "provider": "antigravity", "source": "antigravity-accounts",',
            '                      "strategy": "round-robin", "cooldownMs": 60000 } }',
            "",
            "Strategies: round-robin, least-recently-used, priority, sticky.",
            "Sources: antigravity-accounts (linked Google logins), static (per-account apiKey).",
            "Any provider works: pools front its models without provider-specific code.",
            "Quota failures skip an account until reset, then require a tiny recovery probe.",
            "Failed probes wait for the next cooldown; healthy accounts are never probed.",
          ].join("\n"));
          return;
        case "use": {
          const [poolName, accountId] = rest;
          const pool = poolName ? config.pools[poolName] : undefined;
          if (!pool || !poolName) { emit(ctx, `Unknown pool "${poolName ?? ""}".`, "warning"); return; }
          const accounts = accountsOf(pool);
          if (!accountId) {
            emit(ctx, `Usage: /router use ${poolName} <accountId>. Accounts: ${accounts.map((a) => a.id).join(", ") || "(none)"}`, "warning");
            return;
          }
          const match = accounts.find((account) => account.id === accountId || account.label === accountId);
          if (!match) {
            emit(ctx, `Unknown account "${accountId}". Available: ${accounts.map((a) => a.id).join(", ") || "(none)"}`, "warning");
            return;
          }
          state.cursor[poolName] = match.id;
          const health = healthFor(state, poolName, match.id);
          health.failures = 0;
          delete health.cooldownUntil;
          delete health.needsProbe;
          delete health.lastError;
          persist(ctx);
          emit(ctx, `Pool ${poolName} pinned to ${match.id}.`);
          return;
        }
        case "reset": {
          if (arg && !config.pools[arg]) { emit(ctx, `Unknown pool "${arg}".`, "warning"); return; }
          if (arg) {
            delete state.health[arg];
            delete state.cursor[arg];
          } else {
            state = emptyState();
          }
          persist(ctx);
          emit(ctx, arg ? `Cleared health for pool ${arg}.` : "Cleared all router health and pins.");
          return;
        }
        case "reload": {
          loadConfig(ctx.cwd ?? process.cwd());
          registerPools(ctx);
          registerRoutes();
          updateSidebar();
          emit(ctx, configErrors.length
            ? `Reloaded with ${configErrors.length} warning(s):\n${configErrors.join("\n")}`
            : `Reloaded ${table.routes.length} route(s) and ${Object.keys(config.pools).length} pool(s).`,
            configErrors.length ? "warning" : "info");
          return;
        }
        default:
          emit(ctx, `Unknown subcommand "${verb}". Try /router help.`, "warning");
      }
    },
  });

  void uiCtx;
  void shadows;
  void findRoute;
  void inFlight;
}
