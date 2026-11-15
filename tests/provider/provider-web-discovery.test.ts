import test from "node:test";
import assert from "node:assert/strict";
import { validateView } from "../../web/core/plugin-contracts/view.ts";
import type { ProviderConfig } from "../../lib/provider/provider-config.ts";
import type { DiscoveredModel } from "../../lib/provider/provider-discovery.ts";
import {
  DISCOVERY_ROW_CAP, applyDiscoveredModels, discoveryPickerView, discoveringView, discoveryFailedView,
  matchingModels, siblingAccounts, syncModelsToSiblings, syncOfferView, toggleModel, type DiscoveryState,
} from "../../lib/provider/provider-web-discovery.ts";

const provider: ProviderConfig = {
  api: "openai-completions", baseUrl: "https://zro.test/v1", apiKey: "$ZRO_KEY",
  models: [{ id: "old-model", name: "Old", contextWindow: 64000, maxTokens: 4096, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
};

function state(models: DiscoveredModel[], selected: string[] = [], filter = ""): DiscoveryState {
  return { providerId: "zro-1", models, selected: new Set(selected), filter };
}

test("matchingModels narrows by whitespace-separated id or name terms", () => {
  const models = [
    { id: "deepseek-v4.1-flash", name: "DeepSeek Flash" },
    { id: "glm-5.3-flash", name: "GLM" },
    { id: "zro/deepseek-pro" },
  ];
  assert.deepEqual(matchingModels(state(models)).map((model) => model.id), models.map((model) => model.id));
  assert.deepEqual(matchingModels(state(models, [], "deepseek pro")).map((model) => model.id), ["zro/deepseek-pro"]);
  assert.deepEqual(matchingModels(state(models, [], "deepseek")).map((model) => model.id), ["deepseek-v4.1-flash", "zro/deepseek-pro"]);
  assert.deepEqual(matchingModels(state(models, [], "DeepSeek FLASH")).map((model) => model.id), ["deepseek-v4.1-flash"]);
});

test("toggleModel flips one id without mutating the input state", () => {
  const before = state([{ id: "a" }, { id: "b" }], ["a"]);
  const after = toggleModel(before, "b");
  assert.deepEqual([...after.selected].sort(), ["a", "b"]);
  assert.deepEqual([...before.selected], ["a"], "the previous view is immutable");
  assert.deepEqual([...toggleModel(after, "a").selected], ["b"]);
});

test("every discovery view survives the dialog validator", () => {
  const views = [
    discoveringView("zro-1"),
    discoveryFailedView("zro-1", "The model-list endpoint returned HTTP 401."),
    syncOfferView("zro-1", ["zro-2", "zro-3"], 4),
    discoveryPickerView(state([{ id: "a", name: "A", contextWindow: 128000, maxTokens: 8192, reasoning: true, input: ["text", "image"] }, { id: "b" }], ["a"])),
  ];
  for (const view of views) {
    const result = validateView(view);
    assert.equal(result.ok, true, view.id);
  }
});

test("the picker publishes tick state, caps rows and never exposes a secret", () => {
  const many = Array.from({ length: DISCOVERY_ROW_CAP + 5 }, (_, index): DiscoveredModel => ({ id: `m-${index}` }));
  const view = discoveryPickerView(state(many, ["m-0"]));
  const result = validateView(view);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(view.items?.length, DISCOVERY_ROW_CAP);
  // Selection is data the host draws a control for; the label is the model id
  // alone, so no `[x]`/`[ ]` marker reaches the text or a screen reader.
  assert.equal(view.items?.[0]?.label, "m-0");
  assert.equal(view.items?.[0]?.selected, true);
  assert.equal(view.items?.[1]?.label, "m-1");
  assert.equal(view.items?.[1]?.selected, false);
  assert.ok(!view.items?.some((item) => /[[\]]/.test(item.label)), "no ASCII markers in any label");
  assert.ok(view.lines?.some((line) => line.startsWith(`Showing the first ${DISCOVERY_ROW_CAP}`)));
  assert.ok(!view.lines?.some((line) => line.startsWith("Filter:")), "no filter line when the filter is empty");
  const filtered = discoveryPickerView({ ...state(many, ["m-0"]), filter: "m-1" });
  assert.ok(filtered.lines?.[0]?.startsWith("Filter: m-1 ·"), "an applied filter is visible in the pane");
  assert.ok(!JSON.stringify(view).includes("ZRO_KEY"), "the auth key stays out of the view");
});

test("applyDiscoveredModels writes server facts and flags defaulted context windows", () => {
  const discovered: DiscoveredModel[] = [
    { id: "new-model", name: "New", contextWindow: 200000, maxTokens: 16384, reasoning: true, input: ["text", "image"] },
    { id: "no-facts" },
    { id: "old-model", contextWindow: 100000, maxTokens: 999999 },
  ];
  const { provider: updated, defaulted } = applyDiscoveredModels(provider, discovered);
  assert.deepEqual(defaulted, ["no-facts"], "only the unreported window is flagged");
  const models = updated.models ?? [];
  assert.equal(models.find((model) => model.id === "new-model")?.contextWindow, 200000);
  assert.equal(models.find((model) => model.id === "new-model")?.maxTokens, 16384);
  const noFacts = models.find((model) => model.id === "no-facts")!;
  assert.equal(noFacts.contextWindow, 128000, "an unreported window defaults like the TUI's fallback");
  assert.equal(noFacts.maxTokens, 8192);
  // A server reporting an output limit above the window keeps the stored one
  // before falling back to the 8192 clamp — the TUI's exact precedence.
  assert.equal(models.find((model) => model.id === "old-model")?.maxTokens, 4096);
  // An existing cost is preserved through an update.
  assert.deepEqual(models.find((model) => model.id === "old-model")?.cost, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
});

test("syncModelsToSiblings copies the model list but never a credential", () => {
  const config = {
    providers: {
      "zro-1": { ...provider, models: [{ id: "shared", name: "Shared", contextWindow: 1000, maxTokens: 100 }] },
      "zro-2": { ...provider, apiKey: "$OTHER_KEY", models: [] },
      "solo": { ...provider },
    },
  };
  assert.deepEqual(siblingAccounts(config.providers, "zro-1"), ["zro-2"]);
  assert.deepEqual(siblingAccounts(config.providers, "solo"), []);
  const synced = syncModelsToSiblings(config, "zro-1");
  assert.deepEqual(synced.providers["zro-2"]?.models, config.providers["zro-1"]?.models);
  assert.equal(synced.providers["zro-2"]?.apiKey, "$OTHER_KEY", "the sibling keeps its own key");
  assert.deepEqual(synced.providers["zro-1"], config.providers["zro-1"], "the source account is untouched");
  assert.deepEqual(config.providers["zro-2"]?.models, [], "the input config is immutable");
});
