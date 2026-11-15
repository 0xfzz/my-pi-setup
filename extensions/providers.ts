import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  endpoint, environmentKey, findProviderAccounts, listProviderFamilies, nextProviderSlot, parseProviderSlot,
  positiveInteger, providerId, putModel, readConfig, saveConfig,
  type ConfigSnapshot, type JsonObject, type ModelsConfig, type ProviderConfig,
} from "../lib/provider/provider-config.ts";

import { discoverModelDetails, discoveryAuth, DiscoveryError, modelsEndpoint, type DiscoveredModel } from "../lib/provider/provider-discovery.ts";import { providerKeyInput } from "../lib/provider/provider-key-input.ts";
import { providerModelPicker } from "../lib/provider/provider-model-picker.ts";
import { accountPlan, apiKeyFromInput, draftToProvider, withAccount, withoutModel } from "../lib/provider/provider-settings.ts";
import { overlayRows, popupOverlayOptions } from "../lib/popup/frame.ts";
import { isSubagentChildSession } from "../lib/subagent-context.ts";
import {
  backWizard,
  modelWizard,
  savedView,
  startWizard,
  stepCount,
  submitWizard,
  unreadableFileView,
  wizardResult,
  wizardStep,
  wizardView,
  type WizardState,
} from "../lib/provider/provider-web.ts";
import {
  PROVIDERS_ADD_ACTION,
  PROVIDERS_BACK_ACTION,
  PROVIDERS_CANCEL_ACTION,
  PROVIDERS_FIELD,
  PROVIDERS_NEXT_ACTION,
  PROVIDERS_MANAGE_ACTION,
  PROVIDERS_PLUGIN_ID,
  PROVIDERS_WEB_COMMAND,
} from "../web/plugins/providers/contract.ts";
import { ProviderWebManager } from "../lib/provider/provider-web-controller.ts";
import { WEB_PLUGIN_ACTION_REQUEST_EVENT, type ActionRequestPayload } from "../web/core/plugin-contracts/actions.ts";
import { WEB_MODELS_CHANGED_EVENT } from "../web/core/plugin-contracts/ui-event-models.ts";
import { publishWebView } from "../web/core/plugin-contracts/publisher.ts";
import {
  WEB_PLUGIN_COMMANDS_EVENT,
  WEB_PLUGIN_WEB_COMMAND_EVENT,
  webCommandRequest,
} from "../web/core/plugin-contracts/web-commands.ts";
import { WEB_PLUGIN_UI_SYNC_EVENT } from "../web/core/plugin-contracts/ui-event-models.ts";
import {
  ProviderSettingsPopup,
  type ProviderAction,
  type ProviderPopupResult,
} from "../lib/ui/provider-settings.ts";

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

  const resolved = apiKeyFromInput(key, ctx.mode === "rpc");
  if ("problem" in resolved) throw new Error(resolved.problem);
  return { name, apiKey: key ? resolved.apiKey : "pi-local" };
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
    // Blank is a local server; anything else is escaped exactly as the editor
    // escapes it, so both paths write the same thing for the same answer.
    const resolved = apiKeyFromInput(key, ctx.mode === "rpc");
    if ("problem" in resolved) throw new Error(resolved.problem);
    provider.apiKey = key ? resolved.apiKey : "pi-local";
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

/** Fetch or define models for one provider, then offer to copy them to its family. */
async function addModels(ctx: ExtensionCommandContext, config: ModelsConfig, id: string): Promise<void> {
  const provider = config.providers[id];
  if (!provider) throw new Error(`${id} is not configured.`);
  config.providers[id] = await modelDialog(ctx, id, provider);
  const slot = parseProviderSlot(id);
  if (!slot) return;
  const siblings = findProviderAccounts(config.providers, slot.base).filter(account => account.id !== id);
  if (!siblings.length || !await ctx.ui.confirm("Sync models to other accounts?",
    `Copy updated models from ${id} to other accounts in the "${slot.base}" family (${siblings.map(sibling => sibling.id).join(", ")})?`)) return;
  const updated = config.providers[id]!;
  for (const sibling of siblings) {
    config.providers[sibling.id] = {
      ...config.providers[sibling.id],
      models: structuredClone(updated.models),
      ...(updated.modelOverrides ? { modelOverrides: structuredClone(updated.modelOverrides) } : {}),
    };
  }
}

const modelsFile = (): string => join(getAgentDir(), "models.json");

/** Write the file and make Pi load it; the editor's single write path. */
async function commitConfig(ctx: ExtensionContext, snapshot: ConfigSnapshot, config: ModelsConfig): Promise<void> {
  if (!ctx.isIdle()) throw new Error("Pi became busy while the editor was open; nothing was saved. Retry when idle.");
  await saveConfig(snapshot, config);
  // Reload native configuration, not a competing extension-owned provider registry.
  await ctx.modelRegistry.refresh({ allowNetwork: false });
  if (ctx.modelRegistry.getError()) {
    throw new Error("models.json was saved, but Pi could not reload it. Fix the configuration, then restart Pi or reopen /model.");
  }
}

/** Read for the editor without hiding a broken file: the popup shows the problem. */
async function readForEditor(path: string): Promise<{ snapshot?: ConfigSnapshot; errors: string[] }> {
  try {
    return { snapshot: await readConfig(path), errors: [] };
  } catch (error) {
    return { errors: [(error as Error).message] };
  }
}

/**
 * Apply one editor action.
 *
 * Every action starts from a fresh read: the file may have been edited by hand
 * while the popup was open, and `saveConfig` compares the snapshot it is handed
 * with what is on disk instead of overwriting a change it never saw.
 */
async function applyEditorAction(ctx: ExtensionCommandContext, path: string, action: ProviderAction): Promise<string> {
  const snapshot = await readConfig(path);
  const config = structuredClone(snapshot.config);
  if (action.kind === "delete") {
    if (!config.providers[action.id]) return `${action.id} is no longer in models.json.`;
    delete config.providers[action.id];
    await commitConfig(ctx, snapshot, config);
    return `Removed ${action.id} from models.json. Built-in providers and /login credentials are unchanged.`;
  }
  if (action.kind === "remove-model") {
    const provider = config.providers[action.id];
    if (!provider) return `${action.id} is no longer in models.json.`;
    config.providers[action.id] = withoutModel(provider, action.modelId);
    await commitConfig(ctx, snapshot, config);
    return `Removed ${action.modelId} from ${action.id}.`;
  }
  if (action.kind === "add-models") {
    if (!config.providers[action.id]) return `${action.id} is no longer in models.json.`;
    await addModels(ctx, config, action.id);
    await commitConfig(ctx, snapshot, config);
    return `Saved models for ${action.id}. Use /model to choose one.`;
  }
  const draft = action.draft;
  const plan = draft.accountOf ? accountPlan(snapshot.config.providers, draft.accountOf) : undefined;
  if (draft.accountOf && !plan) return `${draft.accountOf} is no longer in models.json.`;
  const existing = snapshot.config.providers[draft.id];
  // An account inherits its family's models, headers and flags, but never its
  // credential: two accounts sharing a key would bill the same account twice.
  const template = plan ? snapshot.config.providers[plan.templateId] : existing;
  const provider = draftToProvider(draft, template, plan ? { inheritAuth: false } : {});
  await trustEndpoint(ctx, draft.id, provider, existing);
  config.providers = plan ? withAccount(config.providers, plan, provider) : { ...config.providers, [draft.id]: provider };
  await commitConfig(ctx, snapshot, config);
  if (plan?.migration) return `Saved ${draft.id}. ${plan.migration.from} is now ${plan.migration.to} and keeps its models.`;
  if (existing) return `Saved ${draft.id}.`;
  return `Saved ${draft.id}. It has no models yet — add models to make it selectable in /model.`;
}

/**
 * The editor loop.
 *
 * The popup reports actions instead of performing them, so the dialogs an
 * action needs — endpoint trust, model discovery and its picker — can run
 * between two popup instances. Cancelling one of them reopens the editor with
 * a notice, because the provider is still worth editing.
 */
async function openEditor(ctx: ExtensionCommandContext): Promise<void> {
  const path = modelsFile();
  let notice: string | undefined;
  let focus: string | undefined;
  for (;;) {
    const { snapshot, errors } = await readForEditor(path);
    const known = [...new Set(ctx.modelRegistry.getAll().map(model => model.provider))];
    const result = await ctx.ui.custom<ProviderPopupResult>((tui, theme, _keys, done) => new ProviderSettingsPopup({
      view: () => ({ path: snapshot?.path ?? path, providers: snapshot?.config.providers ?? {}, errors, known }),
      theme,
      terminalRows: () => overlayRows(tui.terminal.rows, 92),
      notice,
      startAt: focus,
      onDone: done,
    }), { overlay: true, overlayOptions: popupOverlayOptions("86%", 56, "92%") as never });
    notice = undefined;
    focus = undefined;
    if (!result || result.kind === "close") return;
    if (!snapshot) {
      notice = errors[0] ?? "models.json could not be read.";
      continue;
    }
    focus = result.kind === "save" ? result.draft.id : result.kind === "add-models" ? result.id : undefined;
    try {
      notice = await applyEditorAction(ctx, path, result);
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error;
      notice = "Cancelled; nothing was saved.";
    }
  }
}

/**
 * The web surface: the same wizard, one dialog step at a time.
 *
 * The TUI popup owns its draft because it owns the screen. The web has no such
 * owner — every step is a dialog the extension publishes and every answer comes
 * back through the action pipeline — so the draft lives here, between two
 * dialogs, and the extension is what advances it. The plugin id, the command
 * name and the action ids come from the plugin's contract
 * (web/plugins/providers/contract.ts): that descriptor is what lets the host
 * relay these actions at all.
 */

export default function providers(pi: ExtensionAPI) {
  let active = false;

  // ---- web wizard ---------------------------------------------------------

  /** The draft in flight on the web, and the context that will save it. */
  let webWizard: WizardState | null = null;
  let webContext: ExtensionContext | null = null;
  let webProblem: string | undefined;
  let webReturnToProvider: string | null = null;
  let webOpeningSnapshot: ConfigSnapshot | null = null;

  const closeWebWizard = (): void => {
    webWizard = null;
    webProblem = undefined;
    webReturnToProvider = null;
    webOpeningSnapshot = null;
    manager.reset();
    publishWebView(pi, PROVIDERS_PLUGIN_ID, { type: "dialog", open: false });
  };

  const showWizardProblem = (config: ModelsConfig, problem: string): void => {
    if (webWizard === null) return;
    webProblem = problem;
    publishWebView(pi, PROVIDERS_PLUGIN_ID, wizardView(webWizard, config.providers, { problem }));
  };

  /** Publish the current step; a step is a dialog id, so the form resets per step. */
  const publishWizard = (config: ModelsConfig): void => {
    if (webWizard === null) return;
    const options = webProblem === undefined ? {} : { problem: webProblem };
    publishWebView(pi, PROVIDERS_PLUGIN_ID, wizardView(webWizard, config.providers, options));
  };

  /** Read the file the wizard will write, or report why it cannot. */
  const readWizardConfig = async (): Promise<ConfigSnapshot | undefined> => {
    try {
      return await readConfig(modelsFile());
    } catch (error) {
      webWizard = null;
      publishWebView(pi, PROVIDERS_PLUGIN_ID, unreadableFileView((error as Error).message));
      return undefined;
    }
  };

  const startWebWizard = async (ctx: ExtensionContext): Promise<void> => {
    const snapshot = await readWizardConfig();
    if (snapshot === undefined) return;
    webContext = ctx;
    webProblem = undefined;
    webReturnToProvider = null;
    webOpeningSnapshot = snapshot;
    manager.reset();
    // The plugin's landing page is the configured-provider list. The host
    // supplies only the container; this plugin decides what goes inside it.
    webWizard = startWizard();
    publishWizard(snapshot.config);
  };

  const manager = new ProviderWebManager({
    read: () => readConfig(modelsFile()),
    commit: async (snapshot, config) => {
      if (webContext === null) throw new Error("Session context is gone; reopen Provider.");
      await commitConfig(webContext, snapshot, config);
      pi.events?.emit(WEB_MODELS_CHANGED_EVENT, {});
    },
    auth: (id) => ({
      configured: webContext?.modelRegistry.getProviderAuthStatus(id).configured ?? false,
      source: webContext?.modelRegistry.getProviderAuthStatus(id).source,
      registered: webContext?.modelRegistry.getRegisteredProviderIds().includes(id) ?? false,
    }),
    publish: (view) => publishWebView(pi, PROVIDERS_PLUGIN_ID, view),
    list: async () => { if (webContext !== null) await startWebWizard(webContext); },
    model: (id, modelId) => {
      void readConfig(modelsFile()).then((snapshot) => {
        const provider = snapshot.config.providers[id];
        if (provider === undefined) return;
        webOpeningSnapshot = snapshot;
        webReturnToProvider = id;
        webWizard = modelWizard({ providerId: id, provider, ...(modelId !== undefined ? { modelId } : {}) });
        webProblem = undefined;
        publishWizard(snapshot.config);
      }).catch((error: unknown) => {
        publishWebView(pi, PROVIDERS_PLUGIN_ID, unreadableFileView(error instanceof Error ? error.message : "Cannot read models.json."));
      });
    },
    discover: async (id) => {
      if (process.argv.includes("--offline") || process.env.PI_OFFLINE === "1") {
        throw new DiscoveryError("Discovery is disabled in offline mode.");
      }
      if (webContext === null) throw new DiscoveryError("Session context is gone; reopen Provider.");
      const provider = (await readConfig(modelsFile())).config.providers[id];
      if (provider === undefined) throw new DiscoveryError(`${id} is no longer configured.`);
      // Validate protocol and destination before resolving credentials.
      modelsEndpoint(provider);
      const auth = await discoveryAuth(webContext.modelRegistry, id, provider);
      return discoverModelDetails(provider, auth);
    },
  });

  /** Write the finished draft and tell the bridge to re-read the catalogue. */
  const saveWebWizard = async (snapshot: ConfigSnapshot): Promise<void> => {
    if (webWizard === null) return;
    const ctx = webContext;
    if (ctx === null) {
      showWizardProblem(snapshot.config, "The session context is gone; reopen the picker and retry.");
      return;
    }
    const opening = webOpeningSnapshot ?? snapshot;
    const built = wizardResult(webWizard, opening.config.providers);
    if (!built.ok) {
      showWizardProblem(snapshot.config, built.problem);
      return;
    }
    const config = structuredClone(opening.config);
    config.providers[built.providerId] = built.provider;
    try {
      await commitConfig(ctx, opening, config);
    } catch (error) {
      showWizardProblem(snapshot.config, (error as Error).message);
      return;
    }
    // Both new and updated models invalidate the built-in picker's cache.
    pi.events?.emit(WEB_MODELS_CHANGED_EVENT, {});
    if (webReturnToProvider !== null) {
      const id = webReturnToProvider;
      webWizard = null;
      webReturnToProvider = null;
      webOpeningSnapshot = null;
      await manager.open(id, `Saved model ${built.modelId}.`);
      return;
    }
    closeWebWizard();
    publishWebView(pi, PROVIDERS_PLUGIN_ID, savedView(built.providerId, built.modelId));
  };

  /**
   * Apply one answer. `value` is undefined when the client submitted the
   * step's action without a typed answer — pressing Continue on what is shown
   * means "accept it", which is also what a pre-filled menu step expects.
   */
  const submitWebWizard = async (value: string | undefined): Promise<void> => {
    if (webWizard === null) return;
    const snapshot = await readWizardConfig();
    if (snapshot === undefined) return;
    const answered = value ?? wizardStep(webWizard, snapshot.config.providers).value;
    const result = submitWizard(webWizard, answered, snapshot.config.providers);
    if (!result.ok) {
      showWizardProblem(snapshot.config, result.problem);
      return;
    }
    webProblem = undefined;
    webWizard = result.state;
    if (webWizard.step >= stepCount(webWizard)) {
      await saveWebWizard(snapshot);
      return;
    }
    publishWizard(snapshot.config);
  };

  const addWebProvider = async (): Promise<void> => {
    const snapshot = await readWizardConfig();
    if (snapshot === undefined) return;
    webProblem = undefined;
    webReturnToProvider = null;
    webOpeningSnapshot = snapshot;
    manager.reset();
    webWizard = { ...startWizard({ mode: "new-provider" }), step: 1 };
    publishWizard(snapshot.config);
  };

  const cancelWebWizard = async (): Promise<void> => {
    if (webReturnToProvider !== null) {
      const id = webReturnToProvider;
      webWizard = null;
      webReturnToProvider = null;
      await manager.open(id);
      return;
    }
    if (webWizard === null || webWizard.step === 0) {
      closeWebWizard();
      return;
    }
    const ctx = webContext;
    if (ctx !== null) await startWebWizard(ctx);
  };

  const stepBack = async (): Promise<void> => {
    if (webWizard === null) return;
    if (webReturnToProvider !== null && webWizard.step === 2) {
      await cancelWebWizard();
      return;
    }
    const snapshot = await readWizardConfig();
    if (snapshot === undefined) return;
    webProblem = undefined;
    webWizard = backWizard(webWizard);
    publishWizard(snapshot.config);
  };

  /**
   * The web command the model picker's "+ Add models" entry dispatches.
   *
   * Announced rather than registered in a shared module: pi evaluates each
   * extension with `moduleCache: false`, so the bridge cannot call into this
   * one directly. It announces the descriptor, and runs the command when the
   * bridge asks for it back — with the context captured here, at session
   * start.
   */
  const announceWebCommand = (): void => {
    pi.events?.emit(WEB_PLUGIN_COMMANDS_EVENT, {
      commands: [{
        name: PROVIDERS_WEB_COMMAND,
        description: "Add a provider or a model to models.json (web)",
        managesModels: true,
        // The shared model-settings dialog's sidebar entry for this command.
        settingsEntry: "Provider",
        settingsPlugin: PROVIDERS_PLUGIN_ID,
      }],
    });
  };
  pi.on("session_start", (_event, ctx) => {
    webContext = ctx;
    announceWebCommand();
  });
  // The host asks every producer to re-emit its current values when it
  // attaches a consumer (the same request views answer). The session_start
  // announcement can land before that subscription exists, so repeat it here.
  pi.events?.on(WEB_PLUGIN_UI_SYNC_EVENT, () => {
    announceWebCommand();
  });
  pi.events?.on(WEB_PLUGIN_WEB_COMMAND_EVENT, (payload: unknown) => {
    const request = webCommandRequest(payload);
    if (request === undefined || request.name !== PROVIDERS_WEB_COMMAND) return;
    const ctx = webContext;
    if (ctx === null) return;
    void startWebWizard(ctx);
  });

  pi.events?.on(WEB_PLUGIN_ACTION_REQUEST_EVENT, (data: unknown) => {
    const request = data as Partial<ActionRequestPayload> | undefined;
    if (request?.pluginId !== PROVIDERS_PLUGIN_ID) return;
    const actionId = typeof request.actionId === "string" ? request.actionId : "";
    // Every step is one field named `value`: a form answer, or the label of a
    // menu pick for an older client that only sends `confirm`.
    // The form's answer; a client that only sends `confirm` gets the step's
    // current value (the action label is not an answer).
    const submitted = request.values?.[PROVIDERS_FIELD];
    const value = typeof submitted === "string" ? submitted : undefined;
    if (actionId === PROVIDERS_MANAGE_ACTION) void manager.action(request);
    else if (actionId === PROVIDERS_ADD_ACTION) void addWebProvider();
    else if (actionId === PROVIDERS_NEXT_ACTION) void submitWebWizard(value);
    else if (actionId === PROVIDERS_BACK_ACTION) void stepBack();
    else if (actionId === PROVIDERS_CANCEL_ACTION) void cancelWebWizard();
  });

  // ---- the TUI command ----------------------------------------------------

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
      const typed = args.trim();
      // Bare `/provider` in the TUI is the editor; RPC keeps the dialog menu,
      // because a custom terminal component is not part of that protocol.
      if (!typed && ctx.mode === "tui") {
        await openEditor(ctx);
        return;
      }
      const action = typed || ACTIONS.get(await choose(ctx, "Custom providers", [...ACTIONS.keys()]));
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
          await addModels(ctx, config, id);
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
      description: "Manage custom providers: /provider opens the editor in the TUI, or /provider [add|account|edit|model|remove|list] for dialogs",
      getArgumentCompletions(prefix) {
        const values = [...ACTIONS.values()].filter(value => value.startsWith(prefix));
        return values.length ? values.map(value => ({ value, label: value })) : null;
      },
      handler,
  });
}
