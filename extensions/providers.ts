import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  endpoint, environmentKey, findProviderAccounts, listProviderFamilies, nextProviderSlot, parseProviderSlot,
  positiveInteger, providerId, putModel, readConfig, saveConfig,
  type JsonObject, type ProviderConfig,
} from "../lib/provider-config.ts";

import { discoverModelDetails, discoveryAuth, DiscoveryError, modelsEndpoint, type DiscoveredModel } from "../lib/provider-discovery.ts";
import { providerKeyInput } from "../lib/provider-key-input.ts";
import { providerModelPicker } from "../lib/provider-model-picker.ts";
import { isSubagentChildSession } from "../lib/subagent-context.ts";

const APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];
const ACTIONS = new Map([
  ["Add provider", "add"], ["Add account to provider", "account"], ["Edit connection", "edit"],
  ["Add/update model", "model"], ["Remove provider configuration", "remove"], ["List configured providers", "list"],
]);
class Cancelled extends Error {}

async function choose(ctx: ExtensionCommandContext, title: string, options: string[]): Promise<string> {
  const value = await ctx.ui.select(title, options);
  if (value === undefined) throw new Cancelled();
  if (!options.includes(value)) throw new Error("Invalid dialog selection; nothing was saved.");
  return value;
}

async function input(ctx: ExtensionCommandContext, title: string, fallback?: string,
  validate: (text: string) => unknown = text => { if (!text) throw new Error("A value is required."); }): Promise<string> {
  for (;;) {
    const value = await ctx.ui.input(fallback === undefined ? title : `${title} (blank keeps ${fallback})`, fallback);
    if (value === undefined) throw new Cancelled();
    const text = value.trim() || fallback || "";
    try { validate(text); return text; }
    catch (error) { ctx.ui.notify((error as Error).message, "warning"); }
  }
}

async function accountAuth(
  ctx: ExtensionCommandContext,
  id: string,
  baseName: string,
  slot: number,
): Promise<{ name: string; apiKey?: string }> {
  const defaultName = baseName.includes("Account")
    ? `${baseName.replace(/ \(Account \d+\)$/, "")} (Account ${slot})`
    : `${baseName} (Account ${slot})`;
  const name = await input(ctx, "Account display name", defaultName);
  const keyTitle = `API key for ${id} (blank for a local server; $NAME uses an environment variable)`;
  const key = ctx.mode === "rpc"
    ? await input(ctx, keyTitle.replace("API key", "API key environment variable name"), "", text => { if (text) environmentKey(text); })
    : await providerKeyInput(ctx, keyTitle);
  if (key === undefined) throw new Cancelled();

  let apiKey: string | undefined;
  if (!key) {
    apiKey = "pi-local";
  } else if (ctx.mode === "rpc" || /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(key)) {
    apiKey = environmentKey(key);
  } else {
    const literal = key.replace(/\$/g, () => "$$");
    apiKey = literal.startsWith("!") ? `$!${literal.slice(1)}` : literal;
  }
  return { name, apiKey };
}

async function connection(ctx: ExtensionCommandContext, id: string, current?: ProviderConfig): Promise<ProviderConfig> {
  const name = await input(ctx, "Provider display name", typeof current?.name === "string" ? current.name : id);
  const keyTitle = `API key (${current ? "blank keeps existing authentication" : "blank for a local server"}; $NAME uses an environment variable)`;
  // RPC has no masked terminal component: accept only an environment reference there.
  const key = ctx.mode === "rpc"
    ? await input(ctx, keyTitle.replace("API key", "API key environment variable name"), "", text => { if (text) environmentKey(text); })
    : await providerKeyInput(ctx, keyTitle);
  if (key === undefined) throw new Cancelled();
  const changingAuth = key !== "" || !current;
  const apiOptions = current?.api && typeof current.api === "string" && !APIS.includes(current.api)
    ? [current.api, ...APIS] : APIS;
  const api = await choose(ctx, `API protocol${current?.api ? ` (current: ${current.api})` : ""}`, apiOptions);
  const baseUrl = endpoint(await input(ctx, "Base URL (include /v1 if your server requires it)",
    typeof current?.baseUrl === "string" ? current.baseUrl : undefined, endpoint));
  const status = ctx.modelRegistry.getProviderAuthStatus(id);
  if (changingAuth && (status.source === "stored" || status.source === "runtime")) {
    throw new Error(`${id} has ${status.source} credentials that override this choice. ${status.source === "stored" ? "Use /logout to remove the stored credential" : "Restart Pi without the runtime API-key override"}, or use a new provider ID. Nothing was saved.`);
  }
  if (changingAuth && ctx.modelRegistry.getRegisteredProviderIds().includes(id)) {
    throw new Error(`${id} is owned by a provider extension, which can override this authentication choice. Use a unique provider ID or configure that extension directly. Nothing was saved.`);
  }
  if (changingAuth && (current?.headers ||
    current?.models?.some(model => model.headers) ||
    Object.values((current?.modelOverrides ?? {}) as Record<string, JsonObject>).some(model => model?.headers))) {
    throw new Error(`${id} has custom header settings that this authentication choice does not remove. Use a unique provider ID, keep existing authentication, or review those headers in models.json first. Nothing was saved.`);
  }
  const provider: ProviderConfig = { ...current, name, api, baseUrl };
  if (changingAuth) {
    if (!key) provider.apiKey = "pi-local";
    else if (ctx.mode === "rpc" || /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(key)) {
      provider.apiKey = environmentKey(key);
    } else {
      // Literal keys must not become Pi environment expressions or !commands.
      const literal = key.replace(/\$/g, () => "$$");
      provider.apiKey = literal.startsWith("!") ? `$!${literal.slice(1)}` : literal;
    }
  }
  return provider;
}

async function trustEndpoint(ctx: ExtensionCommandContext, id: string, provider: ProviderConfig, old?: ProviderConfig) {
  const status = ctx.modelRegistry.getProviderAuthStatus(id);
  if (provider.baseUrl !== old?.baseUrl &&
    (status.configured || old?.apiKey !== undefined || old?.headers !== undefined)) {
    if (!await ctx.ui.confirm("Allow authentication at the new endpoint?",
      `Provider: ${id}\nNew endpoint: ${provider.baseUrl}\nCurrent effective authentication source: ${status.source ?? "unresolved"}.\nExisting stored credentials, inherited authentication and custom headers may be sent here, including during model discovery. Continue only if you trust this endpoint. A new provider ID keeps services separate.`)) throw new Cancelled();
  }
}

async function modelIds(ctx: ExtensionCommandContext, providerId: string, provider: ProviderConfig): Promise<DiscoveredModel[] | undefined> {
  let models: DiscoveredModel[] = [];
  try {
    if (process.argv.includes("--offline") || process.env.PI_OFFLINE === "1") {
      throw new DiscoveryError("Discovery is disabled in offline mode.");
    }
    modelsEndpoint(provider); // Validate protocol/destination before resolving credentials.
    ctx.ui.notify("Fetching the provider's model list (up to 5 seconds)…", "info");
    const auth = await discoveryAuth(ctx.modelRegistry, providerId, provider);
    models = await discoverModelDetails(provider, auth);
  } catch (error) {
    // Never display arbitrary errors: servers/auth resolvers can include secrets in them.
    const reason = error instanceof DiscoveryError ? error.message : "The model list could not be fetched.";
    ctx.ui.notify(`${reason} Enter the model ID manually. If login is needed, save setup, use /login ${providerId}, then /provider model to retry discovery.`, "warning");
  }
  if (models.length) {
    const selection = await providerModelPicker(ctx, models);
    if (selection === undefined) throw new Cancelled();
    if ("ids" in selection) {
      if (!selection.ids.length || selection.ids.some(id => !models.some(model => model.id === id))) {
        throw new Error("Invalid model selection; nothing was saved.");
      }
      return models.filter(model => selection.ids.includes(model.id));
    }
  }
  return undefined;
}

async function modelDialog(ctx: ExtensionCommandContext, providerId: string, provider: ProviderConfig): Promise<ProviderConfig> {
  const fetched = await modelIds(ctx, providerId, provider);
  let next = provider;
  for (const model of fetched ?? [undefined]) next = await configureModel(ctx, next, model);
  return next;
}

async function configureModel(ctx: ExtensionCommandContext, provider: ProviderConfig, fetched?: DiscoveredModel): Promise<ProviderConfig> {
  const id = fetched?.id ?? await input(ctx, "Exact model ID exposed by the server");
  const base = provider.models?.find(model => model.id === id);
  const overrides = provider.modelOverrides as Record<string, JsonObject> | undefined;
  const existing = { ...base, ...overrides?.[id] };
  if (fetched) {
    const validLimit = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
    const contextWindow = fetched.contextWindow ?? positiveInteger(await input(ctx,
      `Server did not report a context window for ${id} — enter the limit from its model docs`,
      validLimit(existing.contextWindow) ? String(existing.contextWindow) : undefined, positiveInteger));
    const maxTokens = fetched.maxTokens !== undefined && fetched.maxTokens <= contextWindow ? fetched.maxTokens
      : validLimit(existing.maxTokens) && existing.maxTokens <= contextWindow ? existing.maxTokens : Math.min(8192, contextWindow);
    if (fetched.maxTokens === undefined || fetched.maxTokens > contextWindow) {
      ctx.ui.notify(`Server did not report a usable output limit. Using ${maxTokens} tokens; adjust maxTokens in models.json if needed.`, "info");
    }
    ctx.ui.notify(`Selected ${id}: context ${contextWindow}, maximum output ${maxTokens} tokens.`, "info");
    return putModel(provider, {
      id, name: fetched.name ?? existing.name ?? id, contextWindow, maxTokens,
      reasoning: fetched.reasoning ?? existing.reasoning ?? false,
      input: fetched.input ?? existing.input ?? ["text"],
      cost: base?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  }
  const name = await input(ctx, "Model display name", typeof existing.name === "string" ? existing.name : id);
  const reasoning = await choose(ctx, `Does this model support reasoning/thinking?${typeof existing.reasoning === "boolean" ? ` (current: ${existing.reasoning ? "Yes" : "No"})` : ""}`, ["No", "Yes"]);
  const modality = await choose(ctx, "Supported input", ["Text", "Text + images"]);
  const contextWindow = positiveInteger(await input(ctx, "Context window (tokens; check the server/model docs)",
    String(existing?.contextWindow ?? 128000), positiveInteger));
  const maxTokens = positiveInteger(await input(ctx, "Maximum output tokens", String(existing?.maxTokens ?? 8192), text => {
    if (positiveInteger(text) > contextWindow) throw new Error("Maximum output must not exceed the context window.");
  }));
  const model: JsonObject = {
    id, name, reasoning: reasoning === "Yes", input: modality === "Text" ? ["text"] : ["text", "image"],
    contextWindow, maxTokens,
    cost: base?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  return putModel(provider, model);
}

export default function providers(pi: ExtensionAPI) {
  let active = false;
  const handler = async (args: string, ctx: ExtensionCommandContext) => {
    if (!ctx.hasUI || isSubagentChildSession(ctx)) {
      ctx.ui.notify("/provider needs a main interactive Pi session (or an RPC client supporting dialogs).", "warning");
      return;
    }
    if (active || !ctx.isIdle()) {
      ctx.ui.notify("Finish the active run or provider dialog before changing providers.", "warning");
      return;
    }
    active = true;
    let saved = false;
    try {
      const action = args.trim() || ACTIONS.get(await choose(ctx, "Custom providers", [...ACTIONS.keys()]));
      if (![...ACTIONS.values()].includes(action!)) {
        ctx.ui.notify("Usage: /provider [add|account|edit|model|remove|list]", "info");
        return;
      }
      const snapshot = await readConfig(join(getAgentDir(), "models.json"));
      const config = structuredClone(snapshot.config);
      const ids = Object.keys(config.providers).sort();
      if (action === "list") {
        const families = listProviderFamilies(config.providers);
        const lines: string[] = [];
        for (const [baseId, accounts] of families) {
          if (accounts.length === 1 && accounts[0].id === baseId) {
            const p = accounts[0].provider;
            lines.push(`${p.name ?? baseId} (${baseId}) — ${p.models?.length ?? 0} configured model(s)`);
          } else {
            lines.push(`${baseId} (${accounts.length} account${accounts.length > 1 ? "s" : ""}):`);
            for (const a of accounts) {
              lines.push(`  • ${a.provider.name ?? a.id} (${a.id}) — ${a.provider.models?.length ?? 0} configured model(s)`);
            }
          }
        }
        ctx.ui.notify(lines.length
          ? lines.join("\n") + "\nUse /model for the full catalog, including built-in providers."
          : "No providers configured in models.json. Use /provider add or /provider account.", "info");
        return;
      }
      let id: string;
      let isAccountAction = false;
      let migrationNote = "";
      if (action === "account") {
        isAccountAction = true;
        const families = listProviderFamilies(config.providers);
        let baseId: string;
        if (families.size > 0) {
          const options: string[] = [];
          const optionMap = new Map<string, string>();
          for (const [familyBase, accounts] of families) {
            const label = accounts.length === 1
              ? `${familyBase} (1 configured account: ${accounts[0].id})`
              : `${familyBase} (${accounts.length} configured accounts: ${accounts.map(a => a.id).join(", ")})`;
            options.push(label);
            optionMap.set(label, familyBase);
          }
          const NEW_OPTION = "Add account for another provider ID...";
          options.push(NEW_OPTION);
          const picked = await choose(ctx, "Select provider to add an account for", options);
          if (picked === NEW_OPTION) {
            baseId = providerId(await input(ctx, "Base provider ID (e.g. openrouter or deepseek)"));
          } else {
            baseId = optionMap.get(picked)!;
          }
        } else {
          baseId = providerId(await input(ctx, "Base provider ID (e.g. openrouter or deepseek)"));
        }

        const existingAccounts = findProviderAccounts(config.providers, baseId);
        if (!existingAccounts.length) {
          const newId = `${baseId}-1`;
          if (ctx.modelRegistry.getAll().some(model => model.provider === newId) &&
            !await ctx.ui.confirm("Override an existing provider?", `${newId} already exists in Pi. Continue only if you want to configure this slot.`)) throw new Cancelled();
          const provider = await connection(ctx, newId);
          await trustEndpoint(ctx, newId, provider, snapshot.config.providers[newId]);
          config.providers[newId] = await modelDialog(ctx, newId, provider);
          id = newId;
        } else {
          const template = existingAccounts[0].provider;
          const isMigration = existingAccounts.length === 1 && existingAccounts[0].id === baseId;
          const slot = isMigration ? 2 : nextProviderSlot(config.providers, baseId);
          const newId = `${baseId}-${slot}`;
          const baseName = typeof template.name === "string" ? template.name : baseId;
          const { name, apiKey } = await accountAuth(ctx, newId, baseName, slot);

          const newProvider: ProviderConfig = {
            ...structuredClone(template),
            name,
            apiKey,
          };
          await trustEndpoint(ctx, newId, newProvider, snapshot.config.providers[newId]);

          if (isMigration) {
            const acc1Name = baseName.includes("Account") ? baseName : `${baseName} (Account 1)`;
            config.providers[`${baseId}-1`] = {
              ...template,
              name: acc1Name,
            };
            delete config.providers[baseId];
            migrationNote = `Existing single provider "${baseId}" will be migrated to "${baseId}-1" (Account 1).\n`;
          }

          config.providers[newId] = newProvider;
          id = newId;
        }
      } else if (action === "add") {
        id = providerId(await input(ctx, "Provider ID (e.g. acme or my-ollama)", undefined, text => {
          providerId(text);
          if (Object.hasOwn(config.providers, text)) throw new Error("That provider is already configured. Use Edit connection or Add/update model.");
        }));
        if (ctx.modelRegistry.getAll().some(model => model.provider === id) &&
          !await ctx.ui.confirm("Override an existing provider?", `${id} already exists in Pi. This adds models.json overrides above its built-in/extension settings. Existing stored credentials and headers can be sent to the new endpoint. Prefer a unique ID for a separate service.`)) throw new Cancelled();
        const provider = await connection(ctx, id);
        await trustEndpoint(ctx, id, provider, snapshot.config.providers[id]);
        config.providers[id] = await modelDialog(ctx, id, provider);
      } else {
        if (!ids.length) { ctx.ui.notify("No providers configured yet. Use /provider add.", "info"); return; }
        id = await choose(ctx, "Provider from models.json", ids);
        if (action === "remove") {
          if (!await ctx.ui.confirm(`Remove ${id} configuration?`,
            "Only this models.json entry is removed. Built-in/extension models and stored /login credentials are not deleted. Use /logout separately to remove credentials.")) throw new Cancelled();
          delete config.providers[id];
        } else if (action === "edit") {
          config.providers[id] = await connection(ctx, id, config.providers[id]);
          await trustEndpoint(ctx, id, config.providers[id], snapshot.config.providers[id]);
        } else {
          config.providers[id] = await modelDialog(ctx, id, config.providers[id]);
          const slot = parseProviderSlot(id);
          if (slot) {
            const siblings = findProviderAccounts(config.providers, slot.base).filter(a => a.id !== id);
            if (siblings.length && await ctx.ui.confirm("Sync models to other accounts?",
              `Copy updated models from ${id} to other accounts in the "${slot.base}" family (${siblings.map(s => s.id).join(", ")})?`)) {
              for (const sibling of siblings) {
                config.providers[sibling.id] = {
                  ...config.providers[sibling.id],
                  models: structuredClone(config.providers[id].models),
                  ...(config.providers[id].modelOverrides ? { modelOverrides: structuredClone(config.providers[id].modelOverrides) } : {}),
                };
              }
            }
          }
        }
      }
      if (action !== "remove") {
        const provider = config.providers[id];
        const modelNames = provider.models?.map(model => String(model.id)).join(", ") || "(inherited catalog)";
        if (!await ctx.ui.confirm(`Save provider ${id}?`,
          `Display name: ${provider.name ?? id}\nAPI: ${provider.api ?? "inherited"}\n${action === "add" || action === "edit" || isAccountAction ? `Endpoint: ${provider.baseUrl}\n` : ""}Models: ${modelNames}\nFile: ${snapshot.path}\n\n${migrationNote}Direct API keys are stored in this private (0600) file; environment references are stored without resolving their value.\nStored /login credentials override models.json and environment keys. Use /logout to stop reusing them. Existing credentials and custom headers may be sent to a changed endpoint; verify that you trust it.\nExisting advanced fields and other providers are preserved. New model prices are unknown (zero); edit cost metadata in models.json for accurate billing. Model-level endpoint/API overrides remain in effect.\nModel discovery may have made read-only requests. No inference request is made.`)) throw new Cancelled();
      }
      if (!ctx.isIdle()) throw new Error("Pi became busy while the dialog was open; nothing was saved. Retry when idle.");
      await saveConfig(snapshot, config);
      saved = true;
      // Reload native configuration, not a competing extension-owned provider registry.
      await ctx.modelRegistry.refresh({ allowNetwork: false });
      if (ctx.modelRegistry.getError()) throw new Error("Pi rejected the model configuration.");
      ctx.ui.notify(action === "remove"
        ? `Removed ${id} from models.json. Built-in/extension providers and login credentials remain unchanged.`
        : `Saved ${id}.${migrationNote ? " Migrated base provider to Account 1." : ""} ${config.providers[id].apiKey === undefined ? `Use /login ${id} to enter its key, then ` : "Use "}/model to choose a model. The current model was not changed.`, "info");
    } catch (error) {
      if (error instanceof Cancelled) ctx.ui.notify("Provider setup cancelled; nothing was saved.", "info");
      else if (saved) ctx.ui.notify("models.json was saved, but Pi could not refresh it. Check the configuration, then reopen /model or restart Pi. No automatic retry was made.", "error");
      else ctx.ui.notify(`Provider setup failed: ${(error as Error).message}`, "error");
    } finally { active = false; }
  };
  pi.registerCommand("provider", {
      description: "Manage custom providers and multi-account configurations: /provider [add|account|edit|model|remove|list]",
      getArgumentCompletions(prefix) {
        const values = [...ACTIONS.values()].filter(value => value.startsWith(prefix));
        return values.length ? values.map(value => ({ value, label: value })) : null;
      },
      handler,
  });
}
