import type { DialogAction, DialogWebView } from "../../web/core/plugin-contracts/view.ts";
import { PROVIDERS_MANAGE_ACTION } from "../../web/plugins/providers/contract.ts";
import type { DiscoveredModel } from "./provider-discovery.ts";
import {
  findProviderAccounts, parseProviderSlot, putModel,
  type JsonObject, type ModelsConfig, type ProviderConfig,
} from "./provider-config.ts";

/**
 * The web port of the TUI's model-discovery picker.
 *
 * The TUI picker owns the screen, so it can track ticks locally. The web
 * picker is a published dialog: every tick is an action round-trip and the
 * selection lives in the publishing extension, which republishes the list
 * with the rows' `selected` state. Unticking never removes a model — removal
 * is the separate "Remove model" screen — so a search filter cannot destroy
 * data.
 */

export const DISCOVERY_ROW_CAP = 200;

export interface DiscoveryState {
  providerId: string;
  models: DiscoveredModel[];
  selected: Set<string>;
  filter: string;
}

function action(label: string, options: Partial<DialogAction> = {}): DialogAction {
  return { id: PROVIDERS_MANAGE_ACTION, label, ...options };
}

/** One or more whitespace-separated terms, each a substring of id or name. */
export function matchingModels(state: DiscoveryState): DiscoveredModel[] {
  const terms = state.filter.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return state.models;
  return state.models.filter((model) => {
    const haystack = `${model.id} ${model.name ?? ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function toggleModel(state: DiscoveryState, modelId: string): DiscoveryState {
  const selected = new Set(state.selected);
  if (selected.has(modelId)) selected.delete(modelId);
  else selected.add(modelId);
  return { ...state, selected };
}

/** The catalog facts the TUI picker prints next to each model. */
function modelDetail(model: DiscoveredModel): string | undefined {
  const parts = [
    model.name,
    model.contextWindow !== undefined ? `${model.contextWindow} context` : undefined,
    model.maxTokens !== undefined ? `${model.maxTokens} output` : undefined,
    model.reasoning === true ? "thinking" : undefined,
    model.input?.includes("image") === true ? "images" : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length ? parts.join(" · ") : undefined;
}

/** Shown while the fetch runs, so the pane never looks frozen for five seconds. */
export function discoveringView(providerId: string): DialogWebView {
  return {
    type: "dialog", id: "provider-manager:discovering", title: "Select models",
    lines: [`Fetching ${providerId}'s model list (up to 5 seconds)…`],
    actions: [action("Back to provider")],
  };
}

/**
 * A discovery refusal must carry the same guidance the TUI prints: only
 * deliberately non-sensitive reasons arrive here, everything else collapses
 * to one safe sentence.
 */
export function discoveryFailedView(providerId: string, reason: string): DialogWebView {
  return {
    type: "dialog", id: "provider-manager:discovery-failed", title: "Select models",
    lines: [
      `${reason}`,
      `Enter the model ID manually, or save setup and use /login ${providerId}, then retry discovery.`,
    ],
    actions: [action("Retry discovery"), action("Enter model ID manually"), action("Back to provider")],
  };
}

export function discoveryPickerView(state: DiscoveryState, options: { problem?: string } = {}): DialogWebView {
  const matching = matchingModels(state);
  const shown = matching.slice(0, DISCOVERY_ROW_CAP);
  return {
    type: "dialog", id: "provider-manager:pick-models", title: "Select models",
    lines: [
      `${state.filter.trim() === "" ? "" : `Filter: ${state.filter.trim()} · `}${state.selected.size} selected · ${matching.length}/${state.models.length} matching`,
      "Saving adds or updates the ticked models; unticked models are kept.",
      ...(matching.length > shown.length ? [`Showing the first ${DISCOVERY_ROW_CAP}; narrow the filter to see the rest.`] : []),
      ...(options.problem !== undefined ? [`Problem: ${options.problem}`] : []),
    ],
    input: { placeholder: "Filter by model id or name" },
    items: shown.map((model) => ({
      id: model.id,
      label: model.id,
      ...(modelDetail(model) !== undefined ? { detail: modelDetail(model)! } : {}),
      actionId: PROVIDERS_MANAGE_ACTION,
      values: { modelId: model.id },
      // The host renders the tick control; a `[x]` in the label would be text
      // a screen reader reads out and a style cannot reach.
      selected: state.selected.has(model.id),
    })),
    actions: [
      action(`Save selected models (${state.selected.size})`, { tone: "primary" }),
      // The only submitsInput action: the search box's Enter carries its text
      // as this action's confirm, which the controller reads as the filter.
      action("Apply filter", { submitsInput: true }),
      action("Select all matching"),
      action("Clear selection"),
      action("Enter model ID manually"),
      action("Back to provider"),
    ],
  };
}

/** The same defaults the TUI's fetched-model path applies, without its dialogs. */
export function applyDiscoveredModels(
  provider: ProviderConfig,
  models: DiscoveredModel[],
): { provider: ProviderConfig; defaulted: string[] } {
  let next = provider;
  const defaulted: string[] = [];
  for (const fetched of models) {
    const base = next.models?.find((entry) => entry.id === fetched.id);
    const overrides = next.modelOverrides as Record<string, JsonObject> | undefined;
    const existing = { ...base, ...overrides?.[fetched.id] };
    const isLimit = (value: unknown): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value > 0;
    const contextWindow = fetched.contextWindow ?? (isLimit(existing.contextWindow) ? existing.contextWindow : undefined);
    if (contextWindow === undefined) defaulted.push(fetched.id);
    const window = contextWindow ?? 128000;
    const maxTokens = fetched.maxTokens !== undefined && fetched.maxTokens <= window ? fetched.maxTokens
      : isLimit(existing.maxTokens) && (existing.maxTokens ?? 0) <= window ? existing.maxTokens
        : Math.min(8192, window);
    next = putModel(next, {
      id: fetched.id,
      name: fetched.name ?? (typeof existing.name === "string" ? existing.name : fetched.id),
      contextWindow: window,
      maxTokens,
      reasoning: fetched.reasoning ?? existing.reasoning === true,
      input: fetched.input ?? (Array.isArray(existing.input) ? existing.input : ["text"]),
      cost: base?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  }
  return { provider: next, defaulted };
}

/** Sibling accounts that a saved model list can be copied to, TUI-style. */
export function siblingAccounts(providers: Record<string, ProviderConfig>, id: string): string[] {
  const slot = parseProviderSlot(id);
  if (!slot) return [];
  return findProviderAccounts(providers, slot.base)
    .filter((account) => account.id !== id)
    .map((account) => account.id);
}

export function syncOfferView(providerId: string, siblings: string[], modelCount: number): DialogWebView {
  return {
    type: "dialog", id: "provider-manager:sync-offer", title: "Sync models?",
    lines: [
      `Saved ${modelCount} model${modelCount === 1 ? "" : "s"} to ${providerId}.`,
      `Copy them to the other accounts in this family (${siblings.join(", ")})?`,
      "Each account keeps its own key; only the model list is copied.",
    ],
    actions: [action("Copy to all accounts", { tone: "primary" }), action("Keep only this account")],
  };
}

/** Copy the saved model list to siblings without touching their credentials. */
export function syncModelsToSiblings(config: ModelsConfig, id: string): ModelsConfig {
  const source = config.providers[id];
  if (source === undefined) return config;
  const next = structuredClone(config);
  for (const sibling of siblingAccounts(next.providers, id)) {
    next.providers[sibling] = {
      ...next.providers[sibling],
      models: structuredClone(source.models),
      ...(source.modelOverrides ? { modelOverrides: structuredClone(source.modelOverrides) } : {}),
    };
  }
  return next;
}
