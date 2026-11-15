/**
 * The provider wizard as the web drives it: one step at a time.
 *
 * The TUI's `/provider` popup owns its draft because it owns the screen. The
 * web has no such owner — every step is a dialog the extension publishes and
 * every answer comes back through the action pipeline — so the draft has to
 * live in a value the extension can hold between two dialogs. That value, its
 * steps and their validation are pure functions here: the extension supplies
 * the file and the registry, this module decides what the next screen is.
 *
 * The first step is the TUI editor's own home screen — two choices, nothing
 * else: open the list of configured providers, or start a new connection. Both
 * end in the same model steps, because the model picker is the doorway: the
 * question is only whether the model lands on an existing provider or on one
 * being created.
 */
import type { DialogWebView } from "../../web/core/plugin-contracts/view.ts";
import {
  PROVIDERS_ADD_ACTION,
  PROVIDERS_BACK_ACTION,
  PROVIDERS_CANCEL_ACTION,
  PROVIDERS_FIELD,
  PROVIDERS_FILE_DIALOG,
  PROVIDERS_NEXT_ACTION,
  PROVIDERS_MANAGE_ACTION,
  PROVIDERS_SAVED_DIALOG,
  providersDialogId,
} from "../../web/plugins/providers/contract.ts";
import { positiveInteger, putModel, type JsonObject, type ProviderConfig } from "./provider-config.ts";
import {
  draftSteps,
  draftToProvider,
  PROVIDER_APIS,
  stepProblem,
  providerRows,
  type DraftContext,
  type DraftStep,
  type DraftStepKey,
  type ProviderDraft,
} from "./provider-settings.ts";

/** Where the wizard is heading: the home screen decides, the answer sets it. */
export type WizardMode = "home" | "new-provider" | "existing-provider";

/** The home screen's two choices, worded like the TUI editor's menu. */
export const LIST_PROVIDERS_CHOICE = "List available providers";
export const ADD_PROVIDER_CHOICE = "Add a new provider…";

/** The home step's key: always the first step of every mode. */
const HOME_STEP_KEY = "home";

/** The model the wizard adds, as typed text. */
export interface ModelDraft {
  id: string;
  name: string;
  contextWindow: string;
  maxTokens: string;
  reasoning: "No" | "Yes";
  input: "Text" | "Text + images";
}

export interface WizardState {
  mode: WizardMode;
  /** Index into the step list; the list depends on the mode. */
  step: number;
  draft: ProviderDraft;
  /** The provider an existing-model step lands on. */
  providerId: string;
  model: ModelDraft;
}

/** One step of the wizard, as the dialog renders it. */
export interface WizardStep {
  key: string;
  title: string;
  help: string;
  value: string;
  placeholder: string;
  masked: boolean;
  /** A fixed vocabulary: the dialog renders a menu, not a text field. */
  choices?: readonly string[];
  required: boolean;
}

const MODEL_STEP_KEYS = ["modelId", "modelName", "contextWindow", "maxTokens", "reasoning", "input"] as const;
type ModelStepKey = (typeof MODEL_STEP_KEYS)[number];

const PROVIDER_CHOICE_KEY = "providerId";

/** The provider menu's way back to the connection wizard. */
export const NEW_PROVIDER_CHOICE = "+ New provider…";

const DEFAULT_MODEL: ModelDraft = {
  id: "",
  name: "",
  contextWindow: "128000",
  maxTokens: "8192",
  reasoning: "No",
  input: "Text",
};

/** A new wizard starts from the defaults, never from the last draft. */
export function startWizard(options: {
  mode?: WizardMode;
  providerId?: string;
} = {}): WizardState {
  return {
    mode: options.mode ?? "home",
    step: 0,
    draft: { id: "", name: "", api: PROVIDER_APIS[0], baseUrl: "", apiKey: "" },
    providerId: options.providerId ?? "",
    model: { ...DEFAULT_MODEL },
  };
}

/** Existing model metadata pre-fills the same wizard used for new models. */
export function modelWizard(options: { providerId: string; provider: ProviderConfig; modelId?: string }): WizardState {
  const state = { ...startWizard({ mode: "existing-provider", providerId: options.providerId }), step: 2 };
  if (options.modelId === undefined) return state;
  const overrides = options.provider.modelOverrides as Record<string, JsonObject> | undefined;
  const model = { ...options.provider.models?.find((entry) => entry.id === options.modelId), ...overrides?.[options.modelId] };
  return {
    ...state,
    model: {
      id: options.modelId,
      name: typeof model.name === "string" ? model.name : options.modelId,
      contextWindow: String(model.contextWindow ?? 128000),
      maxTokens: String(model.maxTokens ?? 8192),
      reasoning: model.reasoning === true ? "Yes" : "No",
      input: Array.isArray(model.input) && model.input.includes("image") ? "Text + images" : "Text",
    },
  };
}

/**
 * The step keys in order, which is what makes `step` an index.
 *
 * The home step is always first and the model steps are always last, so only
 * the middle changes when the home answer switches the mode — and going back
 * from the first connection or provider step lands on home, not nowhere.
 */
export function stepKeys(state: WizardState): string[] {
  if (state.mode === "home") return [HOME_STEP_KEY];
  const middle = state.mode === "new-provider"
    ? draftSteps(state.draft, false).map((step) => step.key)
    : [PROVIDER_CHOICE_KEY];
  return [HOME_STEP_KEY, ...middle, ...MODEL_STEP_KEYS];
}

export function stepCount(state: WizardState): number {
  return stepKeys(state).length;
}

/** The dialog id for the current step: a new id starts a fresh form. */
export function wizardDialogId(state: WizardState): string {
  return providersDialogId(stepKeys(state)[state.step] ?? "done");
}

/**
 * The step to render.
 *
 * The draft steps are the TUI's own (`draftSteps`), so both frontends ask the
 * same questions in the same order; the model steps and the provider chooser
 * are the web's additions.
 */
export function wizardStep(state: WizardState, providers: Record<string, ProviderConfig>): WizardStep {
  const key = stepKeys(state)[state.step] ?? MODEL_STEP_KEYS[0];
  if (key === HOME_STEP_KEY) return homeStep(providers);
  if (state.mode === "new-provider") {
    const draftStep = draftSteps(state.draft, false).find((step) => step.key === key);
    if (draftStep !== undefined) return draftStepToWizardStep(draftStep);
  }
  if (key === PROVIDER_CHOICE_KEY) return providerChoiceStep(state, providers);
  return modelStep(state, key as ModelStepKey);
}

/** One line above the field: where this step sits in the wizard. */
export function stepPosition(state: WizardState): string {
  return `Step ${state.step + 1} of ${stepCount(state)}`;
}

/** A submitted answer: the next state, or why it was refused. */
export type SubmitResult =
  | { ok: true; state: WizardState }
  | { ok: false; problem: string };

/**
 * Apply one step's answer.
 *
 * A refusal returns the same state so the extension re-publishes the same
 * dialog id — the client keeps the typed text, and the problem appears where
 * the answer was.
 */
export function submitWizard(
  state: WizardState,
  value: string,
  providers: Record<string, ProviderConfig>,
): SubmitResult {
  const key = stepKeys(state)[state.step];
  if (key === undefined) return { ok: false, problem: "The wizard has no current step." };
  const text = value.trim();

  if (key === HOME_STEP_KEY) {
    // The two choices of the TUI editor's home screen. "List" opens the
    // provider menu (with its own "+ New provider…" row); "Add" goes straight
    // to the connection wizard. Either way the model steps follow, because a
    // provider with no model is not selectable in the picker.
    if (text === ADD_PROVIDER_CHOICE) {
      return { ok: true, state: { ...state, mode: "new-provider", step: 1 } };
    }
    if (text !== LIST_PROVIDERS_CHOICE) {
      return { ok: false, problem: `Choose "${LIST_PROVIDERS_CHOICE}" or "${ADD_PROVIDER_CHOICE}".` };
    }
    const first = Object.keys(providers).sort()[0];
    return {
      ok: true,
      state: { ...state, mode: "existing-provider", providerId: first ?? "", step: 1 },
    };
  }
  if (key === PROVIDER_CHOICE_KEY) {
    if (text === NEW_PROVIDER_CHOICE) {
      // Step 1: the connection wizard's first question, same draft. (Step 0
      // is the home screen the wizard already passed through.)
      return { ok: true, state: { ...state, mode: "new-provider", step: 1 } };
    }
    if (providers[text] === undefined) return { ok: false, problem: `${text || "(nothing)"} is not a configured provider.` };
    return { ok: true, state: { ...state, providerId: text, step: state.step + 1 } };
  }
  if (state.mode === "new-provider" && isDraftKey(key)) {
    const problem = stepProblem(key as DraftStepKey, value, draftContext(state, providers));
    if (problem !== undefined) return { ok: false, problem };
    // The masked step is never pre-filled, so a blank answer there means the
    // user walked back over a key already typed: keep it rather than silently
    // turning a keyed provider into a local one.
    const answered = key === "apiKey" && text === "" && state.draft.apiKey !== ""
      ? state.draft.apiKey
      : value;
    const draft: ProviderDraft = { ...state.draft, [key]: answered };
    // A provider named after its id is the common case; typing it twice is not.
    if (key === "id" && draft.name.trim() === "") draft.name = text;
    return { ok: true, state: { ...state, draft, step: state.step + 1 } };
  }
  const applied = submitModelStep(state, key as ModelStepKey, text);
  if ("problem" in applied) return { ok: false, problem: applied.problem };
  return { ok: true, state: { ...state, model: applied.model, step: state.step + 1 } };
}

/** The step before this one, keeping every answer. */
export function backWizard(state: WizardState): WizardState {
  return { ...state, step: Math.max(0, state.step - 1) };
}

/** The provider entry and model the finished wizard describes. */
export type WizardResult =
  | { ok: true; providerId: string; provider: ProviderConfig; modelId: string }
  | { ok: false; problem: string };

export function wizardResult(
  state: WizardState,
  providers: Record<string, ProviderConfig>,
): WizardResult {
  const providerIdForResult = state.mode === "existing-provider" ? state.providerId : state.draft.id;
  if (providerIdForResult === "") return { ok: false, problem: "No provider was chosen." };
  const existing = providers[providerIdForResult];
  let provider: ProviderConfig;
  if (state.mode === "existing-provider") {
    if (existing === undefined) return { ok: false, problem: `${providerIdForResult} is no longer configured.` };
    provider = existing;
  } else {
    // `existing` is the same id only when the wizard overwrote it; a new
    // provider keeps whatever the draft left blank at its default.
    const built = draftToProvider(state.draft, existing);
    provider = built;
  }
  const contextWindow = positiveInteger(state.model.contextWindow);
  const maxTokens = positiveInteger(state.model.maxTokens);
  if (maxTokens > contextWindow) {
    return { ok: false, problem: "Maximum output must not exceed the context window." };
  }
  const modelId = state.model.id.trim();
  const model: JsonObject = {
    id: modelId,
    name: state.model.name.trim() || modelId,
    reasoning: state.model.reasoning === "Yes",
    input: state.model.input === "Text" ? ["text"] : ["text", "image"],
    contextWindow,
    maxTokens,
    cost: existing?.models?.find((entry) => entry.id === modelId)?.cost
      ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  return { ok: true, providerId: providerIdForResult, provider: putModel(provider, model), modelId };
}

// ---- the dialog -----------------------------------------------------------

/**
 * The dialog for the current step.
 *
 * One dialog per step, with the wizard's position and any refusal as its body:
 * a refusal re-publishes the *same* dialog id, so the client keeps the typed
 * answer and shows the problem where the answer was.
 */
export function wizardView(
  state: WizardState,
  providers: Record<string, ProviderConfig>,
  options: { problem?: string; notice?: string } = {},
): DialogWebView {
  if (stepKeys(state)[state.step] === HOME_STEP_KEY) return providerListView(providers, options);
  const step = wizardStep(state, providers);
  const last = state.step >= stepCount(state) - 1;
  const lines = [
    stepPosition(state),
    ...(options.notice !== undefined ? [options.notice] : []),
    ...(options.problem !== undefined ? [`Problem: ${options.problem}`] : []),
  ];
  return {
    type: "dialog",
    id: wizardDialogId(state),
    title: state.mode === "existing-provider" ? "Add/update model" : "Add provider",
    lines,
    fields: [
      {
        name: PROVIDERS_FIELD,
        label: step.title,
        // A masked step never publishes its value: a credential in a view would
        // ride the event stream to the browser. The draft keeps it instead, and
        // an empty answer on that step means "keep what was typed".
        ...(step.masked ? {} : { value: step.value }),
        help: step.help,
        ...(step.masked ? { kind: "secret" as const } : {}),
        ...(step.choices !== undefined ? { kind: "select" as const, choices: [...step.choices] } : {}),
        ...(step.placeholder !== "" ? { placeholder: step.placeholder } : {}),
        ...(step.required ? { required: true } : {}),
      },
    ],
    actions: [
      {
        id: PROVIDERS_NEXT_ACTION,
        label: last ? "Save" : "Continue",
        tone: "primary",
        submitsInput: true,
      },
      ...(state.step > 0 ? [{ id: PROVIDERS_BACK_ACTION, label: "← Back" }] : []),
      { id: PROVIDERS_CANCEL_ACTION, label: "Cancel" },
    ],
  };
}

/** The plugin's landing page, rendered in the host's existing content pane. */
function providerListView(
  providers: Record<string, ProviderConfig>,
  options: { problem?: string; notice?: string },
): DialogWebView {
  const rows = providerRows(providers);
  return {
    type: "dialog",
    id: providersDialogId(HOME_STEP_KEY),
    title: "Providers",
    lines: [
      ...(rows.length > 0 ? [] : ["No providers configured yet. Add a provider to get started."]),
      ...(options.notice !== undefined ? [options.notice] : []),
      ...(options.problem !== undefined ? [`Problem: ${options.problem}`] : []),
    ],
    items: rows.map((row) => ({
      id: row.id,
      label: row.name === row.id ? row.id : `${row.name} (${row.id})`,
      detail: `${row.models} model${row.models === 1 ? "" : "s"} · ${row.api}`,
      actionId: PROVIDERS_MANAGE_ACTION,
      values: { providerId: row.id },
    })),
    actions: [
      { id: PROVIDERS_ADD_ACTION, label: "Add provider", tone: "primary", placement: "header" },
      ...(rows.length > 0 ? [{ id: PROVIDERS_NEXT_ACTION, label: "Add model to existing provider" }] : []),
      { id: PROVIDERS_CANCEL_ACTION, label: "Close" },
    ],
  };
}

/** The dialog that reports what the finished wizard wrote. */
export function savedView(providerId: string, modelId: string): DialogWebView {
  return {
    type: "dialog",
    id: PROVIDERS_SAVED_DIALOG,
    title: "Provider saved",
    lines: [
      `Saved ${providerId} · model ${modelId}.`,
      "It is selectable in the model picker now.",
    ],
    actions: [{ id: PROVIDERS_CANCEL_ACTION, label: "Close" }],
  };
}

/** The dialog that reports a models.json this wizard will not touch. */
export function unreadableFileView(problem: string): DialogWebView {
  return {
    type: "dialog",
    id: PROVIDERS_FILE_DIALOG,
    title: "Providers",
    lines: [problem],
    actions: [{ id: PROVIDERS_CANCEL_ACTION, label: "Close" }],
  };
}

// ---- steps ----------------------------------------------------------------

function isDraftKey(key: string): boolean {
  return ["id", "name", "api", "baseUrl", "apiKey"].includes(key);
}

function draftContext(state: WizardState, providers: Record<string, ProviderConfig>): DraftContext {
  return { existingIds: Object.keys(providers) };
}

function draftStepToWizardStep(step: DraftStep): WizardStep {
  return {
    key: step.key,
    title: step.title,
    help: step.help,
    value: step.value,
    placeholder: step.placeholder,
    masked: step.masked,
    ...(step.choices !== undefined ? { choices: step.choices } : {}),
    // Only the id is mandatory: a blank key means a local server and a blank
    // name falls back to the id.
    required: step.key === "id",
  };
}

/**
 * The home screen: the two things you can do, nothing else — the TUI editor's
 * first page, with the configured-provider count as its detail.
 */
function homeStep(providers: Record<string, ProviderConfig>): WizardStep {
  const count = Object.keys(providers).length;
  return {
    key: HOME_STEP_KEY,
    title: "What would you like to do?",
    help: count === 0
      ? "No providers configured yet — add one, then give it a model."
      : `${count} configured provider${count === 1 ? "" : "s"} — open the list to add a model to one.`,
    value: LIST_PROVIDERS_CHOICE,
    placeholder: "",
    masked: false,
    choices: [LIST_PROVIDERS_CHOICE, ADD_PROVIDER_CHOICE],
    required: true,
  };
}

function providerChoiceStep(state: WizardState, providers: Record<string, ProviderConfig>): WizardStep {
  // The last entry configures a new provider instead of adding to one: the
  // model picker's add action is the only doorway, so it must reach both.
  const choices = [...Object.keys(providers).sort(), NEW_PROVIDER_CHOICE];
  return {
    key: PROVIDER_CHOICE_KEY,
    title: "Provider",
    help: "The models.json provider this model is added to, or a new one.",
    value: state.providerId !== "" && providers[state.providerId] !== undefined ? state.providerId : choices[0]!,
    placeholder: "",
    masked: false,
    choices,
    required: true,
  };
}

function modelStep(state: WizardState, key: ModelStepKey): WizardStep {
  const common = { placeholder: "", masked: false, required: false };
  switch (key) {
    case "modelId":
      return {
        ...common,
        key,
        title: "Model ID",
        help: "The exact model id the provider's API accepts.",
        value: state.model.id,
        placeholder: "gpt-6",
        required: true,
      };
    case "modelName":
      return {
        ...common,
        key,
        title: "Model display name",
        help: "What /model shows. Blank uses the id.",
        value: state.model.name,
        placeholder: state.model.id,
      };
    case "contextWindow":
      return {
        ...common,
        key,
        title: "Context window (tokens)",
        help: "From the provider's model docs; the session's context bar uses it.",
        value: state.model.contextWindow,
        placeholder: "128000",
        required: true,
      };
    case "maxTokens":
      return {
        ...common,
        key,
        title: "Maximum output tokens",
        help: "Must not exceed the context window.",
        value: state.model.maxTokens,
        placeholder: "8192",
        required: true,
      };
    case "reasoning":
      return {
        ...common,
        key,
        title: "Reasoning / thinking support",
        help: "Whether the model accepts a thinking budget.",
        value: state.model.reasoning,
        choices: ["No", "Yes"],
        required: true,
      };
    default:
      return {
        ...common,
        key,
        title: "Supported input",
        help: "Image input needs a vision-capable model.",
        value: state.model.input,
        choices: ["Text", "Text + images"],
        required: true,
      };
  }
}

function submitModelStep(
  state: WizardState,
  key: ModelStepKey,
  value: string,
): { model: ModelDraft } | { problem: string } {
  if (key === "modelId") {
    if (value === "") return { problem: "A model id is required." };
    if (!/^[^\s]+$/.test(value)) return { problem: "A model id cannot contain spaces." };
    return { model: { ...state.model, id: value, name: state.model.name === "" ? value : state.model.name } };
  }
  if (key === "modelName") return { model: { ...state.model, name: value } };
  if (key === "contextWindow" || key === "maxTokens") {
    let tokens: number;
    try {
      tokens = positiveInteger(value);
    } catch (error) {
      return { problem: (error as Error).message };
    }
    if (key === "maxTokens") {
      const contextWindow = safePositive(state.model.contextWindow);
      if (contextWindow !== undefined && tokens > contextWindow) {
        return { problem: "Maximum output must not exceed the context window." };
      }
    }
    return { model: { ...state.model, [key]: String(tokens) } };
  }
  if (key === "reasoning") {
    if (value !== "Yes" && value !== "No") return { problem: "Choose Yes or No." };
    return { model: { ...state.model, reasoning: value } };
  }
  if (value !== "Text" && value !== "Text + images") {
    return { problem: "Choose Text or Text + images." };
  }
  return { model: { ...state.model, input: value } };
}

function safePositive(value: string): number | undefined {
  try {
    return positiveInteger(value);
  } catch {
    return undefined;
  }
}
