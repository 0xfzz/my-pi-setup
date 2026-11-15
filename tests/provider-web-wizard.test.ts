import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

/** Listen on an ephemeral loopback port; discovery tests must not race for one. */
function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(() => resolve());
    server.once("error", reject);
  });
}

/**
 * The provider wizard on the web: one dialog step at a time.
 *
 * The model picker's "+ Add models" entry dispatches the `provider` web
 * command, the extension publishes the first step, and each answer comes back
 * through the action pipeline — so the draft has to survive between two
 * dialogs. These tests drive the real extension that way: no browser, no
 * terminal, just the command, the action events and models.json on disk.
 */

const VIEW_EVENT = "web-plugin:view";
const ACTION_EVENT = "web-plugin:action-request";
const WEB_COMMAND_EVENT = "web-plugin:web-command";

interface Harness {
  /** Every published view for the providers plugin, in order. */
  views: Array<Record<string, unknown>>;
  signals: { modelChanges: number };
  /** Publish the wizard's first step. */
  start(): Promise<void>;
  /** Wait until a view with this dialog id has been published. */
  awaitView(id: string): Promise<void>;
  /** Answer the current step. */
  submit(value: string): Promise<void>;
  manage(label: string, values?: Record<string, string>): Promise<void>;
  add(): Promise<void>;
  back(): Promise<void>;
  cancel(): Promise<void>;
  lastView(): Record<string, unknown>;
  models(): Promise<Record<string, unknown>>;
}

let dir: string;

async function makeHarness(models: unknown = { providers: {} }): Promise<Harness> {
  dir = await mkdtemp(join(tmpdir(), "pi-provider-web-"));
  await writeFile(join(dir, "models.json"), JSON.stringify(models), "utf8");
  process.env.PI_CODING_AGENT_DIR = dir;

  const views: Array<Record<string, unknown>> = [];
  const signals = { modelChanges: 0 };
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const mockPi = {
    registerCommand: () => undefined,
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
    },
    getCommands: () => [],
    events: {
      emit: (channel: string, data: unknown) => {
        if (channel === "web-plugin:models-changed") signals.modelChanges += 1;
        if (channel === VIEW_EVENT) {
          const payload = data as { pluginId?: string; view?: Record<string, unknown> };
          if (payload.pluginId === "providers" && payload.view !== undefined) views.push(payload.view);
        }
        for (const listener of listeners.get(channel) ?? []) listener(data);
      },
      on: (channel: string, handler: (data: unknown) => void) => {
        const list = listeners.get(channel) ?? [];
        list.push(handler);
        listeners.set(channel, list);
        return () => {
          listeners.set(channel, (listeners.get(channel) ?? []).filter((entry) => entry !== handler));
        };
      },
    },
    setModel: async () => true,
    setThinkingLevel: () => undefined,
  };
  const ctx = {
    cwd: dir,
    hasUI: false,
    isIdle: () => true,
    modelRegistry: {
      refresh: async () => undefined,
      getError: () => undefined,
      getAvailable: () => [],
      getAll: () => [],
      getRegisteredProviderIds: () => [],
      getProviderAuthStatus: () => ({ configured: false }),
    },
    sessionManager: { getSessionId: () => "provider-web-test", getSessionFile: () => undefined },
    ui: { notify: () => undefined, setStatus: () => undefined },
  };

  const { default: providers } = await import("../extensions/providers.ts");
  providers(mockPi as never);
  // The extension announces its web command at session start; the bridge (or
  // the in-process host) lists it and asks for it back by name to run it.
  const onSessionStart = handlers.get("session_start");
  assert.ok(onSessionStart !== undefined, "the extension registers session_start");
  onSessionStart({ type: "session_start", reason: "new" }, ctx);

  // The extension's handlers are async and write to disk, so a step is done
  // when it publishes — polled, never a fixed sleep.
  const waitForView = async (count: number): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (views.length <= count) {
      if (Date.now() > deadline) throw new Error("the wizard published no step");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const awaitView = async (id: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!views.some((view) => view.id === id)) {
      if (Date.now() > deadline) throw new Error(`no view with id ${id} was published`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const act = async (actionId: string, values?: Record<string, string>, confirm?: string): Promise<void> => {
    const before = views.length;
    mockPi.events.emit(ACTION_EVENT, {
      requestId: `req-${actionId}`,
      sessionId: "provider-web-test",
      pluginId: "providers",
      actionId,
      ...(confirm !== undefined ? { confirm } : {}),
      ...(values !== undefined ? { values } : {}),
    });
    await waitForView(before);
  };

  return {
    views,
    signals,
    awaitView,
    async start() {
      // The bridge asks for the announced command by name; the extension runs
      // it on the context it captured at session start.
      const before = views.length;
      mockPi.events.emit(WEB_COMMAND_EVENT, { name: "provider", args: "" });
      await waitForView(before);
    },
    submit: (value) => act("provider-next", { value }),
    manage: (label, values) => act("provider-manage", values, label),
    add: () => act("provider-add"),
    back: () => act("provider-back"),
    cancel: () => act("provider-cancel"),
    lastView: () => views.at(-1) ?? {},
    async models() {
      return JSON.parse(await readFile(join(dir, "models.json"), "utf8")) as Record<string, unknown>;
    },
  };
}

function fieldOf(view: Record<string, unknown>): Record<string, unknown> {
  const fields = view.fields as Array<Record<string, unknown>> | undefined;
  assert.ok(fields?.[0], "a step publishes one field");
  return fields[0]!;
}

function linesOf(view: Record<string, unknown>): string[] {
  return (view.lines as string[] | undefined) ?? [];
}

test("the wizard adds a new provider and its first model", async () => {
  const harness = await makeHarness();
  await harness.start();

  assert.equal(harness.lastView().title, "Providers");
  assert.equal(harness.lastView().fields, undefined, "the first page is a list, not a wizard menu");
  await harness.add();

  // Every step after that, in order: the label the dialog shows and the answer.
  const answers: Array<[string, string]> = [
    ["Provider ID", "acme"],
    ["Display name", "Acme"],
    ["API protocol", "openai-completions"],
    ["Base URL", "https://api.acme.test/v1"],
    ["API key", ""],
    ["Model ID", "gpt-6"],
    ["Model display name", ""],
    ["Context window (tokens)", "128000"],
    ["Maximum output tokens", "8192"],
    ["Reasoning / thinking support", "No"],
    ["Supported input", "Text"],
  ];
  for (const [label, value] of answers) {
    assert.equal(fieldOf(harness.lastView()).name, "value", "each step publishes one field");
    assert.equal(fieldOf(harness.lastView()).label, label);
    await harness.submit(value);
  }

  const config = await harness.models();
  const acme = (config.providers as Record<string, Record<string, unknown>>).acme;
  assert.ok(acme, "the provider is written to models.json");
  assert.equal(acme.api, "openai-completions");
  assert.equal(acme.baseUrl, "https://api.acme.test/v1");
  assert.equal(acme.apiKey, "pi-local", "a blank key means a local server");
  const models = acme.models as Array<Record<string, unknown>>;
  assert.deepEqual(models[0], {
    id: "gpt-6",
    name: "gpt-6",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  assert.equal(harness.lastView().id, "provider-wizard:saved", "the wizard reports what it saved");
});

test("a refused value keeps the same step and says why", async () => {
  const harness = await makeHarness();
  await harness.start();
  const firstStep = harness.lastView().id;

  await harness.submit("Bad Id");

  assert.equal(harness.lastView().id, firstStep, "the same dialog id, so the typed text is kept");
  assert.ok(
    linesOf(harness.lastView()).some((line) => line.startsWith("Problem: ")),
    "the refusal is shown where the answer was",
  );
  // Nothing was written.
  assert.deepEqual(await harness.models(), { providers: {} });
});

test("a typed key is never re-published, and survives going back", async () => {
  const harness = await makeHarness();
  await harness.start();
  await harness.submit("Add a new provider…");
  await harness.submit("acme");
  await harness.submit("Acme");
  await harness.submit("openai-completions");
  await harness.submit("https://api.acme.test/v1");
  // The API key step: a masked field may not carry a value (a credential in a
  // view would ride the event stream to the browser).
  assert.equal(fieldOf(harness.lastView()).kind, "secret");
  assert.equal(fieldOf(harness.lastView()).value, undefined);
  await harness.submit("$ACME_API_KEY");

  // Walk back over it: the value is still not published…
  await harness.back();
  assert.equal(fieldOf(harness.lastView()).kind, "secret");
  assert.equal(fieldOf(harness.lastView()).value, undefined);
  // …and pressing Continue without retyping keeps the key already given.
  await harness.submit("");

  for (const value of ["gpt-6", "", "128000", "8192", "No", "Text"]) {
    await harness.submit(value);
  }
  const config = await harness.models();
  const acme = (config.providers as Record<string, Record<string, unknown>>).acme!;
  assert.equal(acme.apiKey, "$ACME_API_KEY", "the typed reference is what was saved");
});

test("a model is appended to an existing provider, keeping its connection", async () => {
  const harness = await makeHarness({
    providers: {
      openrouter: { name: "OpenRouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", apiKey: "$OPENROUTER_KEY" },
    },
  });
  await harness.start();
  await harness.submit("List available providers");

  // The provider menu, with the existing provider and the new-provider escape.
  const menu = fieldOf(harness.lastView());
  assert.equal(menu.kind, "select");
  assert.deepEqual(menu.choices, ["openrouter", "+ New provider…"]);

  await harness.submit("openrouter");
  assert.equal(fieldOf(harness.lastView()).label, "Model ID");

  for (const value of ["claude-x", "", "200000", "8192", "Yes"]) {
    await harness.submit(value);
  }
  await harness.submit("Text + images");

  const config = await harness.models();
  const openrouter = (config.providers as Record<string, Record<string, unknown>>).openrouter!;
  assert.equal(openrouter.apiKey, "$OPENROUTER_KEY", "the existing credential is untouched");
  const models = openrouter.models as Array<Record<string, unknown>>;
  assert.equal(models.length, 1);
  assert.equal(models[0]!.id, "claude-x");
  assert.equal(models[0]!.reasoning, true);
  assert.deepEqual(models[0]!.input, ["text", "image"]);
});

test("the new-provider entry switches the wizard to the connection steps", async () => {
  const harness = await makeHarness({
    providers: { openrouter: { name: "OpenRouter", api: "openai-completions", baseUrl: "https://x/v1" } },
  });
  await harness.start();
  await harness.submit("List available providers");
  await harness.submit("+ New provider…");
  assert.equal(fieldOf(harness.lastView()).label, "Provider ID");
});

test("back returns to the previous step with the answer intact", async () => {
  const harness = await makeHarness();
  await harness.start();
  await harness.submit("Add a new provider…");
  await harness.submit("acme");
  assert.equal(fieldOf(harness.lastView()).label, "Display name");

  await harness.back();
  const step = fieldOf(harness.lastView());
  assert.equal(step.label, "Provider ID");
  assert.equal(step.value, "acme", "the answer is still there");

  // One more back reaches the home screen, not nothing.
  await harness.back();
  assert.equal(harness.lastView().id, "provider-wizard:home");
  assert.equal(harness.lastView().fields, undefined);
});

test("the provider page lists all configured providers and owns its top-right Add action", async () => {
  const harness = await makeHarness({ providers: {
    zeta: { name: "Zeta", apiKey: "fixture-secret" },
    acme: { name: "Acme", models: [{ id: "model-a" }] },
  } });
  await harness.start();
  const items = harness.lastView().items as Array<Record<string, unknown>>;
  assert.deepEqual(items.map((item) => item.label).sort(), ["Acme (acme)", "Zeta (zeta)"]);
  assert.deepEqual(items.find((item) => item.id === "acme")?.values, { providerId: "acme" });
  assert.equal(harness.lastView().fields, undefined);
  assert.ok(!JSON.stringify(harness.lastView()).includes("fixture-secret"));
  const actions = harness.lastView().actions as Array<Record<string, unknown>>;
  assert.deepEqual(actions[0], { id: "provider-add", label: "Add provider", tone: "primary", placement: "header" });
  await harness.add();
  assert.equal(fieldOf(harness.lastView()).label, "Provider ID");
  await harness.cancel();
  assert.equal(harness.lastView().id, "provider-wizard:home", "cancel returns to the provider list");
});

test("the empty provider page offers Add provider without a redundant choice screen", async () => {
  const harness = await makeHarness();
  await harness.start();
  assert.match(linesOf(harness.lastView()).join(" "), /No providers configured/);
  await harness.add();
  assert.equal(fieldOf(harness.lastView()).label, "Provider ID");
});

test("cancelling returns to the list and writes nothing", async () => {
  const harness = await makeHarness();
  await harness.start();
  await harness.submit("Add a new provider…");
  await harness.submit("acme");
  await harness.cancel();

  assert.equal(harness.lastView().id, "provider-wizard:home");
  await harness.cancel();
  assert.equal(harness.lastView().open, false, "closing the list returns to Models");
  assert.deepEqual(await harness.models(), { providers: {} });
});

test("selecting an existing provider opens management in the plugin pane", async () => {
  const harness = await makeHarness({ providers: { acme: { name: "Acme", apiKey: "fixture-secret" } } });
  await harness.start();
  await harness.manage("Acme", { providerId: "acme" });
  assert.equal(harness.lastView().title, "Acme");
  const actions = harness.lastView().actions as Array<Record<string, unknown>>;
  for (const label of ["Edit connection", "Add/update model", "Clone with a new key", "Remove model", "Remove provider"]) {
    assert.ok(actions.some((action) => action.label === label), label);
  }
  assert.ok(!JSON.stringify(harness.lastView()).includes("fixture-secret"));
});

test("editing a provider preserves authentication and advanced fields", async () => {
  const harness = await makeHarness({ providers: { acme: {
    name: "Acme", api: "openai-completions", baseUrl: "https://acme.test/v1", apiKey: "fixture-secret", headers: { "x-fixture": "yes" },
  } } });
  await harness.start();
  await harness.manage("Acme", { providerId: "acme" });
  await harness.manage("Edit connection");
  assert.ok(!JSON.stringify(harness.lastView()).includes("fixture-secret"));
  await harness.manage("Save connection", { name: "Renamed", api: "openai-completions", baseUrl: "https://acme.test/v1", apiKey: "" });
  const acme = (await harness.models()).providers as Record<string, Record<string, unknown>>;
  assert.equal(acme.acme?.name, "Renamed");
  assert.equal(acme.acme?.apiKey, "fixture-secret");
  assert.deepEqual(acme.acme?.headers, { "x-fixture": "yes" });
});

test("an endpoint edit requires trust confirmation before any write", async () => {
  const harness = await makeHarness({ providers: { acme: {
    name: "Acme", api: "openai-completions", baseUrl: "https://acme.test/v1", apiKey: "fixture-secret",
  } } });
  await harness.start();
  await harness.manage("Acme", { providerId: "acme" });
  await harness.manage("Edit connection");
  await harness.manage("Save connection", { name: "Acme", api: "openai-completions", baseUrl: "https://new.test/v1", apiKey: "" });
  assert.match(linesOf(harness.lastView()).join(" "), /https:\/\/new.test\/v1/);
  assert.equal(((await harness.models()).providers as Record<string, Record<string, unknown>>).acme?.baseUrl, "https://acme.test/v1");
  await harness.manage("Trust endpoint and save");
  assert.equal(((await harness.models()).providers as Record<string, Record<string, unknown>>).acme?.baseUrl, "https://new.test/v1");
});

test("provider removal is confirmed and refuses a stale editor snapshot", async () => {
  const harness = await makeHarness({ providers: { acme: { name: "Acme" } } });
  await harness.start();
  await harness.manage("Acme", { providerId: "acme" });
  await harness.manage("Remove provider");
  assert.ok(((await harness.models()).providers as Record<string, unknown>).acme);
  await writeFile(join(dir, "models.json"), JSON.stringify({ providers: { acme: { name: "Changed elsewhere" } } }));
  await harness.manage("Remove configuration");
  assert.match(linesOf(harness.lastView()).join(" "), /Problem:/);
  assert.equal(((await harness.models()).providers as Record<string, Record<string, unknown>>).acme?.name, "Changed elsewhere");
});

test("model removal drops both model and override after confirmation", async () => {
  const harness = await makeHarness({ providers: { acme: {
    models: [{ id: "demo" }], modelOverrides: { demo: { maxTokens: 4000 } },
  } } });
  await harness.start();
  await harness.manage("acme", { providerId: "acme" });
  await harness.manage("Remove model");
  await harness.manage("Review removal", { modelId: "demo" });
  await harness.manage("Remove model configuration");
  const acme = ((await harness.models()).providers as Record<string, Record<string, unknown>>).acme!;
  assert.deepEqual(acme.models, []);
  assert.equal(acme.modelOverrides, undefined);
});

test("selecting a model pre-fills its editor and returns to its provider after saving", async () => {
  const harness = await makeHarness({ providers: { acme: {
    name: "Acme", api: "openai-completions", baseUrl: "https://acme.test/v1", apiKey: "pi-local",
    models: [{ id: "demo", name: "Demo", contextWindow: 64000, maxTokens: 4096, reasoning: true, input: ["text", "image"] }],
  } } });
  await harness.start();
  await harness.manage("Acme", { providerId: "acme" });
  await harness.manage("Demo", { modelId: "demo" });
  assert.equal(fieldOf(harness.lastView()).value, "demo");
  for (const value of ["demo", "Updated", "64000", "4096", "Yes", "Text + images"]) await harness.submit(value);
  assert.equal(harness.lastView().title, "Acme");
  assert.equal(harness.views.some((view) => view.open === false), false, "returning from a saved model must not close and reopen the plugin pane");
  assert.equal(harness.signals.modelChanges, 1, "updating a model must invalidate the built-in picker's cache too");
  const acme = ((await harness.models()).providers as Record<string, Record<string, unknown>>).acme!;
  assert.equal((acme.models as Array<Record<string, unknown>>)[0]?.name, "Updated");
});

test("cloning from management saves a separate key and keeps the inherited model list", async () => {
  const harness = await makeHarness({ providers: { acme: {
    name: "Acme", api: "openai-completions", baseUrl: "https://acme.test/v1", apiKey: "$FIRST_KEY", models: [{ id: "demo" }],
  } } });
  await harness.start();
  await harness.manage("Acme", { providerId: "acme" });
  await harness.manage("Clone with a new key");
  assert.match(linesOf(harness.lastView()).join(" "), /acme-2/);
  await harness.manage("Save new account", { name: "Second account", apiKey: "$SECOND_KEY" });
  const providers = (await harness.models()).providers as Record<string, Record<string, unknown>>;
  assert.equal(providers["acme-1"]?.apiKey, "$FIRST_KEY");
  assert.equal(providers["acme-2"]?.apiKey, "$SECOND_KEY");
  assert.deepEqual(providers["acme-2"]?.models, [{ id: "demo" }]);
  assert.equal(harness.lastView().title, "Second account");
});

test("confirmed provider removal returns to the list without deleting credentials elsewhere", async () => {
  const harness = await makeHarness({ providers: { acme: { name: "Acme" }, local: { name: "Local" } } });
  await harness.start();
  await harness.manage("Acme", { providerId: "acme" });
  await harness.manage("Remove provider");
  await harness.manage("Remove configuration");
  assert.equal(harness.lastView().id, "provider-wizard:home");
  assert.deepEqual(await harness.models(), { providers: { local: { name: "Local" } } });
});

test("add/update model discovers the server list, saves ticks and offers a family sync", async () => {
  // A loopback OpenAI-style /models endpoint: discovery runs the same fetch
  // path production uses, without leaving the machine or needing a key.
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [
      { id: "existing-model", owned_by: "acme" },
      { id: "fresh-model", context_length: 200000 },
    ] }));
  });
  await listen(server);
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  try {
    const harness = await makeHarness({ providers: {
      "acme-1": { name: "Acme", api: "openai-completions", baseUrl, apiKey: "pi-local", models: [{ id: "existing-model", name: "Existing", contextWindow: 64000, maxTokens: 4096 }] },
      "acme-2": { name: "Acme 2", api: "openai-completions", baseUrl, apiKey: "$OTHER_KEY", models: [] },
    } });
    await harness.start();
    await harness.manage("Acme (acme-1)", { providerId: "acme-1" });
    await harness.manage("Add/update model");
    await harness.awaitView("provider-manager:pick-models");
    assert.equal(harness.lastView().id, "provider-manager:pick-models");
    const items = harness.lastView().items as Array<{ label: string; selected?: boolean; values?: { modelId?: string } }>;
    assert.deepEqual(
      items.map((item) => [item.label, item.selected]).sort(),
      [["existing-model", true], ["fresh-model", false]],
      "the row publishes its tick state; the label is the model id alone",
    );
    assert.ok(
      !items.some((item) => item.label.includes("[")),
      "selection is a control the host draws, not a marker in the text",
    );
    await harness.manage("fresh-model", { modelId: "fresh-model" });
    await harness.manage("Save selected models (2)");
    assert.equal(harness.lastView().id, "provider-manager:sync-offer", "a family with siblings offers the sync");
    await harness.manage("Copy to all accounts");
    assert.equal(harness.lastView().title, "Acme");
    const providers = (await harness.models()).providers as Record<string, Record<string, unknown>>;
    assert.ok(providers["acme-1"] && providers["acme-2"], "both accounts survive the sync");
    const saved = (providers["acme-1"]!.models as Array<Record<string, unknown>>).find((model) => model.id === "fresh-model");
    assert.equal(saved?.contextWindow, 200000, "the server-reported window is written");
    assert.deepEqual(
      (providers["acme-2"]!.models as Array<{ id: string }>).map((model) => model.id).sort(),
      ["existing-model", "fresh-model"],
      "the sibling received the same list",
    );
    assert.equal(providers["acme-2"]?.apiKey, "$OTHER_KEY", "sync never copies a credential");
    assert.ok(seen.some((url) => url.startsWith("/v1/models")), "discovery hit the provider endpoint");
  } finally {
    await closeServer(server);
  }
});

test("a refused discovery explains itself and falls back to manual entry", async () => {
  const harness = await makeHarness({ providers: { acme: {
    name: "Acme", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: "pi-local", models: [],
  } } });
  await harness.start();
  await harness.manage("Acme", { providerId: "acme" });
  await harness.manage("Add/update model");
  await harness.awaitView("provider-manager:discovery-failed");
  assert.equal(harness.lastView().id, "provider-manager:discovery-failed");
  assert.match(linesOf(harness.lastView()).join(" "), /model list could not be fetched|HTTP|empty|fetch/);
  assert.ok(!JSON.stringify(harness.lastView()).includes("pi-local"), "the refusal never echoes the credential");
  await harness.manage("Enter model ID manually");
  assert.equal(harness.lastView().title, "Add/update model", "manual entry opens the wizard");
});

test("an unreadable models.json is reported instead of overwritten", async () => {
  const harness = await makeHarness();
  // A file that is not strict JSON: the wizard must not guess.
  await writeFile(join(dir, "models.json"), "{ not json", "utf8");
  await harness.start();

  assert.equal(harness.lastView().id, "provider-wizard:file");
  assert.ok(linesOf(harness.lastView())[0]?.includes("strict JSON"));
  assert.equal(await readFile(join(dir, "models.json"), "utf8"), "{ not json");
  await rm(dir, { recursive: true, force: true });
});
