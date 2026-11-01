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
//     "routes": [{ "name": "auto", "targets": ["openrouter/meta/llama-3", "openai/gpt-5"] }],
//     "pools":  { "or": { "provider": "openrouter", "strategy": "round-robin",
//                         "accounts": [{ "id": "acc-1", "apiKey": "$KEY_1" }] } }
//   }
//
// A target may name a pool: `"targets": [{ "model": "openrouter/meta/llama-3", "pool": "or" }]`.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream, normalizeContext,
  type Api, type AssistantMessage, type AssistantMessageEvent, type Model, type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import {
  accountLabel, agentStatePath, describeHealth, emptyState, healthFor, mergeConfigs, normalizeState,
  readRouterConfig, readRouterState, recordFailure, recordSuccess, selectAccount,
  writeRouterState,
  type AccountConfig, type PoolConfig, type RouterConfig, type RouterState,
} from "../lib/provider/account-pools.ts";
import {
  poolAccounts, resolveAccountCredential, sourceDefaultAgentDir,
  type SourceContext,
} from "../lib/provider/account-sources.ts";
import {
  describeRoutePolicy, findRoute, mergeRouteTables, orderTargets, parseModelRef, readRouteTable,
  routeDecision, routeMethod, routeTargets, targetPool,
  type RouteConfig, type RouteFailureClass, type RouteTable, type RouteTarget,
} from "../lib/provider/model-routes.ts";
import {
  classifyFailure, mergeTargets, routerModelChoices, routerRows,
  type RouterAction, type RouterDraft, type RouterPopupResult, type RouterSettingsView,
} from "../lib/provider/router-settings.ts";
import {
  readRouteDoc, removeRoute, routeSources, routerConfigPaths, saveRoute,
} from "../lib/provider/router-config.ts";
import { RouterSettingsPopup } from "../lib/ui/router-settings.ts";
import { popupOverlayOptions } from "../lib/popup.ts";
import { providerModelPicker } from "../lib/provider/provider-model-picker.ts";
import { offerSection, REFRESH_EVENT } from "../lib/sidebar-channel.ts";

const STATE_ENTRY = "account-router:v1";
const DEFAULT_ROUTER_PROVIDER = "router";
/** Prefix for the shadow provider that fronts a pool's accounts. */
const POOL_PROVIDER_PREFIX = "pool:";
const COMMAND = "router";

/** Provider id of the shadow provider that fronts `poolName`. */
export function poolProviderId(poolName: string): string {
  return `${POOL_PROVIDER_PREFIX}${poolName}`;
}

/** The pool name behind a shadow provider id, if any. */
export function poolNameFromProvider(providerId: string): string | undefined {
  return providerId.startsWith(POOL_PROVIDER_PREFIX) ? providerId.slice(POOL_PROVIDER_PREFIX.length) : undefined;
}

/**
 * Key of a route's round-robin cursor in the router state.
 *
 * The state file already maps a pool name to the account that pool picked, so a
 * route cursor lives in the same map behind a prefix that no pool name can
 * collide with: route names may not contain a colon, pool names may.
 */
export function routeCursorKey(routeName: string): string {
  return `route:${routeName}`;
}

/** Move the target a predicate matches to the end, keeping every other one. */
function rotatePast(targets: readonly RouteTarget[], matches: (target: RouteTarget) => boolean): RouteTarget[] {
  const index = targets.findIndex(matches);
  if (index < 0) return targets.slice();
  return [...targets.slice(0, index), ...targets.slice(index + 1), targets[index]!];
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
          configErrors.push(`pool "${poolName}": provider "${pool.provider}" is not registered`);
        }
        continue;
      }

      const byApi = new Map<string, typeof chatModels>();
      for (const model of chatModels) {
        const effectiveApi = model.api ?? "openai-completions";
        const group = byApi.get(effectiveApi) ?? [];
        group.push({ ...model, api: effectiveApi as Api });
        byApi.set(effectiveApi, group);
      }
      for (const [api, models] of byApi) {
        // One API needs no marker; several get a stable suffix per API.
        const providerId = byApi.size === 1
          ? poolProviderId(poolName)
          : `${poolProviderId(poolName)}#${api}`;
        const baseUrl = models.find((m) => m.baseUrl)?.baseUrl ?? "http://127.0.0.1:1/v1";
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

  /**
   * Ordered candidates for a request.
   *
   * The trigger decides where the chain starts — the best candidate, the model
   * that answered last, or the one that just failed — and the method decides
   * the order inside it. Moving past a failed target happens after ordering, so
   * a `cheapest` route cannot re-pick the model that just failed for being
   * cheapest.
   */
  const candidateChain = (
    ctx: ExtensionContext,
    route: RouteConfig,
    request: { reason: "user" | "continuation" | "retry" | "direct"; failedClass?: RouteFailureClass },
    previous?: { provider: string; modelId: string },
    failed?: { provider: string; modelId: string },
  ): RouteTarget[] => {
    const expanded = routeTargets(route).flatMap((target) => expandTarget(ctx, route, target));
    const isFailed = failed
      ? (target: RouteTarget) => targetMatches(route, target, failed.provider, failed.modelId)
      : undefined;
    let decision = routeDecision(route, request);
    // `sticky: false` is the older opt-out of continuation stickiness and keeps
    // working: it re-decides a continuation even under a keeping trigger.
    if (route.sticky === false && decision.head === "previous" && request.reason === "continuation") {
      decision = { head: "order", advance: false };
    }
    if (decision.head === "previous" && previous) {
      const same = expanded.filter((target) => targetMatches(route, target, previous.provider, previous.modelId));
      // The answering model may have left the chain; fall through to ordering
      // rather than failing the request.
      if (same.length) return same;
    }
    if (decision.head === "failed" && isFailed) {
      const index = expanded.findIndex(isFailed);
      if (index >= 0) return [expanded[index]!, ...expanded.slice(0, index), ...expanded.slice(index + 1)];
      return expanded;
    }
    const ordered = orderTargets(
      { ...route, targets: expanded },
      (target) => targetFacts(ctx, route, target),
      {
        cursor: state.cursor[routeCursorKey(route.name)],
        previous: previous ? `${previous.provider}/${previous.modelId}` : undefined,
      },
    );
    return decision.advance && isFailed ? rotatePast(ordered, isFailed) : ordered;
  };

  /**
   * Catalog facts for the cost-aware method.
   *
   * A target that cannot be resolved (unknown provider, no credentials) is not
   * cheaper by virtue of being broken, so it sorts last like an unpriced model.
   */
  const targetFacts = (ctx: ExtensionContext, route: RouteConfig, target: RouteTarget) => {
    const resolved = resolveTarget(ctx, route, target);
    if ("error" in resolved) return undefined;
    const cost = resolved.model.cost;
    return { cost: { input: cost?.input ?? Number.POSITIVE_INFINITY, output: cost?.output ?? Number.POSITIVE_INFINITY } };
  };

  const choose = (
    ctx: ExtensionContext,
    route: RouteConfig,
    request: { reason: "user" | "continuation" | "retry" | "direct"; failedClass?: RouteFailureClass },
    previous?: { provider: string; modelId: string },
    failed?: { provider: string; modelId: string },
  ): { model: Model<Api>; thinking?: string; via?: string } | { error: string } => {
    const problems: string[] = [];
    for (const target of candidateChain(ctx, route, request, previous, failed)) {
      const resolved = resolveTarget(ctx, route, target);
      if ("error" in resolved) { problems.push(resolved.error); continue; }
      if (routeMethod(route) === "round-robin" && request.reason !== "continuation") {
        // The cursor advances on the request that actually picked a target, so
        // a user turn rotates the chain and a continuation does not.
        state.cursor[routeCursorKey(route.name)] = target.model;
        persistState();
      }
      return { model: resolved.model, thinking: target.thinking, via: resolved.via };
    }
    return { error: problems[0] ?? `route "${route.name}" has no usable target` };
  };

  // ── Virtual models ─────────────────────────────────────────────────────────

  /** Route names this extension has registered, so a removal can be undone. */
  const registeredRoutes = new Set<string>();

  const registerRoutes = (): void => {
    for (const route of table.routes) {
      // Registered inline so the host types the `route(request, ctx)` callback.
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
          const picked = choose(ctx as unknown as ExtensionContext, route, {
            reason: request.reason,
            // The trigger's quota/overflow conditions are judged from the failed
            // request's own message, which is the only place the reason lives.
            ...(request.failed ? { failedClass: classifyFailure(request.failed.message?.errorMessage) } : {}),
          }, previous, failed);
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
      registeredRoutes.add(route.name);
    }
  };

  /**
   * Make the registered virtual models match the loaded route table.
   *
   * Registering again replaces an existing route, but nothing removed a route
   * that had been deleted or renamed — it stayed in `/model` as a ghost that
   * failed every request. The editor and `/router reload` both go through here.
   */
  const syncRoutes = (): void => {
    const wanted = new Set(table.routes.map((route) => route.name));
    const stale: string[] = [];
    for (const name of registeredRoutes) if (!wanted.has(name)) stale.push(name);
    for (const name of stale) {
      try {
        (pi as { unregisterVirtualModel?: (provider: string, id: string) => void }).unregisterVirtualModel?.(table.provider, name);
      } catch {
        // A host without the call keeps the stale model until restart; the
        // route table below is still correct, so failing the reload would hide
        // that the edit was saved.
      }
      registeredRoutes.delete(name);
    }
    registerRoutes();
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
    const poolNames = Object.keys(config.pools);
    if (!poolNames.length) {
      offerSection(pi, { id: "account", title: "Account", rows: [], hint: "/router" });
      return;
    }

    if (poolNames.length === 1) {
      const poolName = poolNames[0]!;
      const pool = config.pools[poolName]!;
      const accounts = accountsOf(pool);
      if (!accounts.length) {
        offerSection(pi, {
          id: "account",
          title: `Account (${poolName})`,
          tone: "warning",
          rows: ["No accounts configured"],
          hint: "/router",
        });
        return;
      }

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
        rows.push(remSec >= 3600 ? `cooling down (${Math.round(remSec / 3600)}h)` : `cooling down (${remSec}s)`);
      } else if (health.authFailed) {
        rows.push("auth failed (401)");
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
        tone: (isCooling || health.authFailed) ? "warning" : inFlight ? "accent" : undefined,
        rows,
        hint: "/router · cycle on request",
      });
      return;
    }

    // Multiple pools configured: display all router pools in the sidebar
    const active = resolveActivePool();
    const activeName = active?.poolName;
    const now = Date.now();

    // Prioritize active pool first, then pools with warnings/cooling, then remaining
    const sortedPools = [...poolNames].sort((a, b) => {
      if (a === activeName) return -1;
      if (b === activeName) return 1;
      const aAccounts = accountsOf(config.pools[a]!);
      const bAccounts = accountsOf(config.pools[b]!);
      const aCursor = state.cursor[a] ?? aAccounts[0]?.id;
      const bCursor = state.cursor[b] ?? bAccounts[0]?.id;
      const aHealth = aCursor ? healthFor(state, a, aCursor) : undefined;
      const bHealth = bCursor ? healthFor(state, b, bCursor) : undefined;
      const aWarn = aHealth?.authFailed || (aHealth?.cooldownUntil !== undefined && aHealth.cooldownUntil > now);
      const bWarn = bHealth?.authFailed || (bHealth?.cooldownUntil !== undefined && bHealth.cooldownUntil > now);
      if (aWarn && !bWarn) return -1;
      if (bWarn && !aWarn) return 1;
      return a.localeCompare(b);
    });

    let hasWarning = false;
    let hasActive = false;
    const rows: string[] = [];

    for (const poolName of sortedPools) {
      const pool = config.pools[poolName]!;
      const accounts = accountsOf(pool);
      if (!accounts.length) {
        rows.push(`● ${poolName}: (no accounts)`);
        hasWarning = true;
        continue;
      }
      const isPoolActive = inFlight?.pool === poolName;
      if (isPoolActive) hasActive = true;
      let currentAccountId: string | undefined = isPoolActive && inFlight ? inFlight.accountId : undefined;
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
      const counter = index >= 0 ? `${index + 1}/${accounts.length}` : `${accounts.length}`;
      const label = account.label ?? account.id;

      const health = healthFor(state, poolName, account.id);
      const isCooling = health.cooldownUntil !== undefined && health.cooldownUntil > now;

      let status = "";
      if (isCooling) {
        hasWarning = true;
        const remSec = Math.ceil((health.cooldownUntil! - now) / 1000);
        status = remSec >= 3600 ? `cooling ${Math.round(remSec / 3600)}h` : `cooling ${remSec}s`;
      } else if (health.authFailed) {
        hasWarning = true;
        status = "auth failed";
      } else if (health.needsProbe) {
        status = probing.has(`${poolName}/${account.id}`) ? "probing" : "needs probe";
      } else if (isPoolActive) {
        status = "active";
      }

      const marker = isPoolActive ? "●" : (poolName === activeName ? "●" : "○");
      const statusText = status ? ` · ${status}` : "";
      rows.push(`${marker} ${poolName}: ${label} (${counter})${statusText}`);
    }

    offerSection(pi, {
      id: "account",
      title: `Router Pools (${poolNames.length})`,
      tone: hasWarning ? "warning" : hasActive ? "accent" : undefined,
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
    syncRoutes();
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
        const cursor = routeMethod(route) === "round-robin" ? ` (cursor ${state.cursor[routeCursorKey(route.name)] ?? "start"})` : "";
        lines.push(`  ${table.provider}/${route.name}: ${describeRoutePolicy(route)}${cursor}`);
        lines.push(`    ${chain}`);
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

  // ── Route editor (TUI) ─────────────────────────────────────────────────────

  /** The two config files, resolved exactly the way `loadConfig` resolves them. */
  const routePaths = () => routerConfigPaths(agentDir, activeCwd);

  const pathForFile = (file: "project" | "global"): string => {
    const paths = routePaths();
    return file === "global" ? paths.global : paths.project;
  };

  /** What the editor renders: the effective table, its sources and its problems. */
  const routerView = (): RouterSettingsView => {
    const paths = routePaths();
    const sources = routeSources(paths.global, paths.project);
    const pools = Object.keys(config.pools);
    return {
      cwd: activeCwd,
      provider: table.provider,
      sources: [paths.project, paths.global].filter((file) => existsSync(file)),
      rows: routerRows(sources.routes, table.provider, pools),
      shadowed: routerRows(sources.shadowed, table.provider, pools),
      pools,
      errors: [...sources.errors, ...configErrors],
    };
  };

  /** Re-read the files and make the registered virtual models match them. */
  const reloadRoutes = (ctx: ExtensionContext): void => {
    loadConfig(ctx.cwd ?? activeCwd);
    syncRoutes();
    updateSidebar();
  };

  /**
   * Apply one editor action.
   *
   * The editor never touches disk: this is the single path from a keypress to a
   * written route, and it is the same writer and reload `/router reload` uses.
   */
  const applyRouterAction = (action: RouterAction, ctx: ExtensionCommandContext): string => {
    const paths = routePaths();
    const file = pathForFile(action.file);
    if (action.kind === "delete") {
      if (!removeRoute(file, action.name)) throw new Error(`router/${action.name} is not in ${file}.`);
      const revived = action.file === "project"
        && readRouteDoc(paths.global, "global").routes.some((entry) => entry.route.name === action.name);
      reloadRoutes(ctx);
      return `Removed router/${action.name} from ${file}.${revived ? " The global route with that name is active again." : ""}`;
    }
    if (action.kind === "rename") {
      saveRoute(file, action.route);
      if (action.from !== action.route.name) removeRoute(file, action.from);
      reloadRoutes(ctx);
      return `Renamed router/${action.from} to router/${action.route.name}.`;
    }
    saveRoute(file, action.route);
    reloadRoutes(ctx);
    return `Saved router/${action.route.name} in ${file}.`;
  };

  /**
   * Models a route may target, from the live registry rather than the config.
   *
   * `getAvailable()` is the set `/models` lists — models whose provider has
   * working credentials — so the picker cannot offer a target that would fail
   * on its first request. The catalog facts travel with each choice so the
   * decision is made with the same information `/models` shows.
   */
  const routeModelChoices = (ctx: ExtensionCommandContext) => {
    const registry = ctx.modelRegistry;
    const models = typeof registry?.getAvailable === "function"
      ? registry.getAvailable()
      : typeof registry?.getAll === "function" ? registry.getAll() : [];
    return routerModelChoices(
      models.map((model) => ({
        provider: model.provider,
        id: model.id,
        ...(model.name ? { name: model.name } : {}),
        ...(model.type ? { type: model.type } : {}),
        ...(model.api ? { api: model.api } : {}),
        ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
        ...(typeof model.maxTokens === "number" ? { maxTokens: model.maxTokens } : {}),
        ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
        ...(Array.isArray(model.input) ? { input: model.input as readonly string[] } : {}),
      })),
      { excludeProviders: [table.provider] },
    );
  };

  /**
   * Pick models for a draft and write it.
   *
   * Returns false when the picker was cancelled or produced nothing usable, so
   * the caller closes instead of reopening: a route with no targets is never
   * written, which is what makes Escape safe at this point.
   */
  const pickModelsForDraft = async (draft: RouterDraft, ctx: ExtensionCommandContext): Promise<boolean> => {
    let selection;
    try {
      selection = await providerModelPicker(ctx, routeModelChoices(ctx), draft.route.targets.map((target) => target.model));
    } catch (error) {
      emit(ctx, `Model picker failed: ${errorMessage(error)}`, "error");
      return false;
    }
    if (!selection) return false;
    let models = "ids" in selection ? selection.ids : [];
    if ("manual" in selection && selection.manual) {
      const typed = (await ctx.ui.input("Model id", "provider/model, for a model the catalog does not list yet")) ?? "";
      const parsed = parseModelRef(typed.trim());
      if (!parsed) {
        emit(ctx, `"${typed.trim()}" is not provider/model; nothing was saved.`, "warning");
        return false;
      }
      models = [`${parsed.provider}/${parsed.modelId}`];
    }
    const targets = mergeTargets(draft.route.targets, models);
    if (!targets.length) {
      emit(ctx, "No models chosen; nothing was saved.", "warning");
      return false;
    }
    const route: RouteConfig = { ...draft.route, targets };
    const file = pathForFile(draft.file);
    saveRoute(file, route);
    reloadRoutes(ctx);
    emit(ctx, `Saved router/${route.name} with ${targets.length} model${targets.length === 1 ? "" : "s"} in ${file}.`);
    return true;
  };

  /**
   * The editor loop.
   *
   * The picker is its own overlay, so it cannot live inside the popup: an
   * `add models` answer closes the editor, the picker runs, and the editor
   * reopens on the re-read table. Cancelling the picker ends the loop with the
   * config untouched.
   */
  const openRouterSettings = async (ctx: ExtensionCommandContext): Promise<void> => {
    for (;;) {
      const result = await ctx.ui.custom<RouterPopupResult>((tui, theme, _keys, done) => new RouterSettingsPopup({
        view: routerView,
        apply: (action) => applyRouterAction(action, ctx),
        theme,
        terminalRows: () => tui.terminal.rows,
        onDone: done,
      }), { overlay: true, overlayOptions: popupOverlayOptions("86%", 56, "90%") as never });
      if (!result || result.kind !== "pick-models") return;
      if (!await pickModelsForDraft(result.draft, ctx)) return;
    }
  };

  pi.registerCommand(COMMAND, {
    description: "Account router: status, accounts, use, reset, reload",
    handler: async (args, ctx) => {
      const input = (args ?? "").trim();
      const [verb, ...rest] = input.split(/\s+/).filter(Boolean);
      const arg = rest.join(" ");
      switch (verb) {
        case undefined:
          // Bare `/router` in the TUI is the editor; the text report stays
          // available as `status` for RPC, print mode and copy-paste.
          if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
            await openRouterSettings(ctx);
            return;
          }
          emit(ctx, formatStatus());
          return;
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
            "  /router                    edit routes (TUI), or the status report",
            "  /router status             routes, policies and pools as text",
            "  /router accounts [pool]    per-account health",
            "  /router use <pool> <id>    pin a pool to one account",
            "  /router reset [pool]       clear health and pins",
            "  /router reload             re-read config files",
            "",
            "Config (global ~/.pi/agent/account-router.json or project .pi/account-router.json):",
            '  "routes": [{ "name": "auto", "targets": ["openrouter/meta/llama-3", "openai/gpt-5"] }]',
            '  "pools":  { "or": { "provider": "openrouter", "strategy": "round-robin",',
            '                      "accounts": [{ "id": "acc-1", "apiKey": "$KEY_1" }] } }',
            "",
            "Strategies: round-robin, least-recently-used, priority, sticky.",
            "Route methods: priority (declaration order), round-robin, cheapest, last-good.",
            "Route triggers: turn, failure, quota (only a 429 retry moves on), overflow.",
            "A route target is any physical provider/model; pick one in /router or type it.",
            "Sources: static (per-account apiKey in config or models.json).",
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
          delete health.authFailed;
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
          loadConfig(ctx.cwd ?? activeCwd);
          registerPools(ctx);
          syncRoutes();
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
