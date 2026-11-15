import type { DialogAction, DialogWebView } from "../../web/core/plugin-contracts/view.ts";
import { PROVIDERS_MANAGE_ACTION } from "../../web/plugins/providers/contract.ts";
import { parseProviderSlot, type ModelsConfig, type ProviderConfig } from "./provider-config.ts";
import {
  accountPlan, draftProblem, draftSteps, draftToProvider, modelRows, providerToDraft, withAccount,
  type ProviderDraft,
} from "./provider-settings.ts";

export type ManagerScreen = "detail" | "edit" | "clone" | "remove" | "pick-model" | "remove-model" | "trust" | "pick-models" | "sync";
export interface ProviderManagerState {
  id: string;
  screen: ManagerScreen;
  modelId?: string;
}
export interface ManagerAuth {
  configured: boolean;
  source?: string;
  registered: boolean;
}

export function providerAccountPlan(providers: Record<string, ProviderConfig>, id: string) {
  return accountPlan(providers, parseProviderSlot(id)?.base ?? id);
}

function action(label: string, options: Partial<DialogAction> = {}): DialogAction {
  return { id: PROVIDERS_MANAGE_ACTION, label, ...options };
}

function editorFields(draft: ProviderDraft, screen: ManagerScreen): NonNullable<DialogWebView["fields"]> {
  const steps = draftSteps(draft, true).filter((step) => screen === "clone"
    ? step.key === "name" || step.key === "apiKey" : step.key !== "id");
  return steps.map((step) => ({
    name: step.key,
    label: step.title,
    ...(step.masked ? { kind: "secret" as const } : { value: step.value }),
    ...(step.choices !== undefined ? { kind: "select" as const, choices: [...step.choices] } : {}),
    help: step.key === "apiKey"
      ? screen === "clone" ? "Required: a new key or $NAME environment reference. The original account key is never inherited." : "Blank keeps existing authentication. Stored keys are never shown."
      : step.help,
    required: step.key === "apiKey" ? screen === "clone" : step.key !== "name",
  }));
}

function detailView(state: ProviderManagerState, provider: ProviderConfig): Partial<DialogWebView> {
  return {
    lines: [
      `ID: ${state.id}`,
      `Protocol: ${provider.api ?? "inherited"}`,
      `Endpoint: ${provider.baseUrl ?? "inherited"}`,
      `Authentication: ${provider.apiKey === undefined ? "inherited" : "configured (hidden)"}`,
    ],
    items: modelRows(provider).map((model) => ({
      id: model.id, label: model.name, detail: `${model.id} · ${model.contextWindow ?? "?"} context tokens`,
      actionId: PROVIDERS_MANAGE_ACTION, values: { modelId: model.id },
    })),
    actions: [
      action("Edit connection"), action("Add/update model"), action("Clone with a new key"),
      action("Remove model"), action("Remove provider", { tone: "danger" }), action("Back to providers"),
    ],
  };
}

/** Every management screen remains a plugin view; the host knows no provider operations. */
export function providerManagerView(options: {
  state: ProviderManagerState;
  providers: Record<string, ProviderConfig>;
  problem?: string;
  notice?: string;
}): DialogWebView {
  const { state, providers } = options;
  const provider = providers[state.id] ?? {};
  const body = managerBody(state, providers);
  return {
    type: "dialog", id: `provider-manager:${state.screen}`, title: typeof provider.name === "string" ? provider.name : state.id,
    ...body,
    lines: [...(body.lines ?? []), ...(options.notice ? [options.notice] : []), ...(options.problem ? [`Problem: ${options.problem}`] : [])],
  };
}

function managerBody(state: ProviderManagerState, providers: Record<string, ProviderConfig>): Partial<DialogWebView> {
  const provider = providers[state.id] ?? {};
  const back = action("Back to provider");
  // The discovery picker and the sync offer publish their own views; reaching
  // this renderer means the state moved on, so show the provider again.
  if (state.screen === "pick-models" || state.screen === "sync") return detailView(state, provider);
  if (state.screen === "detail") return detailView(state, provider);
  if (state.screen === "edit" || state.screen === "clone") {
    const plan = state.screen === "clone" ? providerAccountPlan(providers, state.id) : undefined;
    const draft = plan?.draft ?? providerToDraft(state.id, provider);
    return {
      lines: plan ? [`New account: ${draft.id}`, ...(plan.migration ? [`${plan.migration.from} will become ${plan.migration.to}.`] : []), "The clone inherits models, but must use its own key."] : ["Edit connection; fields not shown here are preserved."],
      fields: editorFields(draft, state.screen),
      actions: [action(state.screen === "clone" ? "Save new account" : "Save connection", { tone: "primary", submitsInput: true }), back],
    };
  }
  if (state.screen === "pick-model") return {
    lines: ["Choose a configured model to remove."],
    fields: [{ name: "modelId", label: "Model", kind: "select", choices: modelRows(provider).map((model) => model.id), required: true }],
    actions: [action("Review removal", { submitsInput: true }), back],
  };
  if (state.screen === "trust") return { lines: ["The endpoint change was not saved. Go back to review it."], actions: [back] };
  const removal = state.screen === "remove-model";
  return {
    lines: [removal ? `Remove ${state.modelId} and its override from ${state.id}?` : `Remove ${state.id} from models.json?`, "Built-in providers and /login credentials are unchanged."],
    actions: [action(removal ? "Remove model configuration" : "Remove configuration", { tone: "danger" }), back],
  };
}

/** Authentication overrides and custom headers must not silently defeat an edit. */
function authenticationProblem(options: { auth: ManagerAuth; current?: ProviderConfig; changing: boolean }): string | undefined {
  if (!options.changing) return undefined;
  if (options.auth.source === "stored" || options.auth.source === "runtime") return `Existing ${options.auth.source} credentials override this key. Use /logout or a unique provider ID.`;
  if (options.auth.registered) return "A provider extension owns this ID. Configure that extension or use a unique ID.";
  const current = options.current;
  if (current?.headers || current?.models?.some((model) => model.headers)
    || Object.values(current?.modelOverrides ?? {}).some((model) => model?.headers)) return "Custom headers may override this key. Keep existing authentication or review models.json first.";
  return undefined;
}

export type ProviderEditResult = { ok: true; config: ModelsConfig; id: string; trust?: { from: string; to: string } } | { ok: false; problem: string };

/** Build an edit against the opening snapshot, never a silently refreshed file. */
export function providerEdit(options: {
  state: ProviderManagerState;
  config: ModelsConfig;
  values: Record<string, string>;
  auth: ManagerAuth;
}): ProviderEditResult {
  const { state, config, values, auth } = options;
  const current = config.providers[state.id];
  if (current === undefined) return { ok: false, problem: "Provider is no longer configured." };
  const plan = state.screen === "clone" ? providerAccountPlan(config.providers, state.id) : undefined;
  if (state.screen === "clone" && plan === undefined) return { ok: false, problem: "The provider family is no longer configured." };
  const initial = plan?.draft ?? providerToDraft(state.id, current);
  const template = plan ? config.providers[plan.templateId] : current;
  const draft = { ...initial, name: values.name ?? initial.name, api: values.api ?? initial.api, baseUrl: values.baseUrl ?? initial.baseUrl, apiKey: values.apiKey ?? "" };
  const problem = draftProblem(draft, { existingIds: Object.keys(config.providers), editingId: plan ? undefined : state.id })
    ?? (plan && !draft.apiKey.trim() ? "A clone needs its own API key or environment reference." : undefined)
    ?? authenticationProblem({ auth, ...(template !== undefined ? { current: template } : {}), changing: !!draft.apiKey.trim() });
  if (problem) return { ok: false, problem };
  const provider = draftToProvider(draft, template, plan ? { inheritAuth: false } : {});
  const next = structuredClone(config);
  next.providers = plan ? withAccount(next.providers, plan, provider) : { ...next.providers, [state.id]: provider };
  const trust = !plan && provider.baseUrl !== current.baseUrl && (auth.configured || current.apiKey !== undefined || current.headers !== undefined)
    ? { from: String(current.baseUrl ?? "inherited endpoint"), to: String(provider.baseUrl) } : undefined;
  return { ok: true, config: next, id: draft.id, ...(trust ? { trust } : {}) };
}
