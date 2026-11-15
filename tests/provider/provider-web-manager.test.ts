import test from "node:test";
import assert from "node:assert/strict";
import { providerEdit, providerManagerView } from "../../lib/provider/provider-web-manager.ts";

const provider = { name: "Acme", api: "openai-completions", baseUrl: "https://acme.test/v1", apiKey: "fixture-key", models: [{ id: "demo" }] };
const config = { providers: { acme: provider } };
const auth = { configured: true, registered: false };

test("clone requires a newly supplied key and migrates a lone provider without losing models", () => {
  const state = { id: "acme", screen: "clone" as const };
  const blank = providerEdit({ state, config, auth, values: {} });
  assert.equal(blank.ok, false);
  const result = providerEdit({ state, config, auth, values: { apiKey: "$OTHER_KEY" } });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.config.providers.acme, undefined);
  assert.equal(result.config.providers["acme-1"]?.apiKey, "fixture-key");
  assert.equal(result.config.providers["acme-2"]?.apiKey, "$OTHER_KEY");
  assert.deepEqual(result.config.providers["acme-2"]?.models, provider.models);
  assert.deepEqual(config.providers.acme, provider, "the opening snapshot is immutable");
});

test("cloning a numbered account computes the next slot in its family", () => {
  const result = providerEdit({ state: { id: "acme-2", screen: "clone" }, config: { providers: { "acme-1": provider, "acme-2": provider } }, auth, values: { apiKey: "$THIRD_KEY" } });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.config.providers["acme-3"]?.apiKey, "$THIRD_KEY");
});

test("stored/runtime auth, extension ownership and custom headers refuse ineffective key edits", () => {
  const state = { id: "acme", screen: "edit" as const };
  for (const source of ["stored", "runtime"]) {
    assert.equal(providerEdit({ state, config, auth: { ...auth, source }, values: { apiKey: "$NEW_KEY" } }).ok, false);
  }
  assert.equal(providerEdit({ state, config, auth: { ...auth, registered: true }, values: { apiKey: "$NEW_KEY" } }).ok, false);
  assert.equal(providerEdit({ state, config: { providers: { acme: { ...provider, headers: { Authorization: "fixture-header" } } } }, auth, values: { apiKey: "$NEW_KEY" } }).ok, false);
  assert.equal(providerEdit({ state, config, auth: { ...auth, source: "stored" }, values: { name: "Renamed", apiKey: "" } }).ok, true);
});

test("no management view republishes the saved API key", () => {
  for (const screen of ["detail", "edit", "clone", "remove", "pick-model", "remove-model", "trust"] as const) {
    const view = providerManagerView({ state: { id: "acme", screen, modelId: "demo" }, providers: config.providers });
    assert.ok(!JSON.stringify(view).includes("fixture-key"), screen);
  }
});
