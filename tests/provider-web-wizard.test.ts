import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  /** Publish the wizard's first step. */
  start(): Promise<void>;
  /** Answer the current step. */
  submit(value: string): Promise<void>;
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
  const act = async (actionId: string, values?: Record<string, string>): Promise<void> => {
    const before = views.length;
    mockPi.events.emit(ACTION_EVENT, {
      requestId: `req-${actionId}`,
      sessionId: "provider-web-test",
      pluginId: "providers",
      actionId,
      ...(values !== undefined ? { values } : {}),
    });
    await waitForView(before);
  };

  return {
    views,
    async start() {
      // The bridge asks for the announced command by name; the extension runs
      // it on the context it captured at session start.
      const before = views.length;
      mockPi.events.emit(WEB_COMMAND_EVENT, { name: "provider", args: "" });
      await waitForView(before);
    },
    submit: (value) => act("provider-next", { value }),
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
  assert.deepEqual(linesOf(harness.lastView()), ["Acme (acme) · 1 model", "Zeta (zeta) · 0 models"]);
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
