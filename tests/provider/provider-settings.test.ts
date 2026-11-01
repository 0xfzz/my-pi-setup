import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROVIDER_APIS, accountPlan, apiKeyFromInput, apiLabel, describeAuth, draftProblem, draftSteps,
  draftToProvider, modelRows, providerRows, providerToDraft, stepProblem, withAccount, withoutModel,
  type ProviderDraft,
} from "../../lib/provider/provider-settings.ts";
import type { ProviderConfig } from "../../lib/provider/provider-config.ts";

const draft = (extra: Partial<ProviderDraft> = {}): ProviderDraft => ({
  id: "acme",
  name: "Acme",
  api: "openai-completions",
  baseUrl: "https://api.acme.com/v1",
  apiKey: "$ACME_KEY",
  ...extra,
});

const acme: ProviderConfig = {
  name: "Acme",
  api: "openai-completions",
  baseUrl: "https://api.acme.com/v1",
  apiKey: "$ACME_KEY",
  compatibility: { supportsDeveloperRole: false },
  models: [{ id: "acme-large", name: "Acme Large", contextWindow: 128000, maxTokens: 8192, reasoning: true }],
};

// ── Steps ────────────────────────────────────────────────────────────────────

test("the wizard asks for the connection fields in the order they are needed", () => {
  const steps = draftSteps(draft());
  assert.deepEqual(steps.map((step) => step.key), ["id", "name", "api", "baseUrl", "apiKey"]);
  assert.deepEqual(steps.map((step) => step.value), ["acme", "Acme", "openai-completions", "https://api.acme.com/v1", "$ACME_KEY"]);
  assert.equal(steps.find((step) => step.key === "apiKey")?.masked, true, "a key is painted as asterisks");
  assert.deepEqual(steps.find((step) => step.key === "api")?.choices, [...PROVIDER_APIS]);
});

test("an id that is locked is still shown, with the reason it cannot change", () => {
  const editing = draftSteps(draft(), true).find((step) => step.key === "id")!;
  assert.match(editing.title, /locked/);
  const account = draftSteps({ ...draft({ id: "acme-2", accountOf: "acme" }) }, true).find((step) => step.key === "id")!;
  assert.match(account.help, /acme/);
});

test("a protocol outside the known list keeps its own entry instead of disappearing", () => {
  const steps = draftSteps(draft({ api: "my-custom-protocol" }));
  assert.deepEqual(steps.find((step) => step.key === "api")?.choices, ["my-custom-protocol", ...PROVIDER_APIS]);
});

// ── Validation ───────────────────────────────────────────────────────────────

test("a step names the exact problem instead of rejecting a whole form", () => {
  const context = { existingIds: ["other"] };
  assert.match(stepProblem("id", "Acme API", context) ?? "", /lowercase/);
  assert.match(stepProblem("id", "other", context) ?? "", /already configured/);
  assert.equal(stepProblem("id", "other", { existingIds: ["other"], editingId: "other" }), undefined,
    "an edited provider may keep its own id");
  assert.match(stepProblem("name", "  ", context) ?? "", /display name is required/);
  assert.equal(stepProblem("api", "openai-completions", context), undefined);
  assert.match(stepProblem("api", "", context) ?? "", /API protocol/);
  assert.match(stepProblem("baseUrl", "api.acme.com", context) ?? "", /http/);
  assert.equal(stepProblem("baseUrl", "https://api.acme.com/v1/", context), undefined);
  assert.match(stepProblem("apiKey", "not$an$env", context) ?? "", /^$/, "a literal key is accepted; only RPC insists on a reference");
  assert.equal(stepProblem("apiKey", "$ACME_KEY", context), undefined);
  assert.equal(stepProblem("apiKey", "", context), undefined, "blank is a local server or an unchanged key");
});

test("draftProblem reports the first failing step with its title", () => {
  assert.equal(draftProblem(draft(), { existingIds: [] }), undefined);
  assert.match(draftProblem(draft({ baseUrl: "" }), { existingIds: [] }) ?? "", /Base URL/);
});

// ── API keys ─────────────────────────────────────────────────────────────────

test("a typed key becomes either a reference or an escaped literal, never a command", () => {
  assert.deepEqual(apiKeyFromInput("", false), { apiKey: undefined });
  assert.deepEqual(apiKeyFromInput("$ACME_KEY", false), { apiKey: "$ACME_KEY" });
  assert.deepEqual(apiKeyFromInput("${ACME_KEY}", false), { apiKey: "$ACME_KEY" });
  assert.deepEqual(apiKeyFromInput("sk-abc$def", false), { apiKey: "sk-abc$$def" },
    "a literal $ cannot become environment interpolation");
  assert.deepEqual(apiKeyFromInput("!echo secret", false), { apiKey: "$!echo secret" },
    "a literal ! is escaped so it stays a value, not a command");
  assert.deepEqual(apiKeyFromInput("ACME_KEY", false), { apiKey: "ACME_KEY" },
    "without the $ it is a literal, not a reference");
  assert.deepEqual(apiKeyFromInput("ACME_KEY", true), { apiKey: "$ACME_KEY" },
    "RPC has no masked input, so it reads a bare name as the environment variable");
  assert.match((apiKeyFromInput("sk-literal", true) as { problem: string }).problem, /environment variable/);
});

// ── Drafts ───────────────────────────────────────────────────────────────────

test("editing never loads the stored credential into the form", () => {
  const editing = providerToDraft("acme", acme);
  assert.equal(editing.apiKey, "", "the key step starts blank so nothing is redisplayed");
  assert.equal(editing.api, "openai-completions");
  assert.equal(editing.name, "Acme");
});

test("a blank key means local on a new provider and unchanged on an edit", () => {
  assert.equal(draftToProvider(draft({ apiKey: "" })).apiKey, "pi-local");
  assert.equal(draftToProvider(draft({ apiKey: "" }), acme).apiKey, "$ACME_KEY");

  const kept = draftToProvider(draft({ apiKey: "" }), { apiKey: "stored-by-login" });
  assert.equal(kept.apiKey, "stored-by-login", "editing a provider without a key keeps native credentials");
});

test("saving keeps advanced fields and normalizes only what the form edits", () => {
  const provider = draftToProvider(draft({ name: " Acme Cloud ", baseUrl: "https://api.acme.com/v1///" }), acme);
  assert.equal(provider.name, "Acme Cloud");
  assert.equal(provider.baseUrl, "https://api.acme.com/v1");
  assert.equal(provider.apiKey, "$ACME_KEY");
  assert.deepEqual(provider.compatibility, { supportsDeveloperRole: false });
  assert.deepEqual(provider.models, acme.models);
  assert.equal(draftToProvider(draft({ name: "  " })).name, "acme", "a blank name falls back to the id");
});

// ── Rows ─────────────────────────────────────────────────────────────────────

test("the list groups accounts and counts their models", () => {
  const rows = providerRows({
    acme: acme,
    "acme-2": { ...acme, name: "Acme (Account 2)", apiKey: "$ACME_KEY_2", models: [] },
    ollama: { name: "Local", api: "openai-completions", baseUrl: "http://127.0.0.1:11434/v1" },
  });
  assert.deepEqual(rows.map((row) => row.id), ["acme", "acme-2", "ollama"]);
  assert.deepEqual(rows.map((row) => [row.family, row.account, row.accounts]), [["acme", 1, 2], ["acme", 2, 2], ["ollama", 1, 1]]);
  assert.equal(rows[2]?.models, 0, "a provider without a models array counts as none");
  assert.equal(rows[2]?.name, "Local");
});

test("model rows mark native overrides, because those win over this form", () => {
  const rows = modelRows({
    ...acme,
    modelOverrides: { "acme-large": { contextWindow: 200000 } },
    models: [
      ...acme.models!,
      { id: "acme-small" },
    ],
  });
  assert.deepEqual(rows.map((row) => [row.id, row.overridden]), [["acme-large", true], ["acme-small", false]]);
  assert.equal(rows[1]?.name, "acme-small", "a model without a display name shows its id");
  assert.equal(rows[1]?.contextWindow, undefined);
});

test("removing a model also removes the override that would resurrect it", () => {
  const provider: ProviderConfig = {
    ...acme,
    models: [...acme.models!, { id: "acme-small" }],
    modelOverrides: { "acme-large": { contextWindow: 200000 }, "acme-small": { name: "Small" } },
  };
  const onlySmall = withoutModel(provider, "acme-large");
  assert.deepEqual(onlySmall.models?.map((model) => model.id), ["acme-small"]);
  assert.deepEqual(Object.keys(onlySmall.modelOverrides ?? {}), ["acme-small"]);

  const none = withoutModel(onlySmall, "acme-small");
  assert.deepEqual(none.models, []);
  assert.equal(none.modelOverrides, undefined, "no empty override map is left behind");
});

// ── Accounts ─────────────────────────────────────────────────────────────────

test("a lone provider is migrated to its first slot when an account is added", () => {
  const plan = accountPlan({ acme }, "acme")!;
  assert.deepEqual(plan.migration, { from: "acme", to: "acme-1" });
  assert.equal(plan.draft.id, "acme-2");
  assert.equal(plan.draft.name, "Acme (Account 2)");
  assert.equal(plan.draft.accountOf, "acme");
  assert.equal(plan.draft.apiKey, "", "the new account must supply its own credential");

  const next = withAccount({ acme }, plan, { ...acme, name: "Acme (Account 2)", apiKey: "$ACME_KEY_2" });
  assert.deepEqual(Object.keys(next).sort(), ["acme-1", "acme-2"]);
  assert.equal(next["acme-1"]?.name, "Acme (Account 1)");
  assert.equal(next["acme-1"]?.apiKey, "$ACME_KEY", "the first account keeps its credential");
  assert.equal(next["acme-2"]?.apiKey, "$ACME_KEY_2");
});

test("a family keeps counting from its highest slot, and an unknown base has no plan", () => {
  const providers = { "acme-1": acme, "acme-3": { ...acme, name: "Acme (Account 3)" } };
  const plan = accountPlan(providers, "acme")!;
  assert.equal(plan.migration, undefined);
  assert.equal(plan.draft.id, "acme-4");
  assert.equal(plan.draft.name, "Acme (Account 4)");
  assert.equal(accountPlan({}, "acme"), undefined);
});

test("the stored authentication is described the way it will resolve", () => {
  assert.match(describeAuth({ apiKey: "$ACME_KEY" }), /environment ACME_KEY/);
  assert.match(describeAuth({ apiKey: "${ACME_KEY}" }), /environment ACME_KEY/);
  assert.match(describeAuth({ apiKey: "sk-literal" }), /literal/);
  assert.match(describeAuth({ apiKey: "pi-local" }), /local server/);
  assert.match(describeAuth({ headers: { "x-team": "a" } }), /custom headers/);
  assert.match(describeAuth({}), /no apiKey/);
});

test("every known protocol has a readable label, and an unknown one shows itself", () => {
  assert.equal(apiLabel("openai-completions"), "OpenAI Chat Completions");
  assert.equal(apiLabel("google-generative-ai"), "Google Generative AI");
  for (const api of PROVIDER_APIS) assert.notEqual(apiLabel(api), api, `${api} has a friendlier label than its id`);
  assert.equal(apiLabel("custom-wire"), "custom-wire");
});
