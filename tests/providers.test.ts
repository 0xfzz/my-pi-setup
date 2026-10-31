import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import providers from "../extensions/providers.ts";
import { ProviderModelPicker } from "../lib/provider-model-picker.ts";
import { endpoint, environmentKey, positiveInteger, providerId, putModel, readConfig, saveConfig } from "../lib/provider-config.ts";

// Default discovery to unavailable. Wizard tests must never contact real providers.
const realFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = async () => new Response("", { status: 404 }); });
afterEach(() => { globalThis.fetch = realFetch; });

async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-provider-test-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("provider fields reject malformed URLs, IDs, command auth and invalid token limits", () => {
  assert.equal(providerId("my-provider"), "my-provider");
  for (const id of ["", "__proto__", "constructor", "Has spaces", "UPPER"]) assert.throws(() => providerId(id));
  assert.equal(endpoint("http://localhost:11434/v1/"), "http://localhost:11434/v1");
  for (const url of ["localhost:1234", "file:///tmp/a", "https://u:p@host/v1", "https://host?key=secret", "https://host#x"]) assert.throws(() => endpoint(url));
  for (const name of ["ACME_API_KEY", "$ACME_API_KEY", "${ACME_API_KEY}"]) assert.equal(environmentKey(name), "$ACME_API_KEY");
  for (const name of ["!get-secret", "api-key", "", "${MISSING", "KEY;echo"]) assert.throws(() => environmentKey(name));
  for (const value of ["0", "-1", "1.2", "Infinity", "12x", "9007199254740992"]) assert.throws(() => positiveInteger(value));
  assert.equal(positiveInteger("8192"), 8192);
});

test("private atomic writes preserve unrelated and advanced fields", async () => fixture(async dir => {
  const path = join(dir, "models.json");
  const original = { $schema: "https://pi.dev/schemas/models.schema.json", custom: true, providers: {
    old: { headers: { Authorization: "$TOKEN" }, modelOverrides: { abc: { reasoning: true } }, models: [
      { id: "abc", compat: { supportsDeveloperRole: false }, cost: { input: 2 }, name: "Old" },
    ] },
  } };
  await writeFile(path, JSON.stringify(original));
  const snapshot = await readConfig(path);
  const next = structuredClone(snapshot.config);
  next.providers.old = putModel(next.providers.old, { id: "abc", name: "New" });
  next.providers.new = { api: "openai-completions", baseUrl: "http://localhost/v1", models: [{ id: "test" }] };
  await saveConfig(snapshot, next);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.providers.old.models[0].name, "New");
  assert.deepEqual(saved.providers.old.models[0].cost, { input: 2 });
  assert.deepEqual(saved.providers.old.headers, original.providers.old.headers);
  assert.deepEqual(saved.providers.old.modelOverrides, { abc: { reasoning: true, name: "New" } });
  assert.equal(saved.custom, true);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(stat(`${path}.workflow.lock`), { code: "ENOENT" });
}));

test("missing files are created; malformed/commented files and symlinks are never overwritten", async () => fixture(async dir => {
  const path = join(dir, "models.json");
  const snapshot = await readConfig(path);
  assert.deepEqual(snapshot.config, { providers: {} });
  await saveConfig(snapshot, snapshot.config);
  for (const invalid of ["{not-json", '{// comment\n"providers":{}}', '{"providers":[]}', '{"providers":{"x":{"models":[null]}}}']) {
    await writeFile(path, invalid);
    await assert.rejects(readConfig(path));
    assert.equal(await readFile(path, "utf8"), invalid);
  }
  const linked = join(dir, "linked.json");
  await symlink(path, linked);
  await assert.rejects(readConfig(linked), /regular file/);
}));

test("stale dialogs and overlapping writers cannot silently overwrite configuration", async () => fixture(async dir => {
  const path = join(dir, "models.json");
  const snapshot = await readConfig(path);
  await writeFile(path, '{"providers":{"external":{}}}');
  await assert.rejects(saveConfig(snapshot, snapshot.config), /changed while/);
  assert.ok((await readConfig(path)).config.providers.external);
  const current = await readConfig(path);
  await writeFile(`${path}.workflow.lock`, "");
  await assert.rejects(saveConfig(current, current.config), /Another .* save/);
  await rm(`${path}.workflow.lock`);
  const results = await Promise.allSettled([saveConfig(current, current.config), saveConfig(current, current.config)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
}));

function harness(inputs: Array<string | undefined>, choices: Array<string | string[] | undefined>, confirms: boolean[] = [], keys: Array<string | undefined> = [""]) {
  const commands = new Map<string, any>();
  providers({ registerCommand: (name: string, command: any) => commands.set(name, command) } as any);
  const notices: string[] = [];
  const prompts: string[] = [];
  let refreshes = 0;
  const modelChoices: string[] = [];
  const ctx: any = {
    hasUI: true, mode: "tui", isIdle: () => true,
    ui: {
      custom: async (factory: any) => {
        const component = factory({ requestRender() {}, terminal: { rows: 24 } }, { fg: (_color: string, text: string) => text }, {}, () => {});
        if (component instanceof ProviderModelPicker) {
          prompts.push("Select provider models");
          modelChoices.push(...component.models.map(model => `Model: ${model.id}`));
          const choice = choices.shift();
          if (choice === undefined) return undefined;
          if (choice === "Enter model ID manually") return { manual: true };
          return { ids: Array.isArray(choice) ? choice : [choice.replace(/^Model: /, "")] };
        }
        component.dispose?.();
        prompts.push("API key (masked)");
        return keys.shift();
      },
      input: async (title: string) => { prompts.push(title); return inputs.shift(); },
      select: async (title: string) => { prompts.push(title); return choices.shift(); },
      confirm: async (title: string) => { prompts.push(title); return confirms.shift() ?? false; },
      notify: (message: string) => notices.push(message),
    },
    modelRegistry: {
      getAll: () => [], getError: () => undefined, getProviderAuthStatus: () => ({ configured: false }), getRegisteredProviderIds: () => [],
      refresh: async (options: any) => { assert.deepEqual(options, { allowNetwork: false }); refreshes++; },
    },
  };
  return { commands, ctx, notices, prompts, modelChoices, refreshes: () => refreshes };
}

// Each test has an isolated agent dir; the real user's credentials/config are never touched.
async function inAgentDir(run: (path: string) => Promise<void>) {
  await fixture(async dir => {
    const before = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try { assert.equal(getAgentDir(), dir); await run(join(dir, "models.json")); }
    finally {
      if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = before;
    }
  });
}

function localSetup(confirm = true) {
  return harness(["local-test", "Local Test", "http://localhost:11434/v1", "qwen:7b", "", "32768", "4096"],
    ["openai-completions", "No", "Text"], [confirm]);
}

test("wizard adds a persistent local provider, refreshes without network and leaves model selection alone", async () => inAgentDir(async path => {
  const h = localSetup();
  assert.deepEqual(h.commands.get("provider").getArgumentCompletions("mo"), [{ value: "model", label: "model" }]);
  assert.deepEqual([...h.commands.keys()], ["provider"]);
  await h.commands.get("provider").handler("add", h.ctx);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.providers["local-test"].apiKey, "pi-local");
  assert.equal(saved.providers["local-test"].name, "Local Test");
  assert.deepEqual(h.prompts.slice(0, 5), ["Provider ID (e.g. acme or my-ollama)", "Provider display name (blank keeps local-test)", "API key (masked)", "API protocol", "Base URL (include /v1 if your server requires it)"]);
  assert.equal(saved.providers["local-test"].models[0].name, "qwen:7b");
  assert.equal(saved.providers["local-test"].models[0].contextWindow, 32768);
  assert.equal(h.refreshes(), 1);
  assert.match(h.notices.at(-1)!, /current model was not changed/);
}));

test("cancellation at every prompt and final rejection writes nothing", async () => inAgentDir(async path => {
  for (let step = 0; step < 11; step++) {
    const h = localSetup();
    let count = 0;
    for (const name of ["input", "select", "custom"] as const) {
      const original = h.ctx.ui[name];
      h.ctx.ui[name] = async (...args: any[]) => count++ === step ? undefined : original(...args);
    }
    await h.commands.get("provider").handler("add", h.ctx);
    await assert.rejects(stat(path), { code: "ENOENT" });
    assert.equal(h.refreshes(), 0);
    assert.match(h.notices.at(-1)!, /cancelled/);
  }
  const h = localSetup(false);
  await h.commands.get("provider").handler("add", h.ctx);
  await assert.rejects(stat(path), { code: "ENOENT" });
}));

test("inline API keys are masked; literals cannot execute commands or interpolate, and env references stay references", async () => inAgentDir(async path => {
  for (const [key, expected] of [["fixture-key", "fixture-key"], ["!not-a-command$LITERAL", "$!not-a-command$$LITERAL"], ["$ACME_API_KEY", "$ACME_API_KEY"]]) {
    await rm(path, { force: true });
    const h = harness(["acme", "Acme Service", "https://example.com/v1", "model", "", "128000", "8192"],
      ["openai-responses", "Yes", "Text + images"], [true], [key]);
    await h.commands.get("provider").handler("add", h.ctx);
    const config = JSON.parse(await readFile(path, "utf8"));
    assert.equal(config.providers.acme.apiKey, expected);
    assert.equal(config.providers.acme.name, "Acme Service");
    assert.ok(h.prompts.includes("API key (masked)"));
    assert.ok(h.notices.every(notice => !notice.includes(key)));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
}));

test("edit/model/remove preserve advanced fields, other providers and auth storage", async () => inAgentDir(async path => {
  await writeFile(path, JSON.stringify({ providers: {
    acme: { api: "openai-completions", baseUrl: "https://old.example/v1", apiKey: "$KEY", headers: { "X-Key": "$EXTRA" }, models: [{ id: "one", compat: { supportsStore: false } }] },
    other: { models: [{ id: "untouched" }] },
  } }));
  const authPath = join(path, "..", "auth.json");
  await writeFile(authPath, "unchanged-auth-sentinel");
  const edit = harness(["Acme Renamed", "https://new.example/v1"], ["acme", "openai-responses"], [true, true]);
  await edit.commands.get("provider").handler("edit", edit.ctx);
  let config = JSON.parse(await readFile(path, "utf8"));
  assert.equal(config.providers.acme.apiKey, "$KEY");
  assert.equal(config.providers.acme.name, "Acme Renamed");
  assert.deepEqual(config.providers.acme.headers, { "X-Key": "$EXTRA" });
  const model = harness(["one", "Changed", "32000", "4096"], ["acme", "No", "Text"], [true]);
  await model.commands.get("provider").handler("model", model.ctx);
  config = JSON.parse(await readFile(path, "utf8"));
  assert.equal(config.providers.acme.models.length, 1);
  assert.deepEqual(config.providers.acme.models[0].compat, { supportsStore: false });
  const remove = harness([], ["acme"], [true]);
  await remove.commands.get("provider").handler("remove", remove.ctx);
  config = JSON.parse(await readFile(path, "utf8"));
  assert.equal(config.providers.acme, undefined);
  assert.ok(config.providers.other);
  assert.equal(await readFile(authPath, "utf8"), "unchanged-auth-sentinel");
}));

test("real Pi loads wizard output, makes local models available and exposes native secret login", async () => inAgentDir(async path => {
  const runtime = await ModelRuntime.create({ modelsPath: path, authPath: join(path, "..", "auth.json"),
    modelsStorePath: join(path, "..", "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  const h = localSetup();
  h.ctx.modelRegistry = new ModelRegistry(runtime);
  await h.commands.get("provider").handler("add", h.ctx);
  assert.equal(runtime.getError(), undefined);
  assert.equal(runtime.getModel("local-test", "qwen:7b")?.api, "openai-completions");
  assert.equal(new ModelRegistry(runtime).getProviderDisplayName("local-test"), "Local Test");
  assert.ok((await runtime.getAvailable("local-test")).some(model => model.id === "qwen:7b"));
  const snapshot = await readConfig(path);
  delete snapshot.config.providers["local-test"].apiKey;
  await saveConfig(snapshot, snapshot.config);
  await runtime.refresh({ allowNetwork: false });
  const provider = runtime.getProvider("local-test")!;
  assert.ok(provider.auth.apiKey?.login);
  let promptType: string | undefined;
  const credential = await provider.auth.apiKey!.login!({ prompt: async (prompt: any) => {
    promptType = prompt.type; return "test-fixture-key";
  } } as any);
  assert.equal(promptType, "secret");
  assert.equal(credential.type, "api_key");
  // A new runtime proves the provider persists without extension-owned registration.
  const reopened = await ModelRuntime.create({ modelsPath: path, authPath: join(path, "..", "auth.json"),
    modelsStorePath: join(path, "..", "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  assert.equal(reopened.getModel("local-test", "qwen:7b")?.contextWindow, 32768);
}));

test("stored/runtime credentials cannot silently override a newly entered key or local authentication", async () => inAgentDir(async path => {
  for (const source of ["stored", "runtime"]) {
    for (const key of ["", "fixture-new-key", "$ACME_KEY"]) {
      const h = harness(["acme", "", "https://new.example/v1"], ["openai-completions"], [true], [key]);
      h.ctx.modelRegistry.getProviderAuthStatus = () => ({ configured: true, source });
      await h.commands.get("provider").handler("add", h.ctx);
      await assert.rejects(stat(path), { code: "ENOENT" });
      assert.equal(h.refreshes(), 0);
      assert.match(h.notices.at(-1)!, /credentials that override this choice/);
    }
  }
  await writeFile(path, JSON.stringify({ providers: { acme: {
    api: "openai-completions", baseUrl: "https://old.example/v1", headers: { "X-Key": "$EXTRA" },
  } } }));
  const before = await readFile(path, "utf8");
  const h = harness(["", "https://new.example/v1"], ["acme", "openai-completions"], [false]);
  h.ctx.modelRegistry.getProviderAuthStatus = () => ({ configured: true, source: "stored" });
  await h.commands.get("provider").handler("edit", h.ctx);
  assert.ok(h.prompts.includes("Allow authentication at the new endpoint?"));
  assert.equal(await readFile(path, "utf8"), before);
}));

test("extension authentication and preserved headers cannot silently override local/environment choices", async () => inAgentDir(async path => {
  const runtime = await ModelRuntime.create({ modelsPath: path, authPath: join(path, "..", "auth.json"),
    modelsStorePath: join(path, "..", "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("acme", { api: "openai-completions", baseUrl: "https://old.example/v1", apiKey: "fixture-extension-key",
    models: [{ id: "m", name: "M", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const registry = new ModelRegistry(runtime);
  assert.equal(registry.getProviderAuthStatus("acme").source, "fallback");
  for (const key of ["", "$ACME_KEY", "fixture-new-key"]) {
    const h = harness(["acme", "", "https://new.example/v1"], ["openai-completions"], [true], [key]);
    h.ctx.modelRegistry = registry;
    await h.commands.get("provider").handler("add", h.ctx);
    await assert.rejects(stat(path), { code: "ENOENT" });
    assert.match(h.notices.at(-1)!, /owned by a provider extension/);
  }
  for (const fields of [
    { headers: { Authorization: "Bearer fixture" } },
    { models: [{ id: "m", headers: { "X-Api-Key": "fixture" } }] },
    { modelOverrides: { m: { headers: { Authorization: "Bearer fixture" } } } },
  ]) {
    await writeFile(path, JSON.stringify({ providers: { acme: { api: "openai-completions", baseUrl: "http://localhost/v1", ...fields } } }));
    const before = await readFile(path, "utf8");
    for (const key of ["$ACME_KEY", "fixture-new-key"]) {
      const h = harness(["", "http://localhost/v1"], ["acme", "openai-completions"], [], [key]);
      await h.commands.get("provider").handler("edit", h.ctx);
      assert.equal(await readFile(path, "utf8"), before);
      assert.match(h.notices.at(-1)!, /custom header settings/);
    }
  }
}));

test("an external edit while staging a save is detected before replacement", async () => inAgentDir(async path => {
  const snapshot = await readConfig(path);
  const handle = await open(join(path, "..", "prototype-probe"), "w");
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const sync = prototype.sync;
  const external = JSON.stringify({ providers: { external: { apiKey: "$EXTERNAL" } } });
  prototype.sync = async function() { await sync.call(this); await writeFile(path, external); };
  try {
    await assert.rejects(saveConfig(snapshot, { providers: { ours: {} } }), /changed during save/);
    assert.equal(await readFile(path, "utf8"), external);
    assert.deepEqual((await readdir(join(path, ".."))).filter(name => name.includes(".tmp") || name.endsWith(".lock")), []);
  } finally { prototype.sync = sync; }
}));

test("real Pi model overrides reflect edited limits without losing advanced metadata", async () => inAgentDir(async path => {
  const provider = putModel({ api: "openai-completions", baseUrl: "http://localhost/v1", apiKey: "pi-local",
    modelOverrides: { m: { contextWindow: 1000, maxTokens: 100, compat: { supportsStore: false }, cost: { input: 7 } } },
    models: [{ id: "m", contextWindow: 2000, maxTokens: 200 }],
  }, { id: "m", name: "Edited", contextWindow: 32000, maxTokens: 4096, reasoning: true, input: ["text"] });
  const snapshot = await readConfig(path);
  await saveConfig(snapshot, { providers: { local: provider } });
  const runtime = await ModelRuntime.create({ modelsPath: path, authPath: join(path, "..", "auth.json"),
    modelsStorePath: join(path, "..", "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  const model = runtime.getModel("local", "m")!;
  assert.equal(runtime.getError(), undefined);
  assert.equal(model.contextWindow, 32000);
  assert.equal(model.maxTokens, 4096);
  assert.equal(model.cost.input, 7);
  assert.equal((model.compat as any).supportsStore, false);
}));

test("automatic discovery presents a picker and saves only the selected model", async () => inAgentDir(async path => {
  const requests: string[] = [];
  globalThis.fetch = async (url, options) => {
    requests.push(String(url));
    assert.equal(options?.method, "GET");
    assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer pi-local");
    assert.equal(options?.redirect, "error");
    await assert.rejects(stat(path), { code: "ENOENT" });
    return Response.json({ data: [{ id: "z-model" }, { id: "qwen:7b", name: "Qwen", context_length: 32768, max_output_tokens: 4096 }, { id: "qwen:7b" }] });
  };
  const h = harness(["local-test", "Local Test", "http://localhost:11434/v1"],
    ["openai-completions", "Model: qwen:7b"], [true]);
  await h.commands.get("provider").handler("add", h.ctx);
  assert.deepEqual(requests, ["http://localhost:11434/v1/models"]);
  assert.deepEqual(h.modelChoices, ["Model: qwen:7b", "Model: z-model"]);
  assert.equal(h.prompts.includes("Exact model ID exposed by the server"), false);
  const config = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(config.providers["local-test"].models.map((m: any) => m.id), ["qwen:7b"]);
  assert.equal(config.providers["local-test"].models[0].contextWindow, 32768);
  assert.equal(config.providers["local-test"].models[0].maxTokens, 4096);
  assert.equal(config.providers["local-test"].models[0].name, "Qwen");
  assert.ok(h.prompts.every(prompt => !/Context window|Maximum output|Model display name|reasoning\/thinking|Supported input/.test(prompt)));
}));

test("real picker keys batch models across searches with one discovery and one atomic save", async () => inAgentDir(async path => {
  const original = { providers: { acme: { api: "openai-completions", baseUrl: "http://localhost/v1", apiKey: "pi-local",
    models: [{ id: "old", compat: { supportsStore: false } }, { id: "alpha", cost: { input: 7 }, compat: { supportsStore: false } }],
  } } };
  await writeFile(path, JSON.stringify(original));
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return Response.json({ data: [
      { id: "alpha", name: "Alpha", context_length: 32000, max_output_tokens: 4096 },
      { id: "beta", name: "Beta" }, { id: "gamma", context_length: 16000 },
    ] });
  };
  const h = harness(["48000"], ["acme"], [true]);
  h.ctx.ui.custom = async (factory: any) => {
    let result: unknown;
    const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
    const component = factory({ requestRender() {}, terminal: { rows: 24 } }, theme, {}, (value: unknown) => { result = value; });
    assert.ok(component instanceof ProviderModelPicker);
    component.focused = true;
    component.handleInput(" ");
    for (const char of "Beta") component.handleInput(char);
    component.handleInput(" ");
    assert.match(component.render(80).join("\n"), /2 selected/);
    component.handleInput("\r");
    assert.deepEqual(result, { ids: ["alpha", "beta"] });
    return result;
  };
  const confirm = h.ctx.ui.confirm;
  h.ctx.ui.confirm = async (...args: any[]) => {
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), original);
    return confirm(...args);
  };
  await h.commands.get("provider").handler("model", h.ctx);
  const saved = JSON.parse(await readFile(path, "utf8")).providers.acme.models;
  assert.equal(requests, 1);
  assert.equal(h.refreshes(), 1);
  assert.deepEqual(saved.map((model: any) => model.id), ["old", "alpha", "beta"]);
  assert.deepEqual(saved[0], original.providers.acme.models[0]);
  assert.deepEqual(saved[1].compat, { supportsStore: false });
  assert.deepEqual(saved[1].cost, { input: 7 });
  assert.equal(saved[2].contextWindow, 48000);
  assert.equal(h.prompts.filter(prompt => prompt.startsWith("Server did not report a context window for beta")).length, 1);
}));

test("cancelling a later model or rejecting a batch save leaves every existing model unchanged", async () => inAgentDir(async path => {
  const before = JSON.stringify({ providers: { acme: { api: "openai-completions", baseUrl: "http://localhost/v1", apiKey: "pi-local", models: [{ id: "old" }] } } });
  await writeFile(path, before);
  globalThis.fetch = async () => Response.json({ data: [{ id: "alpha", context_length: 32000 }, { id: "beta" }] });
  for (const inputs of [[undefined], ["48000"]]) {
    const h = harness(inputs, ["acme", ["alpha", "beta"]], [false]);
    await h.commands.get("provider").handler("model", h.ctx);
    assert.equal(await readFile(path, "utf8"), before);
    assert.equal(h.refreshes(), 0);
    assert.match(h.notices.at(-1)!, /cancelled/);
  }
}));

test("manual entry remains available even when discovery succeeds; cancelling picker saves nothing", async () => inAgentDir(async path => {
  globalThis.fetch = async () => Response.json({ data: [{ id: "discovered" }] });
  const h = harness(["local-test", "", "http://localhost/v1", "manual-model", "", "32768", "4096"],
    ["openai-completions", "Enter model ID manually", "No", "Text"], [true]);
  await h.commands.get("provider").handler("add", h.ctx);
  assert.equal(JSON.parse(await readFile(path, "utf8")).providers["local-test"].models[0].id, "manual-model");
  await rm(path);
  const cancel = harness(["local-test", "", "http://localhost/v1"], ["openai-completions", undefined]);
  await cancel.commands.get("provider").handler("add", cancel.ctx);
  assert.match(cancel.notices.at(-1)!, /cancelled/);
  await assert.rejects(stat(path), { code: "ENOENT" });
}));

test("missing, empty, malformed, unauthorized and failed listings all fall back without leaking payloads", async () => inAgentDir(async path => {
  const failures = [
    () => new Response("fixture-sensitive-server-body", { status: 404 }),
    () => new Response("fixture-sensitive-server-body", { status: 401 }),
    () => new Response("fixture-sensitive-server-body", { status: 500 }),
    () => Response.json({ data: [] }),
    () => Response.json({ unrelated: "fixture-sensitive-server-body" }),
    () => new Response("not JSON fixture-sensitive-server-body"),
    () => { throw new Error("fixture-sensitive-server-body"); },
  ];
  for (const response of failures) {
    globalThis.fetch = async () => response();
    const h = localSetup();
    await h.commands.get("provider").handler("add", h.ctx);
    assert.ok(h.prompts.includes("Exact model ID exposed by the server"));
    assert.equal(JSON.parse(await readFile(path, "utf8")).providers["local-test"].models[0].id, "qwen:7b");
    assert.ok(h.notices.some(notice => notice.includes("Enter the model ID manually")));
    assert.ok(h.notices.every(notice => !notice.includes("fixture-sensitive-server-body")));
    await rm(path);
  }
}));

test("endpoint trust is required before credential resolution or any discovery request", async () => inAgentDir(async path => {
  let resolutions = 0;
  let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json({ data: [{ id: "m" }] }); };
  await writeFile(path, JSON.stringify({ providers: { acme: { api: "openai-completions", baseUrl: "https://old.example/v1" } } }));
  const before = await readFile(path, "utf8");
  const h = harness(["", "https://new.example/v1"], ["acme", "openai-completions"], [false]);
  h.ctx.modelRegistry.getProviderAuthStatus = () => ({ configured: true, source: "stored" });
  h.ctx.modelRegistry.getProvider = () => ({ auth: {} });
  h.ctx.modelRegistry.getProviderAuth = async () => { resolutions++; return { auth: { apiKey: "fixture" } }; };
  await h.commands.get("provider").handler("edit", h.ctx);
  assert.ok(h.prompts.includes("Allow authentication at the new endpoint?"));
  assert.equal(resolutions, 0);
  assert.equal(requests, 0);
  assert.equal(await readFile(path, "utf8"), before);
}));

test("environment-auth discovery uses the key in memory and persists only the variable reference", async () => inAgentDir(async path => {
  const previous = process.env.PI_DISCOVERY_FIXTURE_KEY;
  process.env.PI_DISCOVERY_FIXTURE_KEY = "fixture-in-memory-key";
  try {
    let requests = 0;
    globalThis.fetch = async (_url, options) => {
      requests++;
      assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer fixture-in-memory-key");
      return Response.json({ data: [{ id: "m" }] });
    };
    const h = harness(["acme", "Acme", "https://example.com/v1", "128000"],
      ["openai-responses", "Model: m"], [true], ["$PI_DISCOVERY_FIXTURE_KEY"]);
    await h.commands.get("provider").handler("add", h.ctx);
    const saved = await readFile(path, "utf8");
    assert.equal(requests, 1);
    assert.equal(JSON.parse(saved).providers.acme.apiKey, "$PI_DISCOVERY_FIXTURE_KEY");
    assert.ok(!saved.includes("fixture-in-memory-key"));
    assert.ok(h.notices.every(notice => !notice.includes("fixture-in-memory-key")));
  } finally {
    if (previous === undefined) delete process.env.PI_DISCOVERY_FIXTURE_KEY;
    else process.env.PI_DISCOVERY_FIXTURE_KEY = previous;
  }
}));

test("saved providers discover models using native Pi runtime credentials on /provider model", async () => inAgentDir(async path => {
  await writeFile(path, JSON.stringify({ providers: { acme: { api: "openai-completions", baseUrl: "http://localhost/v1", models: [{ id: "old" }] } } }));
  const runtime = await ModelRuntime.create({ modelsPath: path, authPath: join(path, "..", "auth.json"),
    modelsStorePath: join(path, "..", "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  await runtime.setRuntimeApiKey("acme", "fixture-runtime-key");
  let requests = 0;
  globalThis.fetch = async (_url, options) => {
    requests++;
    assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer fixture-runtime-key");
    return Response.json({ data: [{ id: "new-model" }] });
  };
  const h = harness(["32768"], ["acme", "Model: new-model"], [true]);
  h.ctx.modelRegistry = new ModelRegistry(runtime);
  await h.commands.get("provider").handler("model", h.ctx);
  assert.equal(requests, 1);
  assert.ok(runtime.getModel("acme", "new-model"));
  assert.ok(runtime.getModel("acme", "old"));
  assert.ok(!(await readFile(path, "utf8")).includes("fixture-runtime-key"));
}));

test("offline and unsupported APIs fall back without making requests", async () => inAgentDir(async path => {
  const previous = process.env.PI_OFFLINE;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("must not fetch"); };
  try {
    process.env.PI_OFFLINE = "1";
    const h = localSetup();
    await h.commands.get("provider").handler("add", h.ctx);
    assert.equal(requests, 0);
    assert.ok(h.notices.some(notice => notice.includes("offline")));
    delete process.env.PI_OFFLINE;
    await writeFile(path, JSON.stringify({ providers: { acme: { api: "unsupported", models: [{ id: "old" }] } } }));
    const h2 = harness(["manual", "", "32768", "4096"], ["acme", "No", "Text"], [true]);
    await h2.commands.get("provider").handler("model", h2.ctx);
    assert.equal(requests, 0);
    assert.equal(JSON.parse(await readFile(path, "utf8")).providers.acme.models[1].id, "manual");
  } finally {
    if (previous === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previous;
  }
}));

test("fetched limits override stale modelOverrides without manual capability prompts", async () => inAgentDir(async path => {
  await writeFile(path, JSON.stringify({ providers: { acme: { name: "Acme", api: "openai-completions", baseUrl: "http://localhost/v1", apiKey: "pi-local",
    models: [{ id: "m", contextWindow: 1000, maxTokens: 100, compat: { supportsStore: false } }],
    modelOverrides: { m: { contextWindow: 2000, maxTokens: 200, reasoning: true, cost: { input: 7 } } },
  } } }));
  globalThis.fetch = async () => Response.json({ data: [{ id: "m", context_length: 65536, max_output_tokens: 4096, reasoning: false, input: ["text", "image"] }] });
  const h = harness([], ["acme", "Model: m"], [true]);
  await h.commands.get("provider").handler("model", h.ctx);
  const runtime = await ModelRuntime.create({ modelsPath: path, authPath: join(path, "..", "auth.json"),
    modelsStorePath: join(path, "..", "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  const model = runtime.getModel("acme", "m")!;
  assert.equal(runtime.getError(), undefined);
  assert.equal(model.contextWindow, 65536);
  assert.equal(model.maxTokens, 4096);
  assert.equal(model.reasoning, false);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.cost.input, 7);
  assert.equal((model.compat as any).supportsStore, false);
  assert.ok(!h.prompts.some(prompt => /context window|Maximum output|Supported input|Model display name/i.test(prompt)));
}));

test("a fetched ID without context asks only for the missing limit and never invents a context window", async () => inAgentDir(async path => {
  globalThis.fetch = async () => Response.json({ data: [{ id: "m" }] });
  const h = harness(["acme", "", "http://localhost/v1", "", "-1", "4096"], ["openai-completions", "Model: m"], [true]);
  await h.commands.get("provider").handler("add", h.ctx);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.providers.acme.models[0].contextWindow, 4096);
  assert.equal(saved.providers.acme.models[0].maxTokens, 4096);
  assert.equal(h.prompts.filter(prompt => prompt.startsWith("Server did not report a context window")).length, 3);
  assert.ok(h.prompts.every(prompt => !/Maximum output|Model display name|Supported input/.test(prompt)));
  assert.ok(h.notices.some(notice => notice.includes("Using 4096 tokens")));
}));

test("invalid fetched output limits are bounded and reported without another form", async () => inAgentDir(async path => {
  globalThis.fetch = async () => Response.json({ data: [{ id: "m", context_length: 16000, max_output_tokens: 32000 }] });
  const h = harness(["acme", "", "http://localhost/v1"], ["openai-completions", "Model: m"], [true]);
  await h.commands.get("provider").handler("add", h.ctx);
  assert.equal(JSON.parse(await readFile(path, "utf8")).providers.acme.models[0].maxTokens, 8192);
  assert.ok(h.notices.some(notice => notice.includes("Server did not report a usable output limit")));
}));

test("entered literal key is used for discovery immediately, but final rejection stores nothing", async () => inAgentDir(async path => {
  let requests = 0;
  const key = "!fixture$LITERAL";
  globalThis.fetch = async (_url, options) => {
    requests++;
    assert.equal(new Headers(options?.headers).get("Authorization"), `Bearer ${key}`);
    await assert.rejects(stat(path), { code: "ENOENT" });
    return Response.json({ data: [{ id: "m", context_length: 32000, max_output_tokens: 4096 }] });
  };
  const h = harness(["acme", "Acme", "http://localhost/v1"], ["openai-completions", "Model: m"], [false], [key]);
  await h.commands.get("provider").handler("add", h.ctx);
  assert.equal(requests, 1);
  assert.match(h.notices.at(-1)!, /cancelled/);
  assert.ok(h.notices.every(notice => !notice.includes(key)));
  await assert.rejects(stat(path), { code: "ENOENT" });
}));

test("RPC accepts an environment variable rather than an unmasked key", async () => inAgentDir(async path => {
  const h = harness(["acme", "Acme RPC", "ACME_RPC_KEY", "http://localhost/v1", "m", "", "32000", "4096"],
    ["openai-completions", "No", "Text"], [true]);
  h.ctx.mode = "rpc";
  h.ctx.ui.custom = async () => { throw new Error("RPC must not open a masked TUI component"); };
  await h.commands.get("provider").handler("add", h.ctx);
  assert.equal(JSON.parse(await readFile(path, "utf8")).providers.acme.apiKey, "$ACME_RPC_KEY");
}));

test("noninteractive, busy, built-in collision, invalid commands and failed refresh are honest", async () => inAgentDir(async path => {
  const h = localSetup();
  h.ctx.hasUI = false;
  await h.commands.get("provider").handler("add", h.ctx);
  h.ctx.hasUI = true;
  h.ctx.isIdle = () => false;
  await h.commands.get("provider").handler("add", h.ctx);
  h.ctx.isIdle = () => true;
  await h.commands.get("provider").handler("bad", h.ctx);
  await assert.rejects(stat(path), { code: "ENOENT" });
  const collision = localSetup(false);
  collision.ctx.modelRegistry.getAll = () => [{ provider: "local-test" }];
  await collision.commands.get("provider").handler("add", collision.ctx);
  await assert.rejects(stat(path), { code: "ENOENT" });
  const refresh = localSetup();
  refresh.ctx.modelRegistry.refresh = async () => { throw new Error("sensitive server payload"); };
  await refresh.commands.get("provider").handler("add", refresh.ctx);
  assert.ok(await stat(path));
  assert.match(refresh.notices.at(-1)!, /was saved.*could not refresh/);
  assert.ok(refresh.notices.every(notice => !notice.includes("sensitive server payload")));
}));

test("/provider account migrates single provider to Account 1 and adds Account 2 with inherited models", async () => inAgentDir(async path => {
  // Pre-seed models.json with a single provider "deepseek"
  await writeFile(path, JSON.stringify({
    providers: {
      deepseek: {
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        api: "openai-completions",
        apiKey: "sk-key-1",
        models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
      },
    },
  }, null, 2));

  // Run /provider account
  // Inputs:
  // 1. Account display name: "DeepSeek (Account 2)"
  // Choices:
  // 1. Select provider: "deepseek (1 configured account: deepseek)"
  // Confirms:
  // 1. Save account deepseek-2: true
  // Keys:
  // 1. Masked API key: "sk-key-2"
  const h = harness(
    ["DeepSeek (Account 2)"],
    ["deepseek (1 configured account: deepseek)"],
    [true],
    ["sk-key-2"],
  );

  await h.commands.get("provider").handler("account", h.ctx);

  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.providers.deepseek, undefined, "Original unslotted provider migrated");
  assert.ok(saved.providers["deepseek-1"], "Migrated to deepseek-1");
  assert.equal(saved.providers["deepseek-1"].name, "DeepSeek (Account 1)");
  assert.equal(saved.providers["deepseek-1"].apiKey, "sk-key-1");
  assert.equal(saved.providers["deepseek-1"].baseUrl, "https://api.deepseek.com/v1");
  assert.deepEqual(saved.providers["deepseek-1"].models, [{ id: "deepseek-chat", name: "DeepSeek Chat" }]);

  assert.ok(saved.providers["deepseek-2"], "Created deepseek-2");
  assert.equal(saved.providers["deepseek-2"].name, "DeepSeek (Account 2)");
  assert.equal(saved.providers["deepseek-2"].apiKey, "sk-key-2");
  assert.equal(saved.providers["deepseek-2"].baseUrl, "https://api.deepseek.com/v1");
  assert.equal(saved.providers["deepseek-2"].api, "openai-completions");
  assert.deepEqual(saved.providers["deepseek-2"].models, [{ id: "deepseek-chat", name: "DeepSeek Chat" }]);

  assert.equal(h.refreshes(), 1);
  assert.ok(h.notices.some(n => n.includes("Saved deepseek-2") && n.includes("Migrated base provider to Account 1")));
}));

test("/provider account adds subsequent accounts in sequence without re-prompting connection", async () => inAgentDir(async path => {
  // Pre-seed with deepseek-1 and deepseek-2
  await writeFile(path, JSON.stringify({
    providers: {
      "deepseek-1": {
        name: "DeepSeek (Account 1)",
        baseUrl: "https://api.deepseek.com/v1",
        api: "openai-completions",
        apiKey: "sk-key-1",
        models: [{ id: "deepseek-chat" }],
      },
      "deepseek-2": {
        name: "DeepSeek (Account 2)",
        baseUrl: "https://api.deepseek.com/v1",
        api: "openai-completions",
        apiKey: "sk-key-2",
        models: [{ id: "deepseek-chat" }],
      },
    },
  }, null, 2));

  // Add 3rd account
  const h = harness(
    ["DeepSeek (Account 3)"],
    ["deepseek (2 configured accounts: deepseek-1, deepseek-2)"],
    [true],
    ["sk-key-3"],
  );

  await h.commands.get("provider").handler("account", h.ctx);

  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.ok(saved.providers["deepseek-1"]);
  assert.ok(saved.providers["deepseek-2"]);
  assert.ok(saved.providers["deepseek-3"]);
  assert.equal(saved.providers["deepseek-3"].name, "DeepSeek (Account 3)");
  assert.equal(saved.providers["deepseek-3"].apiKey, "sk-key-3");
  assert.equal(saved.providers["deepseek-3"].baseUrl, "https://api.deepseek.com/v1");
  assert.deepEqual(saved.providers["deepseek-3"].models, [{ id: "deepseek-chat" }]);
}));

test("/provider list groups multi-account families and displays counts", async () => inAgentDir(async path => {
  await writeFile(path, JSON.stringify({
    providers: {
      "deepseek-1": { name: "DeepSeek (Account 1)", models: [{ id: "m1" }] },
      "deepseek-2": { name: "DeepSeek (Account 2)", models: [{ id: "m1" }, { id: "m2" }] },
      ollama: { name: "Local Ollama", models: [{ id: "llama" }] },
    },
  }, null, 2));

  const h = harness([], []);
  await h.commands.get("provider").handler("list", h.ctx);

  assert.ok(h.notices.some(n =>
    n.includes("deepseek (2 accounts):") &&
    n.includes("deepseek-1") &&
    n.includes("deepseek-2") &&
    n.includes("Local Ollama (ollama) — 1 configured model(s)"),
  ));
}));

test("/provider model offers to sync updated models to other accounts in the family", async () => inAgentDir(async path => {
  await writeFile(path, JSON.stringify({
    providers: {
      "deepseek-1": {
        name: "DeepSeek (Account 1)",
        baseUrl: "https://api.deepseek.com/v1",
        api: "openai-completions",
        apiKey: "sk-key-1",
        models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
      },
      "deepseek-2": {
        name: "DeepSeek (Account 2)",
        baseUrl: "https://api.deepseek.com/v1",
        api: "openai-completions",
        apiKey: "sk-key-2",
        models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
      },
    },
  }, null, 2));

  // /provider model on deepseek-1
  // Inputs: model ID "deepseek-reasoner", display name "DeepSeek Reasoner", context "64000", max "8192"
  // Choices: pick provider "deepseek-1", reasoning "Yes", input "Text"
  // Confirms: sync models to deepseek-2 (true), save provider deepseek-1 (true)
  const h = harness(
    ["deepseek-reasoner", "DeepSeek Reasoner", "64000", "8192"],
    ["deepseek-1", "Yes", "Text"],
    [true, true],
  );

  await h.commands.get("provider").handler("model", h.ctx);

  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.providers["deepseek-1"].models.length, 2);
  assert.equal(saved.providers["deepseek-2"].models.length, 2, "deepseek-2 was synchronized");
  assert.equal(saved.providers["deepseek-2"].models[1].id, "deepseek-reasoner");
}));


// ── The TUI editor ───────────────────────────────────────────────────────────

/** A ctx whose `ui.custom` drives the popup with a script, one script per open. */
function editor(scripts: Array<(component: any) => void>) {
  const commands = new Map<string, any>();
  providers({ registerCommand: (name: string, command: any) => commands.set(name, command) } as any);
  const notices: string[] = [];
  let opens = 0;
  let refreshes = 0;
  const ctx: any = {
    hasUI: true, mode: "tui", isIdle: () => true,
    ui: {
      custom: async (factory: any) => new Promise(resolve => {
        opens++;
        const component = factory(
          { requestRender() {}, terminal: { rows: 32 } },
          { fg: (_color: string, text: string) => text },
          {},
          resolve,
        );
        component.focused = true;
        const script = scripts.shift();
        if (script) script(component);
        else resolve({ kind: "close" });
      }),
      input: async () => undefined,
      select: async () => undefined,
      confirm: async () => false,
      notify: (message: string) => notices.push(message),
    },
    modelRegistry: {
      getAll: () => [], getError: () => undefined, getProviderAuthStatus: () => ({ configured: false }),
      getRegisteredProviderIds: () => [], refresh: async () => { refreshes++; },
    },
  };
  return { commands, ctx, notices, opens: () => opens, refreshes: () => refreshes };
}

const typeInto = (component: any, text: string) => { for (const char of text) component.handleInput(char); };
/** After a save the editor reopens on that provider, so closing is two Escapes. */
const closeEditor = (component: any) => {
  component.handleInput(ESCAPE);
  component.handleInput(ESCAPE);
};
const ENTER = "\r";
const ESCAPE = "\x1b";

test("bare /provider in the TUI walks the wizard and writes the provider", async () => inAgentDir(async path => {
  const h = editor([
    (component) => {
      component.handleInput("a");
      typeInto(component, "acme-local");
      component.handleInput(ENTER);   // id
      component.handleInput(ENTER);   // name, defaulted from the id
      component.handleInput(ENTER);   // api: openai-completions
      typeInto(component, "http://localhost:11434/v1");
      component.handleInput(ENTER);   // base URL
      typeInto(component, "$LOCAL_KEY");
      component.handleInput(ENTER);   // key -> save
    },
    closeEditor,
  ]);

  await h.commands.get("provider").handler("", h.ctx);

  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.providers["acme-local"].name, "acme-local");
  assert.equal(saved.providers["acme-local"].baseUrl, "http://localhost:11434/v1");
  assert.equal(saved.providers["acme-local"].apiKey, "$LOCAL_KEY", "an environment reference is stored unresolved");
  assert.equal(saved.providers["acme-local"].models, undefined,
    "a connection with no models yet writes no models array; the editor's Add models step fills it");
  assert.equal(h.refreshes(), 1, "Pi reloaded the configuration once, without network");
  assert.equal(h.opens(), 2, "the editor reopens after a save so the next step is one keypress away");
}));

test("Esc in the editor writes nothing at all", async () => inAgentDir(async path => {
  const h = editor([closeEditor]);
  await h.commands.get("provider").handler("", h.ctx);
  await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" }, "a closed editor never creates models.json");
  assert.equal(h.refreshes(), 0);
}));

test("adding an account migrates the lone provider and inherits its models, not its key", async () => inAgentDir(async path => {
  await writeFile(path, JSON.stringify({ providers: {
    acme: {
      name: "Acme", api: "openai-completions", baseUrl: "https://api.acme.com/v1", apiKey: "$ACME_KEY",
      models: [{ id: "acme-large", contextWindow: 128000, maxTokens: 8192 }],
    },
  } }));

  const h = editor([
    (component) => {
      component.handleInput(ENTER);   // open acme
      component.handleInput("4");     // Add an account…
      component.handleInput(ENTER);   // name: "Acme (Account 2)"
      component.handleInput(ENTER);   // api (current)
      component.handleInput(ENTER);   // base URL (kept)
      typeInto(component, "$ACME_KEY_2");
      component.handleInput(ENTER);   // key -> save
    },
    closeEditor,
  ]);

  await h.commands.get("provider").handler("", h.ctx);

  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(Object.keys(saved.providers).sort(), ["acme-1", "acme-2"]);
  assert.equal(saved.providers["acme-1"].name, "Acme (Account 1)");
  assert.equal(saved.providers["acme-1"].apiKey, "$ACME_KEY", "the first account keeps its credential");
  assert.equal(saved.providers["acme-2"].apiKey, "$ACME_KEY_2");
  assert.deepEqual(saved.providers["acme-2"].models, saved.providers["acme-1"].models,
    "both accounts speak to the same service, so the model list is shared");
}));

test("deleting from the editor removes only that entry", async () => inAgentDir(async path => {
  await writeFile(path, JSON.stringify({ providers: {
    acme: { name: "Acme", api: "openai-completions", baseUrl: "https://api.acme.com/v1", apiKey: "$ACME_KEY" },
    other: { name: "Other", api: "openai-completions", baseUrl: "https://other.example/v1", apiKey: "$OTHER" },
  } }));

  const h = editor([
    (component) => {
      component.handleInput(ENTER);   // open acme
      component.handleInput("d");     // delete
      component.handleInput(ENTER);   // confirm
    },
    closeEditor,
  ]);

  await h.commands.get("provider").handler("", h.ctx);

  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(Object.keys(saved.providers), ["other"], "other providers are untouched");
}));
