/**
 * The provider editor's model of a provider, kept out of the popup.
 *
 * `/provider` used to be a chain of blocking dialogs: every answer opened a new
 * dialog, and going back re-asked from the first question. The editor needs the
 * opposite — answers that survive a Back — so the draft, its steps and their
 * validation live here as pure functions the popup calls on every render and
 * the tests can call without a terminal.
 *
 * Nothing here touches disk or the model registry: the extension owns the
 * snapshot, the trust check and the write.
 */
import {
  endpoint,
  environmentKey,
  findProviderAccounts,
  listProviderFamilies,
  nextProviderSlot,
  providerId,
  type JsonObject,
  type ProviderConfig,
} from "./provider-config.ts";

/** Wire protocols Pi can dispatch. Order is the picker order. */
export const PROVIDER_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;

const API_LABELS: Record<string, string> = {
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
  "google-generative-ai": "Google Generative AI",
};

export function apiLabel(api: string): string {
  return API_LABELS[api] ?? api;
}

/** What the wizard collects. `apiKey` is raw text, never a resolved secret. */
export interface ProviderDraft {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  apiKey: string;
  /** Base id when this draft is an extra account in a family. */
  accountOf?: string;
}

export type DraftStepKey = "id" | "name" | "api" | "baseUrl" | "apiKey";

export interface DraftStep {
  key: DraftStepKey;
  title: string;
  help: string;
  value: string;
  placeholder: string;
  /** Paint the value as asterisks; a key may be a secret. */
  masked: boolean;
  /** A fixed vocabulary, rendered as a menu instead of a text field. */
  choices?: readonly string[];
}

export interface DraftContext {
  existingIds: readonly string[];
  /** The id being edited; it may repeat itself without being a collision. */
  editingId?: string;
}

/**
 * The wizard's steps, in order.
 *
 * `idLocked` covers both an edit (the id names the file entry) and an account
 * draft (the slot number is computed from the family), so the one screen that
 * cannot be changed is also the one that says why.
 */
export function draftSteps(draft: ProviderDraft, idLocked = false): DraftStep[] {
  const apis: string[] = (PROVIDER_APIS as readonly string[]).includes(draft.api) || !draft.api
    ? [...PROVIDER_APIS]
    : [draft.api, ...PROVIDER_APIS];
  return [
    {
      key: "id",
      title: idLocked ? "Provider ID (locked)" : "Provider ID",
      help: draft.accountOf
        ? `The account slot for ${draft.accountOf}; the next free number, so another account can be added later.`
        : "Lowercase id used by /login, /model and models.json. It cannot contain spaces.",
      value: draft.id,
      placeholder: "acme",
      masked: false,
    },
    {
      key: "name",
      title: "Display name",
      help: "What /model shows. Blank uses the id.",
      value: draft.name,
      placeholder: draft.id || "Acme",
      masked: false,
    },
    {
      key: "api",
      title: "API protocol",
      help: "The wire protocol this endpoint speaks.",
      value: draft.api,
      placeholder: "",
      masked: false,
      choices: apis,
    },
    {
      key: "baseUrl",
      title: "Base URL",
      help: "Include /v1 when the server expects it. Trailing slashes are dropped.",
      value: draft.baseUrl,
      placeholder: "https://api.acme.com/v1",
      masked: false,
    },
    {
      key: "apiKey",
      title: "API key",
      help: "Blank = local server · $NAME reads an environment variable · anything else is stored literally.",
      value: draft.apiKey,
      placeholder: "$ACME_API_KEY",
      masked: true,
    },
  ];
}

const ENVIRONMENT_REFERENCE = /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/;

/**
 * Turn a typed key into the value stored in models.json.
 *
 * Shared with the dialog wizard so both paths escape identically: a literal key
 * must never become a Pi environment expression or a `!command`, and an
 * environment reference is stored unresolved.
 */
export function apiKeyFromInput(value: string, requireEnvironment: boolean): { apiKey?: string } | { problem: string } {
  const text = value.trim();
  if (!text) return { apiKey: undefined };
  // RPC has no masked input, so it only accepts an environment reference. A
  // bare NAME is one, exactly as the dialog's own validation treats it.
  if (requireEnvironment) {
    try {
      return { apiKey: environmentKey(text) };
    } catch {
      return { problem: "Enter an environment variable name such as $ACME_API_KEY, not the key itself." };
    }
  }
  if (ENVIRONMENT_REFERENCE.test(text)) return { apiKey: environmentKey(text) };
  const literal = text.replace(/\$/g, () => "$$");
  return { apiKey: literal.startsWith("!") ? `$!${literal.slice(1)}` : literal };
}

/** Why a step's current value cannot move on, or undefined when it can. */
export function stepProblem(key: DraftStepKey, value: string, context: DraftContext): string | undefined {
  const text = value.trim();
  switch (key) {
    case "id": {
      if (context.editingId !== undefined && text === context.editingId) return undefined;
      try {
        const id = providerId(text);
        return context.existingIds.includes(id)
          ? `${id} is already configured. Open it to edit, or pick another id.`
          : undefined;
      } catch (error) {
        return (error as Error).message;
      }
    }
    case "name":
      return text ? undefined : "A display name is required; it is what /model shows.";
    case "api":
      return text ? undefined : "Choose an API protocol.";
    case "baseUrl":
      try {
        endpoint(text);
        return undefined;
      } catch (error) {
        return (error as Error).message;
      }
    case "apiKey": {
      const resolved = apiKeyFromInput(text, false);
      return "problem" in resolved ? resolved.problem : undefined;
    }
    default:
      return undefined;
  }
}

/** The first step of a draft that cannot be saved, for a last check before writing. */
export function draftProblem(draft: ProviderDraft, context: DraftContext): string | undefined {
  for (const step of draftSteps(draft, true)) {
    const problem = stepProblem(step.key, step.value, context);
    if (problem) return `${step.title}: ${problem}`;
  }
  return undefined;
}

/**
 * Edit a stored provider.
 *
 * The stored key is never loaded back into the draft: showing it would put a
 * credential on screen, and re-saving it would double-escape a literal. A blank
 * key step therefore means "keep the authentication that is already there".
 */
export function providerToDraft(id: string, provider: ProviderConfig): ProviderDraft {
  return {
    id,
    name: typeof provider.name === "string" ? provider.name : id,
    api: typeof provider.api === "string" ? provider.api : PROVIDER_APIS[0],
    baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : "",
    apiKey: "",
  };
}

/** The config entry a draft describes, keeping every field it does not edit. */
export function draftToProvider(
  draft: ProviderDraft,
  base?: ProviderConfig,
  options: { inheritAuth?: boolean } = {},
): ProviderConfig {
  const key = apiKeyFromInput(draft.apiKey, false);
  if ("problem" in key) throw new Error(key.problem);
  const provider: ProviderConfig = {
    ...base,
    name: draft.name.trim() || draft.id,
    api: draft.api,
    baseUrl: endpoint(draft.baseUrl),
  };
  if (key.apiKey !== undefined) provider.apiKey = key.apiKey;
  // Blank on a new provider means a local server; blank while editing keeps
  // whatever authentication is already configured. A new account never
  // inherits the template's key: that would bill the wrong account.
  else if (base === undefined || options.inheritAuth === false) provider.apiKey = "pi-local";
  return provider;
}

export interface ProviderRow {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  models: number;
  /** Base id of the account family this provider belongs to. */
  family: string;
  /** 1-based position in the family; 1 is the base id itself. */
  account: number;
  /** Accounts sharing the family; 1 for a lone provider. */
  accounts: number;
}

/** Every configured provider, families kept next to each other. */
export function providerRows(providers: Record<string, ProviderConfig>): ProviderRow[] {
  const rows: ProviderRow[] = [];
  for (const [family, accounts] of listProviderFamilies(providers)) {
    for (const entry of accounts) {
      const provider = entry.provider;
      rows.push({
        id: entry.id,
        name: typeof provider.name === "string" && provider.name.trim() ? provider.name : entry.id,
        api: typeof provider.api === "string" ? provider.api : "",
        baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : "",
        models: provider.models?.length ?? 0,
        family,
        account: entry.index,
        accounts: accounts.length,
      });
    }
  }
  return rows;
}

export interface ModelRow {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number | undefined;
  maxTokens: number | undefined;
  /** A native `modelOverrides` entry exists, so this form is not the only source. */
  overridden: boolean;
}

export function modelRows(provider: ProviderConfig): ModelRow[] {
  const overrides = isObject(provider.modelOverrides) ? provider.modelOverrides : {};
  return (provider.models ?? []).map((model) => {
    const id = String(model.id);
    return {
      id,
      name: typeof model.name === "string" && model.name.trim() ? model.name : id,
      reasoning: model.reasoning === true,
      contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : undefined,
      maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : undefined,
      overridden: Object.hasOwn(overrides, id),
    };
  });
}

/**
 * Drop a model from a provider.
 *
 * The `modelOverrides` entry goes with it: leaving it behind would let Pi keep
 * advertising a model the user just deleted.
 */
export function withoutModel(provider: ProviderConfig, modelId: string): ProviderConfig {
  const models = (provider.models ?? []).filter((model) => model.id !== modelId);
  const overrides = isObject(provider.modelOverrides) ? { ...provider.modelOverrides } : undefined;
  if (overrides) delete overrides[modelId];
  const remaining = overrides && Object.keys(overrides).length ? overrides : undefined;
  return {
    ...provider,
    models,
    ...(remaining ? { modelOverrides: remaining } : { modelOverrides: undefined }),
  };
}

export interface AccountPlan {
  draft: ProviderDraft;
  /** The account whose models, headers and flags the new one inherits. */
  templateId: string;
  /** The rename that turns a single base provider into its first slot. */
  migration?: { from: string; to: string };
}

/**
 * The next account for a provider family.
 *
 * A lone `acme` becomes `acme-1` so the new `acme-2` has a sibling to sit next
 * to; the rename is reported rather than done silently.
 */
export function accountPlan(providers: Record<string, ProviderConfig>, baseId: string): AccountPlan | undefined {
  const accounts = findProviderAccounts(providers, baseId);
  const template = accounts[0];
  if (!template) return undefined;
  const soloBase = accounts.length === 1 && template.id === baseId;
  const slot = soloBase ? 2 : nextProviderSlot(providers, baseId);
  const baseName = baseNameOf(template.provider, baseId);
  return {
    draft: {
      id: `${baseId}-${slot}`,
      name: `${baseName} (Account ${slot})`,
      api: typeof template.provider.api === "string" ? template.provider.api : PROVIDER_APIS[0],
      baseUrl: typeof template.provider.baseUrl === "string" ? template.provider.baseUrl : "",
      // A new account needs its own credential; inheriting the first account's
      // key would silently bill the wrong account.
      apiKey: "",
      accountOf: baseId,
    },
    templateId: template.id,
    ...(soloBase ? { migration: { from: baseId, to: `${baseId}-1` } } : {}),
  };
}

/** Apply the plan's rename and add the new account, leaving every other entry alone. */
export function withAccount(
  providers: Record<string, ProviderConfig>,
  plan: AccountPlan,
  account: ProviderConfig,
): Record<string, ProviderConfig> {
  const next = { ...providers };
  if (plan.migration) {
    const original = next[plan.migration.from];
    if (original) {
      next[plan.migration.to] = { ...original, name: `${baseNameOf(original, plan.migration.from)} (Account 1)` };
      delete next[plan.migration.from];
    }
  }
  next[plan.draft.id] = account;
  return next;
}

/** How the stored authentication will resolve, in words a person can check. */
export function describeAuth(provider: ProviderConfig): string {
  const key = provider.apiKey;
  if (typeof key !== "string") {
    return provider.headers ? "custom headers, no apiKey" : "no apiKey (stored /login or runtime key may apply)";
  }
  if (key === "pi-local") return "local server (dummy pi-local key)";
  const environment = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(key);
  if (environment) return `environment ${environment[1] ?? environment[2]}`;
  return "literal key in models.json";
}

function baseNameOf(provider: ProviderConfig, fallback: string): string {
  const name = typeof provider.name === "string" && provider.name.trim() ? provider.name : fallback;
  return name.replace(/ \(Account \d+\)$/, "");
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
