import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSessionRuntime, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import modes from "../extensions/modes.ts";
import { planModeFromBranch } from "../lib/plan/plan-mode.ts";

/** No artifact extension, external provider, timers, or native terminal is involved. */
async function fixture(before: ExtensionFactory[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "pi-mode-lifecycle-"));
  const errors: unknown[] = [];
  const notices: string[] = [];
  const starts: string[] = [];
  const requests: { tools: string[]; sections: Record<string, string | null> }[] = [];
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
  });
  const model: any = {
    id: "mode-lifecycle-local", name: "Mode lifecycle local", provider: "mode-lifecycle-test", api: "mode-lifecycle-scripted",
    baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  let api: any;
  let widgetFactory: any;
  let registerLateAtLoad = false;
  const lateTool: any = {
    name: "late_tool", label: "Late tool", description: "Deferred tool whose reconnection is controlled by the test",
    exposure: "deferred", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "late tool" }], details: undefined }; },
  };
  const createRuntime = async (options: any) => {
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      promptsOverride: () => ({ prompts: [{ name: "grill", description: "Challenge an idea", content: "Grill this proposal: $1. Do not implement it.",
        filePath: join(dir, "preloaded-prompt-does-not-exist.md"), sourceInfo: {} as any }], diagnostics: [] }),
      extensionFactories: [...before, modes, pi => {
        api = pi;
        // A nonempty Plan loadout makes restoration of an intentionally empty
        // original loadout distinguishable from retaining the Plan transcript.
        pi.registerTool({
          name: "ask_user", label: "Question fixture", description: "Inert Plan-allowed fixture",
          exposure: "model-only", defaultActive: false, parameters: Type.Object({}),
          async execute() { return { content: [{ type: "text", text: "fixture" }], details: undefined }; },
        });
        if (registerLateAtLoad) pi.registerTool(lateTool);
        pi.on("session_start", event => { starts.push(event.reason); });
        pi.registerProvider(model.provider, {
          api: model.api, baseUrl: model.baseUrl, apiKey: "local-test", models: [model],
          streamSimple: (_model: any, context: any) => {
            const current = getCurrentSystemMessage(context.messages);
            requests.push({
              tools: (current?.toolsAdded ?? []).map(tool => tool.name),
              sections: { ...current?.sections },
            });
            const message: any = {
              role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
              content: [{ type: "text", text: "Local mode lifecycle fixture." }], stopReason: "stop",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            };
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: "stop", message });
            return stream;
          },
        });
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const result = await createAgentSession({
      ...options, cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings, model,
    });
    // These are the cwd-bound fields used by the real replacement host. Resource
    // loading/model registration still go through the real createAgentSession.
    return { ...result, services: { cwd: dir, agentDir: dir } as any, diagnostics: [] };
  };
  const initial = await createRuntime({ sessionManager: SessionManager.create(dir, dir) });
  const host = new AgentSessionRuntime(initial.session, initial.services, createRuntime);
  const bind = async (session: any) => session.bindExtensions({
    mode: "tui", onError: (error: unknown) => { errors.push(error); },
    uiContext: {
      setWidget(key: string, factory: any) { if (key === "input-modes") widgetFactory = factory; },
      setEditorComponent() {}, setStatus() {}, addAutocompleteProvider() {},
      notify(text: string) { notices.push(text); },
    } as any,
  });
  host.setRebindSession(bind);
  await bind(host.session);
  return {
    host, errors, notices, starts, requests,
    session: () => host.session,
    registerLate() { api.registerTool(lateTool); },
    lateAtLoad(value: boolean) { registerLateAtLoad = value; },
    widget() {
      assert.equal(typeof widgetFactory, "function");
      return widgetFactory({}, {
        fg: (_token: string, text: string) => text, bold: (text: string) => text,
      }).render(120).join("\n");
    },
    async prompt(text: string) {
      await host.session.prompt(text);
      const last = host.session.messages.at(-1);
      if (last?.role === "assistant") assert.notEqual(last.stopReason, "error", last.errorMessage);
    },
    async cleanup() { await host.dispose(); await rm(dir, { recursive: true, force: true }); },
  };
}

const PLAN_LOADOUT = ["read", "bash", "grep", "find", "ls", "ask_user"];
async function enterPlan(f: Awaited<ReturnType<typeof fixture>>) {
  await f.prompt("/plan on");
  await f.prompt("Brainstorm without implementation.");
  assert.equal(planModeFromBranch(f.session().sessionManager.getBranch())?.enabled, true);
  assert.deepEqual(f.session().getActiveToolNames(), PLAN_LOADOUT);
  assert.match(f.requests.at(-1)!.sections.input_mode!, /Current input mode: Plan/);
}

function assertNormal(f: Awaited<ReturnType<typeof fixture>>, expected: string[]) {
  assert.equal(planModeFromBranch(f.session().sessionManager.getBranch())?.enabled, false);
  assert.deepEqual(f.session().getActiveToolNames(), expected);
  assert.match(f.widget(), /\[ 󰚥 Normal \]/u);
}

for (const replacement of ["resume", "switch", "fork"] as const) {
  for (const empty of [false, true]) {
    test(`real Pi ${replacement} immediately after Plan off restores ${empty ? "an empty" : "the original"} Normal loadout`, async () => {
      const f = await fixture();
      try {
        if (empty) f.session().setActiveToolsByName([]);
        const original = [...f.session().getActiveToolNames()];
        await enterPlan(f);
        const planRequests = f.requests.length;
        await f.prompt("/plan off");
        assert.equal(f.requests.length, planRequests, "exiting Plan must not require a model request");
        assertNormal(f, original);
        const source = f.session().sessionManager.getSessionFile()!;
        const offLeaf = f.session().sessionManager.getLeafId()!;
        if (replacement === "fork") {
          await f.host.fork(offLeaf, { position: "at" });
          assert.equal(f.starts.at(-1), "fork");
        } else {
          if (replacement === "switch") await f.host.newSession();
          await f.host.switchSession(source);
          assert.equal(f.starts.at(-1), "resume");
        }
        assert.equal(f.requests.length, planRequests, "replacement itself must not hide a missing checkpoint by making a request");
        assertNormal(f, original);
        await f.prompt("/plan off"); // Idempotence must not damage a restored loadout.
        assertNormal(f, original);
        await f.prompt("Confirm Normal mode and its exact available tools.");
        assert.deepEqual(f.requests.at(-1)!.tools, original);
        assert.match(f.requests.at(-1)!.sections.input_mode!, /Current input mode: Normal/);
        assert.equal(f.requests.at(-1)!.sections.plan_mode, undefined);
        assert.deepEqual(f.errors, []);
      } finally { await f.cleanup(); }
    });
  }
}

for (const targetAfterExit of [false, true]) {
  test(`real Pi tree preserves destination read-only loadout ${targetAfterExit ? "changed after a Normal exit request" : "before any Plan marker"}`, async () => {
    const f = await fixture();
    try {
      let normalLeaf: string;
      if (!targetAfterExit) {
        f.session().setActiveToolsByName(["read"]);
        await f.prompt("Persist the read-only Normal branch.");
        normalLeaf = f.session().sessionManager.getLeafId()!;
        f.session().setActiveToolsByName(["read", "bash", "edit", "write"]);
      }
      await enterPlan(f);
      const planLeaf = f.session().sessionManager.getLeafId()!;
      if (targetAfterExit) {
        await f.prompt("/plan off");
        await f.prompt("Persist the initial Normal exit loadout.");
        f.session().setActiveToolsByName(["read"]);
        await f.prompt("Persist an intentional read-only Normal loadout after exit.");
        normalLeaf = f.session().sessionManager.getLeafId()!;
      } else {
        // Leave the source in Plan; target history intentionally has no Plan marker.
        assert.deepEqual(f.session().getActiveToolNames(), PLAN_LOADOUT);
      }
      if (targetAfterExit) await f.session().navigateTree(planLeaf);
      assert.deepEqual(f.session().getActiveToolNames(), PLAN_LOADOUT);
      await f.session().navigateTree(normalLeaf!);
      assert.deepEqual(f.session().getActiveToolNames(), ["read"], "source Plan snapshot must not overwrite Pi's destination transcript loadout");
      assert.match(f.widget(), /\[ 󰚥 Normal \]/u);
      assert.notEqual(planModeFromBranch(f.session().sessionManager.getBranch())?.enabled, true);
      await f.prompt("Confirm the destination remains read-only Normal.");
      assert.deepEqual(f.requests.at(-1)!.tools, ["read"]);
      assert.match(f.requests.at(-1)!.sections.input_mode!, /Current input mode: Normal/);
      assert.equal(f.requests.at(-1)!.sections.plan_mode, undefined);
      assert.deepEqual(f.errors, []);
    } finally { await f.cleanup(); }
  });
}

for (const replacement of ["reload", "resume"] as const) {
  test(`real Pi ${replacement} restores a late deferred declaration after Plan exit and does not resurrect a later deactivation`, async () => {
    const f = await fixture();
    try {
      f.registerLate();
      f.session().setActiveToolsByName(["read", "late_tool"]);
      await enterPlan(f);
      f.lateAtLoad(false); // Reconnecting tools are absent from the new registry.
      if (replacement === "reload") {
        await f.session().reload();
      } else {
        await f.host.switchSession(f.session().sessionManager.getSessionFile()!);
      }
      assert.equal(f.starts.at(-1), replacement);
      assert.deepEqual(f.session().getActiveToolNames(), PLAN_LOADOUT);
      await f.prompt("/plan off");
      assert.deepEqual(f.session().getActiveToolNames(), ["read"]);
      // A Normal request while disconnected must not permanently forget the
      // desired name. Its first post-reconnection declaration is the contract.
      await f.prompt("Continue in Normal while the deferred provider reconnects.");
      f.registerLate();
      await f.prompt("Use the restored Normal declarations after reconnection.");
      assert.deepEqual(f.session().getActiveToolNames(), ["read", "late_tool"]);
      assert.deepEqual(f.requests.at(-1)!.tools, ["read", "late_tool"]);
      f.session().setActiveToolsByName(["read"]);
      await f.prompt("The user intentionally deactivated the late declaration.");
      assert.deepEqual(f.session().getActiveToolNames(), ["read"], "completed restoration must not repeatedly re-add deactivated names");
      assert.deepEqual(f.requests.at(-1)!.tools, ["read"]);
      assert.deepEqual(f.errors, []);
    } finally { await f.cleanup(); }
  });
}

for (const navigation of ["tree", "reload"] as const) {
  test(`real Pi pending reconnect survives Normal checkpoints and ${navigation} without leaking across branches`, async () => {
    const f = await fixture();
    try {
      f.session().setActiveToolsByName(["read"]);
      await f.prompt("Persist unrelated Normal before any Plan state.");
      const unrelatedLeaf = f.session().sessionManager.getLeafId()!;
      f.registerLate();
      f.session().setActiveToolsByName(["read", "late_tool"]);
      await enterPlan(f);
      await f.session().reload();
      await f.prompt("/plan off");
      await f.prompt("First disconnected Normal checkpoint.");
      const firstNormalLeaf = f.session().sessionManager.getLeafId()!;
      await f.prompt("Second disconnected Normal checkpoint.");
      if (navigation === "tree") {
        await f.session().navigateTree(unrelatedLeaf);
        f.registerLate();
        await f.prompt("This unrelated branch must not inherit a pending declaration.");
        assert.deepEqual(f.requests.at(-1)!.tools, ["read"]);
        await f.session().navigateTree(firstNormalLeaf);
      } else {
        await f.session().reload();
        f.registerLate();
      }
      await f.prompt("Reconnect the deferred tool on the branch that requested it.");
      assert.deepEqual(f.requests.at(-1)!.tools, ["read", "late_tool"]);
      f.session().setActiveToolsByName(["read"]);
      await f.prompt("Persist intentional deactivation after the completed reconnect.");
      f.lateAtLoad(true);
      await f.session().reload();
      await f.prompt("Reload must not resurrect a completed restoration.");
      assert.deepEqual(f.requests.at(-1)!.tools, ["read"]);
      assert.deepEqual(f.errors, []);
    } finally { await f.cleanup(); }
  });
}

test("real Pi Normal preserves an earlier extension's explicit no-tools selection", async () => {
  const f = await fixture([pi => { pi.on("before_agent_start", event => { event.systemPromptOptions.selectedTools = []; }); }]);
  try {
    await f.prompt("Normal chat with an explicit upstream empty tool selection.");
    assert.deepEqual(f.requests.at(-1)!.tools, []);
    assert.deepEqual(f.errors, []);
  } finally { await f.cleanup(); }
});

test("real Pi Plan accepts preloaded slash templates, commands and skill input", async () => {
  const f = await fixture();
  try {
    await enterPlan(f);
    await f.prompt("/grill search");
    assert.deepEqual(f.requests.at(-1)!.tools, PLAN_LOADOUT);
    assert.match(f.requests.at(-1)!.sections.input_mode!, /Current input mode: Plan/);
    const lastUser = f.session().messages.filter(message => message.role === "user").at(-1)!;
    assert.match(JSON.stringify(lastUser.content), /Grill this proposal: search\. Do not implement it\./);
    const count = f.requests.length;
    await f.prompt("/skill:private");
    assert.equal(f.requests.length, count + 1, "skill input is no longer blocked by Plan");
    await f.prompt("/plan status");
    assert.equal(f.requests.length, count + 1, "slash commands remain UI actions, not AI requests");
    assert.match(f.notices.at(-1)!, /Plan mode: read-only exploration/);
    assert.deepEqual(f.errors, []);
  } finally { await f.cleanup(); }
});

// Control for the deferred-tool fixtures: Pi itself preserves a disconnected
// active declaration across reload when no Plan transition replaces its loadout.
test("real Pi native reload restores a late deferred declaration without Plan", async () => {
  const f = await fixture();
  try {
    f.registerLate();
    f.session().setActiveToolsByName(["read", "late_tool"]);
    await f.session().reload();
    assert.deepEqual(f.session().getActiveToolNames(), ["read"]);
    f.registerLate();
    assert.deepEqual(f.session().getActiveToolNames(), ["read", "late_tool"]);
    await f.prompt("Confirm the native pending declaration control.");
    assert.deepEqual(f.requests.at(-1)!.tools, ["read", "late_tool"]);
    assert.deepEqual(f.errors, []);
  } finally { await f.cleanup(); }
});
