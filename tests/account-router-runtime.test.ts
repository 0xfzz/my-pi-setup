import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import accountRouter, { poolProviderId } from "../extensions/account-router.ts";
import { SECTION_EVENT, type SectionOffer } from "../lib/sidebar/sidebar-channel.ts";

// A provider with a cost-free scripted API so routing is observed end to end:
// every request records which credential it was handed.
type Seen = { key: string; model: string; provider: string; context: any; options: any };

function fakeProvider(id: string, modelIds: string[], seen: Seen[], options: {
  failWith?: (key: string) => string | undefined;
  inputTokens?: number;
  outputTokens?: number;
  /** Catalog price per token; a route's `cheapest` method ranks targets by it. */
  cost?: { input: number; output: number };
} = {}) {
  const model = (modelId: string) => ({
    id: modelId, name: modelId, provider: id, api: "scripted", baseUrl: "http://127.0.0.1:1",
    reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 2_000,
    cost: { input: options.cost?.input ?? 0, output: options.cost?.output ?? 0, cacheRead: 0, cacheWrite: 0 },
  });
  return {
    models: modelIds.map(model),
    config: {
      api: "scripted" as const,
      baseUrl: "http://127.0.0.1:1",
      apiKey: "provider-default",
      models: modelIds.map(model),
      streamSimple: (m: any, context: any, opts: any) => {
        const key = String(opts?.apiKey ?? "");
        seen.push({ key, model: m.id, provider: m.provider, context, options: opts });
        const failure = options.failWith?.(key);
        const stream = createAssistantMessageEventStream();
        const message: any = {
          role: "assistant", api: m.api, provider: m.provider, model: m.id,
          timestamp: Date.now(), content: [],
          usage: { input: options.inputTokens ?? 0, output: options.outputTokens ?? 0, cacheRead: 0, cacheWrite: 0,
            totalTokens: (options.inputTokens ?? 0) + (options.outputTokens ?? 0) },
          stopReason: failure ? "error" : "stop",
          ...(failure ? { errorMessage: failure } : { content: [{ type: "text", text: `ok:${key}` }] }),
        };
        stream.push({ type: "start", partial: message });
        if (failure) stream.push({ type: "error", reason: "error", error: message });
        else stream.push({ type: "done", reason: "stop", message });
        void context;
        return stream;
      },
    },
  };
}

async function withSession(
  run: (ctx: { dir: string; seen: Seen[]; session: any; registry: any; eventBus?: any }) => Promise<void>,
  setup: (seen: Seen[]) => { providers: Array<{ name: string; config: any }>; config: unknown; routerState?: unknown },
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-account-router-rt-"));
  let session: any;
  const seen: Seen[] = [];
  // The extension resolves its config, account store and state path through
  // getAgentDir() (PI_CODING_AGENT_DIR), not the loader's agentDir argument.
  // Without this the router would read the developer's real ~/.pi/agent config.
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await writeFile(join(dir, "antigravity-accounts.json"), JSON.stringify({
      version: 1,
      activeAccountId: "one@x.com",
      accounts: {
        "one@x.com": { accountId: "one@x.com", email: "one@x.com", access: "tok-one", refresh: "r1",
          expires: Date.now() + 3_600_000, projectId: "proj" },
        "two@x.com": { accountId: "two@x.com", email: "two@x.com", access: "tok-two", refresh: "r2",
          expires: Date.now() + 3_600_000, projectId: "proj" },
        "three@x.com": { accountId: "three@x.com", email: "three@x.com", access: "tok-three", refresh: "r3",
          expires: Date.now() + 3_600_000, projectId: "proj" },
      },
    }));
    const { providers, config, modelsConfig, routerState } = setup(seen) as any;
    if (routerState) await writeFile(join(dir, "account-router-state.json"), JSON.stringify(routerState));
    if (modelsConfig) await writeFile(join(dir, "models.json"), JSON.stringify(modelsConfig));
    if (config) await writeFile(join(dir, "account-router.json"), JSON.stringify(config));
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
    });
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [
        // Base providers first so the router can mirror their catalogs.
        (pi => { for (const entry of providers) pi.registerProvider(entry.name, entry.config); }),
        accountRouter,
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const manager = SessionManager.create(dir, dir);
    ({ session } = await createAgentSession({
      cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings, sessionManager: manager,
    }));
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error: unknown) => errors.push(error) });
    assert.deepEqual(errors, []);
    const eventBus = (loader as unknown as { eventBus: any }).eventBus;
    await run({ dir, seen, session, registry: session.modelRuntime, eventBus });
  } finally {
    session?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  }
}

// ── Pool rotation in a real session ──────────────────────────────────────────

test("a pool rotates accounts across separate requests", { timeout: 20000 }, async () => {
  await withSession(async ({ seen, registry }) => {
    const model = registry.getModel(poolProviderId("ag"), "gemini-pro");
    assert.ok(model, "the pool exposes the base provider's models");
    for (let n = 0; n < 3; n++) {
      const message = await registry.completeSimple(model, {
        messages: [{ role: "user", content: [{ type: "text", text: `turn ${n}` }] }],
      });
      assert.equal(message.stopReason, "stop");
    }
    assert.equal(seen.length, 3, "every request went through the pool");
    const tokens = seen.map((entry) => JSON.parse(entry.key).token);
    assert.deepEqual(tokens, ["tok-one", "tok-two", "tok-three"], "round-robin visits each account once");
    for (const entry of seen) assert.ok(!entry.key.includes("provider-default"), "the base credential is never used");
  }, (seen) => ({
    providers: [{
      name: "antigravity",
      config: fakeProvider("antigravity", ["gemini-pro"], seen).config,
    }],
    config: {
      pools: { ag: { provider: "antigravity", source: "antigravity-accounts", strategy: "round-robin" } },
      routes: [{ name: "auto", targets: [{ model: "antigravity/gemini-pro", pool: "ag" }] }],
    },
  }));
});

test("a quota wall cools one account down and the next request moves on", { timeout: 20000 }, async () => {
  const failures = new Set<string>();
  await withSession(async ({ seen, registry }) => {
    const model = registry.getModel(poolProviderId("ag"), "gemini-pro")!;
    const first = await registry.completeSimple(model, {
      messages: [{ role: "user", content: [{ type: "text", text: "one" }] }],
    });
    assert.equal(first.stopReason, "error");
    assert.match(first.errorMessage ?? "", /429/);
    const second = await registry.completeSimple(model, {
      messages: [{ role: "user", content: [{ type: "text", text: "two" }] }],
    });
    assert.equal(second.stopReason, "stop", "the next request succeeds on another account");
    const tokens = seen.map((entry) => JSON.parse(entry.key).token);
    assert.deepEqual(tokens, ["tok-one", "tok-two"], "a cooled account is skipped, not retried");
    assert.ok(failures.has("tok-one"), "the failing account was actually exercised");
  }, (seen) => {
    const base = fakeProvider("antigravity", ["gemini-pro"], seen, {
      failWith: (key) => {
        if (!key) return undefined;
        const token = JSON.parse(key).token;
        if (token !== "tok-one") return undefined;
        failures.add(token);
        return "HTTP 429 quota exceeded";
      },
    });
    return {
      providers: [{ name: "antigravity", config: base.config }],
      config: {
        // A long cooldown keeps the failed account out of this session.
        pools: { ag: { provider: "antigravity", source: "antigravity-accounts", cooldownMs: 600_000 } },
        routes: [{ name: "auto", targets: [{ model: "antigravity/gemini-pro", pool: "ag" }] }],
      },
    };
  });
});

test("quota recovery probes only after reset, stops on success, and restarts on a new quota wall", { timeout: 20000 }, async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  let failing = true;
  const wait = (54 * 3600 + 10 * 60 + 43) * 1000;
  try {
    await withSession(async ({ dir, seen, registry }) => {
      const model = registry.getModel(poolProviderId("p"), "chat")!;
      const context = { messages: [{ role: "user", content: [{ type: "text", text: "FULL USER REQUEST" }] }] };
      const request = () => registry.completeSimple(model, context, {
        sessionId: "live-session", maxTokens: 2048, reasoning: "high",
        onPayload: () => { throw new Error("probe must not call the conversation payload hook"); },
      });
      assert.equal((await request()).stopReason, "error");
      assert.equal(seen.length, 1);
      let saved = JSON.parse(await readFile(join(dir, "account-router-state.json"), "utf8"));
      assert.equal(saved.health.p.a.cooldownUntil, now + wait);
      assert.equal(saved.health.p.a.needsProbe, true);
      now += wait - 1;
      assert.equal((await request()).stopReason, "error");
      assert.equal(seen.length, 1, "no full request or probe is sent inside the reset window");
      now += 1;
      const failedProbe = await request();
      assert.equal(failedProbe.stopReason, "error", "still exhausted: only a tiny probe is sent");
      assert.equal(failedProbe.usage.input, 2, "failed probe usage is not lost");
      assert.equal(seen.length, 2);
      assert.deepEqual(seen[1].context.messages, [{ role: "user", content: [{ type: "text", text: "Reply OK." }], timestamp: now }]);
      assert.equal(seen[1].options.maxTokens, 16);
      assert.equal(seen[1].options.reasoning, undefined, "the normal high reasoning setting is not inherited");
      assert.equal(seen[1].options.maxRetries, 0);
      assert.equal(seen[1].options.sessionId, undefined);
      assert.equal(seen[1].options.onPayload, undefined);
      now += wait;
      failing = false;
      const recovered = await request();
      assert.equal(recovered.stopReason, "stop");
      assert.equal(recovered.usage.input, 4, "response includes the probe and the real request usage");
      assert.equal(recovered.usage.output, 2);
      assert.equal(recovered.usage.totalTokens, 6);
      assert.equal(seen.length, 4, "one successful probe, then the real request, despite exhausted failure budget");
      assert.equal(seen[2].options.maxTokens, 16);
      assert.deepEqual(seen[3].context.messages, context.messages);
      saved = JSON.parse(await readFile(join(dir, "account-router-state.json"), "utf8"));
      assert.equal(saved.health.p.a.needsProbe, undefined);
      assert.equal(saved.health.p.a.failures, 0);
      assert.equal((await request()).stopReason, "stop");
      assert.equal(seen.length, 5, "healthy requests do not incur tests");
      failing = true;
      assert.equal((await request()).stopReason, "error");
      assert.equal(seen.length, 6);
      assert.equal((await request()).stopReason, "error");
      assert.equal(seen.length, 6, "a fresh quota wall quarantines the account again");
      now += wait;
      failing = false;
      assert.equal((await request()).stopReason, "stop");
      assert.equal(seen.length, 8, "the new recovery cycle probes once again");
    }, (seen) => ({
      providers: [{ name: "base", config: fakeProvider("base", ["chat"], seen, {
        inputTokens: 2, outputTokens: 1,
        failWith: () => failing ? "Quota reached. Please wait 54h10m43s. Next: switch models or try again after reset." : undefined,
      }).config }],
      config: { pools: { p: { provider: "base", accounts: [{ id: "a", apiKey: "a-key" }], maxConsecutiveFailures: 1 } } },
    }));
  } finally { Date.now = realNow; }
});

test("a failed recovery probe skips to a healthy account without sending it the full request", { timeout: 20000 }, async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    await withSession(async ({ seen, registry }) => {
      const model = registry.getModel(poolProviderId("p"), "chat")!;
      const context = { messages: [{ role: "user", content: [{ type: "text", text: "real work" }] }] };
      assert.equal((await registry.completeSimple(model, context)).stopReason, "error");
      now += 1000;
      const response = await registry.completeSimple(model, context);
      assert.equal(response.stopReason, "stop");
      assert.deepEqual(seen.map(s => s.key), ["a-key", "a-key", "b-key"]);
      assert.equal(seen[1].options.maxTokens, 16);
      assert.deepEqual(seen[2].context.messages, context.messages);
      await registry.completeSimple(model, context);
      assert.deepEqual(seen.map(s => s.key), ["a-key", "a-key", "b-key", "b-key"]);
    }, (seen) => ({
      providers: [{ name: "base", config: fakeProvider("base", ["chat"], seen, {
        failWith: key => key === "a-key" ? "HTTP 429 quota exceeded" : undefined,
      }).config }],
      config: { pools: { p: { provider: "base", strategy: "priority", cooldownMs: 1000,
        accounts: [{ id: "a", apiKey: "a-key" }, { id: "b", apiKey: "b-key" }] } } },
    }));
  } finally { Date.now = realNow; }
});

test("pending recovery survives restart and a thrown probe failure stays quarantined", { timeout: 20000 }, async () => {
  await withSession(async ({ dir, seen, registry }) => {
    const model = registry.getModel(poolProviderId("p"), "chat")!;
    const context = { messages: [{ role: "user", content: [{ type: "text", text: "real request" }] }] };
    const result = await registry.completeSimple(model, context);
    assert.equal(result.stopReason, "stop");
    assert.deepEqual(seen.map(s => s.key), ["a-key", "b-key"]);
    assert.equal(seen[0].options.maxTokens, 16);
    assert.deepEqual(seen[1].context.messages, context.messages);
    const saved = JSON.parse(await readFile(join(dir, "account-router-state.json"), "utf8"));
    assert.equal(saved.health.p.a.needsProbe, true);
    assert.equal(saved.health.p.a.failures, 5);
    assert.ok(saved.health.p.a.cooldownUntil > Date.now());
    await registry.completeSimple(model, context);
    assert.equal(seen.length, 3);
    assert.equal(seen[2].key, "b-key", "a non-quota probe exception is also throttled");
  }, (seen) => ({
    providers: [{ name: "base", config: fakeProvider("base", ["chat"], seen, {
      failWith: key => { if (key === "a-key") throw new Error("connection reset"); return undefined; },
    }).config }],
    config: { pools: { p: { provider: "base", strategy: "priority",
      accounts: [{ id: "a", apiKey: "a-key" }, { id: "b", apiKey: "b-key" }] } } },
    routerState: { version: 1, cursor: {}, health: { p: { a: {
      failures: 4, lastError: "Quota reached. Please wait 1s.", cooldownUntil: Date.now() - 100,
    } } } },
  }));
});

test("aborting a recovery probe does not clear quarantine or submit the full request", { timeout: 20000 }, async () => {
  const controller = new AbortController();
  await withSession(async ({ dir, seen, registry }) => {
    const model = registry.getModel(poolProviderId("p"), "chat")!;
    const result = await registry.completeSimple(model, {
      messages: [{ role: "user", content: [{ type: "text", text: "real request" }] }],
    }, { signal: controller.signal });
    assert.equal(result.stopReason, "aborted");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].options.maxTokens, 16);
    const saved = JSON.parse(await readFile(join(dir, "account-router-state.json"), "utf8"));
    assert.equal(saved.health.p.a.needsProbe, true);
    assert.equal(saved.health.p.a.failures, 1, "user cancellation is not a new account failure");
  }, (seen) => ({
    providers: [{ name: "base", config: fakeProvider("base", ["chat"], seen, {
      failWith: () => { controller.abort(); return undefined; },
    }).config }],
    config: { pools: { p: { provider: "base", accounts: [{ id: "a", apiKey: "a-key" }] } } },
    routerState: { version: 1, cursor: {}, health: { p: { a: {
      failures: 1, needsProbe: true, cooldownUntil: Date.now() - 100,
    } } } },
  }));
});

// ── Route fallback across providers ──────────────────────────────────────────

test("a route falls back to the next provider when one is unregistered", { timeout: 20000 }, async () => {
  await withSession(async ({ seen, registry }) => {
    const virtual = registry.getModel("router", "auto");
    assert.ok(virtual, "the virtual model is selectable");
    const message = await registry.completeSimple(virtual, {
      messages: [{ role: "user", content: [{ type: "text", text: "route me" }] }],
    });
    assert.equal(message.stopReason, "stop");
    assert.equal(message.provider, "secondary", "routing skipped the unavailable provider");
    assert.equal(seen.length, 1);
  }, (seen) => ({
    providers: [{ name: "secondary", config: fakeProvider("secondary", ["backup-model"], seen).config }],
    config: {
      routes: [{
        name: "auto",
        targets: ["missing-primary/ghost-model", "secondary/backup-model"],
      }],
    },
  }));
});

test("a route uses its first registered target when it is available", { timeout: 20000 }, async () => {
  await withSession(async ({ seen, registry }) => {
    const virtual = registry.getModel("router", "auto")!;
    const message = await registry.completeSimple(virtual, {
      messages: [{ role: "user", content: [{ type: "text", text: "route me" }] }],
    });
    assert.equal(message.provider, "primary");
    assert.equal(message.model, "main-model");
    assert.deepEqual(seen.map((entry) => entry.model), ["main-model"]);
  }, (seen) => ({
    providers: [
      { name: "primary", config: fakeProvider("primary", ["main-model"], seen).config },
      { name: "secondary", config: fakeProvider("secondary", ["backup-model"], seen).config },
    ],
    config: { routes: [{ name: "auto", targets: ["primary/main-model", "secondary/backup-model"] }] },
  }));
});

test("a continuation stays on the pooled model that answered", { timeout: 20000 }, async () => {
  // Regression: a pooled target dispatches through a shadow provider
  // (`pool:ag/<model>`), while the target names `antigravity/<model>`.
  // Comparing the raw target string never matched, so a continuation silently
  // re-routed to the head of the chain and lost the prompt cache.
  //
  // The head is `gemini-flash`; the previous response came from `gemini-pro`,
  // so a lost match is directly observable in the resolved model.
  await withSession(async ({ registry }) => {
    const virtual = registry.getModel("router", "auto")!;
    const previous = {
      api: "scripted", provider: poolProviderId("ag"), model: "gemini-pro",
      content: [{ type: "text", text: "ok" }], timestamp: Date.now(), stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    };
    const messages: any = [
      { role: "user", content: [{ type: "text", text: "pick" }] },
      { role: "assistant", ...previous },
    ];
    const resolved = await (registry as any).resolveModel(virtual, messages, {
      reason: "continuation", thinkingLevel: "off",
    });
    assert.equal(resolved.model.id, "gemini-pro",
      "the continuation reused the answering model instead of the chain head");
    assert.equal(resolved.model.provider, poolProviderId("ag"));

    // A user turn is free to pick the head again.
    const fresh = await (registry as any).resolveModel(virtual, messages, {
      reason: "user", thinkingLevel: "off",
    });
    assert.equal(fresh.model.id, "gemini-flash", "a new user turn starts at the chain head");
  }, (seen) => ({
    providers: [{
      name: "antigravity",
      config: fakeProvider("antigravity", ["gemini-flash", "gemini-pro"], seen).config,
    }],
    config: {
      pools: { ag: { provider: "antigravity", source: "antigravity-accounts" } },
      routes: [{
        name: "auto",
        targets: [
          { model: "antigravity/gemini-flash", pool: "ag" },
          { model: "antigravity/gemini-pro", pool: "ag" },
        ],
      }],
    },
  }));
});

test("a cheapest route picks the lower-priced target even when it is listed second", { timeout: 20000 }, async () => {
  await withSession(async ({ registry }) => {
    const virtual = registry.getModel("router", "auto")!;
    const resolved = await (registry as any).resolveModel(virtual, [
      { role: "user", content: [{ type: "text", text: "route me" }] },
    ], { reason: "user", thinkingLevel: "off" });
    assert.equal(resolved.model.provider, "cheap", "declaration order is not the cheapest order");
    assert.equal(resolved.model.id, "small");
  }, (seen) => ({
    providers: [
      { name: "pricey", config: fakeProvider("pricey", ["frontier"], seen, { cost: { input: 15, output: 60 } }).config },
      { name: "cheap", config: fakeProvider("cheap", ["small"], seen, { cost: { input: 1, output: 2 } }).config },
    ],
    config: { routes: [{ name: "auto", method: "cheapest", targets: ["pricey/frontier", "cheap/small"] }] },
  }));
});

test("a round-robin route rotates the head on each user turn", { timeout: 20000 }, async () => {
  await withSession(async ({ registry }) => {
    const virtual = registry.getModel("router", "auto")!;
    const messages = [{ role: "user", content: [{ type: "text", text: "route me" }] }];
    const pick = async () => (await (registry as any).resolveModel(virtual, messages, { reason: "user", thinkingLevel: "off" })).model.provider;
    assert.deepEqual([await pick(), await pick(), await pick()], ["primary", "secondary", "primary"]);
  }, (seen) => ({
    providers: [
      { name: "primary", config: fakeProvider("primary", ["main-model"], seen).config },
      { name: "secondary", config: fakeProvider("secondary", ["backup-model"], seen).config },
    ],
    config: { routes: [{ name: "auto", method: "round-robin", targets: ["primary/main-model", "secondary/backup-model"] }] },
  }));
});

test("when:\"failure\" keeps the answering model on the next user turn", { timeout: 20000 }, async () => {
  await withSession(async ({ registry }) => {
    const virtual = registry.getModel("router", "auto")!;
    const previous = {
      api: "scripted", provider: "secondary", model: "backup-model",
      content: [{ type: "text", text: "ok" }], timestamp: Date.now(), stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    };
    const messages: any = [
      { role: "user", content: [{ type: "text", text: "pick" }] },
      { role: "assistant", ...previous },
    ];
    const kept = await (registry as any).resolveModel(virtual, messages, { reason: "user", thinkingLevel: "off" });
    assert.equal(kept.model.provider, "secondary", "the turn stayed on the model that answered instead of the head");
  }, (seen) => ({
    providers: [
      { name: "primary", config: fakeProvider("primary", ["main-model"], seen).config },
      { name: "secondary", config: fakeProvider("secondary", ["backup-model"], seen).config },
    ],
    config: { routes: [{ name: "auto", when: "failure", targets: ["primary/main-model", "secondary/backup-model"] }] },
  }));
});

test("reloading a config that dropped a route unregisters it from the catalog", { timeout: 20000 }, async () => {
  await withSession(async ({ dir, session, registry }) => {
    assert.ok(registry.getModel("router", "auto"), "the route starts registered");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "account-router.json"), JSON.stringify({ routes: [] }));
    const command = session.extensionRunner.getRegisteredCommands().find((c: any) => c.invocationName === "router");
    const logs: string[] = [];
    const original = console.log;
    console.log = (line: string) => { logs.push(String(line)); };
    try {
      await command.handler("reload", { hasUI: false, cwd: dir, modelRegistry: registry } as any);
    } finally {
      console.log = original;
    }
    assert.equal(registry.getModel("router", "auto"), undefined, "a deleted route is no longer selectable");
  }, (seen) => ({
    providers: [{ name: "primary", config: fakeProvider("primary", ["main-model"], seen).config }],
    config: { routes: [{ name: "auto", targets: ["primary/main-model"] }] },
  }));
});

test("reloading a config that added a pool registers its shadow provider", { timeout: 20000 }, async () => {
  await withSession(async ({ dir, session, registry }) => {
    // A newly saved pool used to stay invisible to every model picker
    // (including /agent-model) until /router reload or a new session, because
    // the editor's reload refreshed virtual routes but never pool providers.
    assert.equal(registry.getModel("pool:ag", "gemini-pro"), undefined, "no pool before the reload");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "account-router.json"), JSON.stringify({
      pools: { ag: { provider: "antigravity", source: "antigravity-accounts", strategy: "round-robin" } },
      routes: [],
    }));
    const command = session.extensionRunner.getRegisteredCommands().find((c: any) => c.invocationName === "router");
    const original = console.log;
    console.log = () => {};
    try {
      // Production hands the extension a ModelRegistry facade, not the raw runtime.
      await command.handler("reload", { hasUI: false, cwd: dir, modelRegistry: new ModelRegistry(registry) } as any);
    } finally {
      console.log = original;
    }
    assert.ok(registry.getModel("pool:ag", "gemini-pro"), "the pool's shadow provider is registered after reload");
  }, (seen) => ({
    providers: [{ name: "antigravity", config: fakeProvider("antigravity", ["gemini-pro"], seen).config }],
    config: { routes: [] },
  }));
});

test("a route with no usable target fails with a clear reason", { timeout: 20000 }, async () => {
  await withSession(async ({ registry }) => {
    const virtual = registry.getModel("router", "auto")!;
    const message = await registry.completeSimple(virtual, {
      messages: [{ role: "user", content: [{ type: "text", text: "route me" }] }],
    });
    assert.equal(message.stopReason, "error");
    assert.match(message.errorMessage ?? "", /not registered|no credentials/);
  }, (_seen) => ({
    providers: [],
    config: { routes: [{ name: "auto", targets: ["nowhere/ghost"] }] },
  }));
});

// ── Config surface ───────────────────────────────────────────────────────────

test("the /router command reports routes and pool health without a UI", { timeout: 20000 }, async () => {
  await withSession(async ({ session }) => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => { lines.push(String(line)); };
    try {
      const command = session.extensionRunner.getRegisteredCommands().find((c: any) => c.invocationName === "router");
      assert.ok(command, "/router is registered");
      await command.handler("", { hasUI: false, cwd: process.cwd() } as any);
      await command.handler("help", { hasUI: false, cwd: process.cwd() } as any);
    } finally {
      console.log = original;
    }
    const text = lines.join("\n");
    assert.match(text, /Routes/);
    assert.match(text, /Pools/);
    assert.match(text, /round-robin/);
  }, (seen) => ({
    providers: [{ name: "antigravity", config: fakeProvider("antigravity", ["gemini-pro"], seen).config }],
    config: {
      pools: { ag: { provider: "antigravity", source: "antigravity-accounts", strategy: "round-robin" } },
      routes: [{ name: "auto", targets: [{ model: "antigravity/gemini-pro", pool: "ag" }] }],
    },
  }));
});

test("the sidebar displays the active account and cycles across requests", { timeout: 20000 }, async () => {
  const accountOffers: any[] = [];
  await withSession(async ({ registry, eventBus }) => {
    eventBus.on(SECTION_EVENT, (offer: SectionOffer) => {
      if (offer.section.id === "account") {
        accountOffers.push(structuredClone(offer.section));
        offer.handled = true;
      }
    });

    const model = registry.getModel(poolProviderId("ag"), "gemini-pro")!;
    assert.ok(model);

    eventBus.emit("workflow-ui:refresh", undefined);
    assert.ok(accountOffers.length > 0);
    const initial = accountOffers[accountOffers.length - 1];
    assert.equal(initial.title, "Account (ag)");
    assert.match(initial.rows[0], /one@x\.com \(1\/3\)/);

    // Turn 1: uses account 1
    await registry.completeSimple(model, {
      messages: [{ role: "user", content: [{ type: "text", text: "turn 1" }] }],
    });
    const afterTurn1 = accountOffers[accountOffers.length - 1];
    assert.match(afterTurn1.rows[0], /one@x\.com \(1\/3\)/);

    // Turn 2: rotates to account 2
    await registry.completeSimple(model, {
      messages: [{ role: "user", content: [{ type: "text", text: "turn 2" }] }],
    });
    const afterTurn2 = accountOffers[accountOffers.length - 1];
    assert.match(afterTurn2.rows[0], /two@x\.com \(2\/3\)/);

    // Turn 3: rotates to account 3
    await registry.completeSimple(model, {
      messages: [{ role: "user", content: [{ type: "text", text: "turn 3" }] }],
    });
    const afterTurn3 = accountOffers[accountOffers.length - 1];
    assert.match(afterTurn3.rows[0], /three@x\.com \(3\/3\)/);

    // Turn 4: wraps around back to account 1
    await registry.completeSimple(model, {
      messages: [{ role: "user", content: [{ type: "text", text: "turn 4" }] }],
    });
    const afterTurn4 = accountOffers[accountOffers.length - 1];
    assert.match(afterTurn4.rows[0], /one@x\.com \(1\/3\)/);
  }, (seen) => ({
    providers: [{ name: "antigravity", config: fakeProvider("antigravity", ["gemini-pro"], seen).config }],
    config: {
      pools: { ag: { provider: "antigravity", source: "antigravity-accounts", strategy: "round-robin" } },
      routes: [{ name: "auto", targets: [{ model: "antigravity/gemini-pro", pool: "ag" }] }],
    },
  }));
});

test("pools automatically discover accounts from models.json and rotate across them", { timeout: 20000 }, async () => {
  await withSession(async ({ registry, seen }) => {
    const model = registry.getModel(poolProviderId("or"), "llama-3")!;
    assert.ok(model, "Shadow provider model for pool or exists");

    // Request 1: uses first account from models.json (openrouter-1 with key-1)
    await registry.completeSimple(model, {
      messages: [{ role: "user", content: [{ type: "text", text: "req 1" }] }],
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].key, "key-1");

    // Request 2: rotates to second account from models.json (openrouter-2 with key-2)
    await registry.completeSimple(model, {
      messages: [{ role: "user", content: [{ type: "text", text: "req 2" }] }],
    });
    assert.equal(seen.length, 2);
    assert.equal(seen[1].key, "key-2");

    // Request 3: wraps back to account 1
    await registry.completeSimple(model, {
      messages: [{ role: "user", content: [{ type: "text", text: "req 3" }] }],
    });
    assert.equal(seen.length, 3);
    assert.equal(seen[2].key, "key-1");
  }, (seen) => ({
    providers: [
      { name: "openrouter-1", config: fakeProvider("openrouter-1", ["llama-3"], seen).config },
      { name: "openrouter-2", config: fakeProvider("openrouter-2", ["llama-3"], seen).config },
    ],
    modelsConfig: {
      providers: {
        "openrouter-1": {
          name: "OpenRouter (Account 1)",
          apiKey: "key-1",
          baseUrl: "http://127.0.0.1:1",
          api: "scripted",
          models: [{ id: "llama-3", name: "llama-3" }],
        },
        "openrouter-2": {
          name: "OpenRouter (Account 2)",
          apiKey: "key-2",
          baseUrl: "http://127.0.0.1:1",
          api: "scripted",
          models: [{ id: "llama-3", name: "llama-3" }],
        },
      },
    },
    config: {
      pools: {
        or: {
          provider: "openrouter",
          strategy: "round-robin",
        },
      },
      routes: [
        { name: "auto", targets: [{ model: "openrouter/llama-3", pool: "or" }] },
      ],
    },
  }));
});

test("the sidebar displays all configured pools when multiple pools exist", { timeout: 20000 }, async () => {
  const accountOffers: any[] = [];
  await withSession(async ({ eventBus }) => {
    eventBus.on(SECTION_EVENT, (offer: SectionOffer) => {
      if (offer.section.id === "account") {
        accountOffers.push(structuredClone(offer.section));
        offer.handled = true;
      }
    });

    eventBus.emit("workflow-ui:refresh", undefined);
    assert.ok(accountOffers.length > 0);
    const offer = accountOffers[accountOffers.length - 1];
    assert.equal(offer.title, "Router Pools (2)");
    assert.equal(offer.rows.length, 2);
    assert.match(offer.rows.find((r: string) => r.includes("p1"))!, /p1: acc-a \(1\/2\)/);
    assert.match(offer.rows.find((r: string) => r.includes("p2"))!, /p2: acc-c \(1\/1\)/);
  }, (seen) => ({
    providers: [
      { name: "b1", config: fakeProvider("b1", ["chat"], seen).config },
      { name: "b2", config: fakeProvider("b2", ["chat"], seen).config },
    ],
    config: {
      pools: {
        p1: { provider: "b1", strategy: "round-robin", accounts: [{ id: "acc-a" }, { id: "acc-b" }] },
        p2: { provider: "b2", strategy: "priority", accounts: [{ id: "acc-c" }] },
      },
    },
  }));
});


