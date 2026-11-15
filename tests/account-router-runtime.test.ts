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
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  /**
   * Report a prompt cache of this size: the first request to a (credential,
   * model) writes it and later ones read it, which is what a warm provider does.
   */
  cache?: { promptTokens: number };
} = {}) {
  const model = (modelId: string) => ({
    id: modelId, name: modelId, provider: id, api: "scripted", baseUrl: "http://127.0.0.1:1",
    reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 2_000,
    cost: { input: options.cost?.input ?? 0, output: options.cost?.output ?? 0, cacheRead: options.cost?.cacheRead ?? 0, cacheWrite: options.cost?.cacheWrite ?? 0 },
  });
  // Cache state lives with the provider, so a second account starts cold.
  const written = new Set<string>();
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
        const cacheId = `${key}/${m.id}`;
        const warm = written.has(cacheId);
        if (options.cache) written.add(cacheId);
        const prompt = options.cache?.promptTokens;
        const usage = prompt === undefined
          ? { input: options.inputTokens ?? 0, output: options.outputTokens ?? 0, cacheRead: 0, cacheWrite: 0 }
          : warm
            ? { input: 0, output: options.outputTokens ?? 0, cacheRead: prompt, cacheWrite: 0 }
            // A write is the whole prompt stored; `input` counts only the
            // uncached remainder, so a cold request bills it as a write.
            : { input: 0, output: options.outputTokens ?? 0, cacheRead: 0, cacheWrite: prompt };
        const message: any = {
          role: "assistant", api: m.api, provider: m.provider, model: m.id,
          timestamp: Date.now(), content: [],
          usage: { ...usage, totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite },
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

test("the right sidebar no longer shows an Account section", { timeout: 20000 }, async () => {
  const accountOffers: any[] = [];
  await withSession(async ({ registry, eventBus }) => {
    eventBus.on(SECTION_EVENT, (offer: SectionOffer) => {
      if (offer.section.id === "account") accountOffers.push(structuredClone(offer.section));
    });
    const model = registry.getModel(poolProviderId("ag"), "gemini-pro")!;
    eventBus.emit("workflow-ui:refresh", undefined);
    await registry.completeSimple(model, {
      messages: [{ role: "user", content: [{ type: "text", text: "turn" }] }],
    });
    assert.ok(accountOffers.length > 0, "the section is still cleared so a stale one disappears");
    assert.ok(accountOffers.every((section) => section.rows.length === 0), "no account rows are ever offered");
  }, (seen) => ({
    providers: [{ name: "antigravity", config: fakeProvider("antigravity", ["gemini-pro"], seen).config }],
    config: {
      pools: { ag: { provider: "antigravity", source: "antigravity-accounts", strategy: "round-robin" } },
      routes: [{ name: "auto", targets: [{ model: "antigravity/gemini-pro", pool: "ag" }] }],
    },
  }));
});

test("a route that just failed on its head target starts the next turn on a working one", { timeout: 20000 }, async () => {
  // Without a failure memory every user turn began at the head target again, so
  // each turn paid a failed request plus Pi's retry backoff before it reached a
  // model that works.
  await withSession(async ({ registry }) => {
    const virtual = registry.getModel("router", "auto")!;
    const messages: any = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    const pick = async (extra: object = {}) =>
      (await (registry as any).resolveModel(virtual, messages, { reason: "user", thinkingLevel: "off", ...extra })).model.provider;
    assert.equal(await pick(), "primary", "healthy route starts at the head");
    const failed = {
      api: "scripted", provider: "primary", model: "main-model", content: [], timestamp: Date.now(),
      stopReason: "error", errorMessage: "429 quota exceeded",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    };
    assert.equal(await pick({ reason: "retry", failed }), "secondary", "the retry moves past the failed target");
    assert.equal(await pick(), "secondary", "the next user turn does not return to the cooling head");
  }, (seen) => ({
    providers: [
      { name: "primary", config: fakeProvider("primary", ["main-model"], seen).config },
      { name: "secondary", config: fakeProvider("secondary", ["backup-model"], seen).config },
    ],
    config: { routes: [{ name: "auto", targets: ["primary/main-model", "secondary/backup-model"] }] },
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

test("inside one agent run a pool keeps its account so the prompt cache stays warm", { timeout: 20000 }, async () => {
  await withSession(async ({ seen, registry, session }) => {
    const model = registry.getModel(poolProviderId("ag"), "gemini-pro")!;
    const ask = (text: string) => registry.completeSimple(model, {
      messages: [{ role: "user", content: [{ type: "text", text }] }],
    });
    const runner = session._extensionRunner;
    await runner.emit({ type: "agent_start" });
    await ask("a");
    await ask("b");
    await runner.emit({ type: "agent_end", messages: [] });
    await ask("c");
    const tokens = seen.map((entry) => JSON.parse(entry.key).token);
    assert.equal(tokens[0], tokens[1], "continuations of one run stay on one account");
    assert.notEqual(tokens[2], tokens[1], "rotation resumes with the next prompt");
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

// ── Prompt-cache warmth ──────────────────────────────────────────────────────

/**
 * Run one `/router` subcommand and return what it printed.
 *
 * `registry` is only needed by commands that re-read the config: production
 * hands the extension a `ModelRegistry` facade, so a reload without one would
 * fail on the first pool.
 */
async function routerText(session: any, args: string, cwd: string, registry?: any): Promise<string> {
  const lines: string[] = [];
  const command = session.extensionRunner.getRegisteredCommands().find((c: any) => c.invocationName === "router");
  const original = console.log;
  console.log = (line: string) => { lines.push(String(line)); };
  try {
    await command.handler(args, {
      hasUI: false, cwd,
      ...(registry ? { modelRegistry: new ModelRegistry(registry) } : {}),
    } as any);
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

test("a request that read the prompt cache shows its target as warm in /router status", { timeout: 20000 }, async () => {
  await withSession(async ({ registry, session, dir }) => {
    const virtual = registry.getModel("router", "auto")!;
    const runner = session._extensionRunner;
    const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
    const ask = async () => {
      const message = await registry.completeSimple(virtual, { messages });
      await runner.emit({ type: "message_end", message });
      return message;
    };
    await ask();
    // A write makes the entry exist, so it is warm, but nothing was read yet.
    assert.match(await routerText(session, "status", dir), /primary\/main-model\s+warm 60k · \d+m left · 0% hit/);
    const second = await ask();
    assert.equal(second.usage.cacheRead, 60_000, "the provider served it from cache");
    assert.match(await routerText(session, "status", dir), /warm 60k · \d+m left · 100% hit/);
  }, (seen) => ({
    providers: [{ name: "primary", config: fakeProvider("primary", ["main-model"], seen, { cache: { promptTokens: 60_000 } }).config }],
    config: { routes: [{ name: "auto", targets: ["primary/main-model"] }] },
  }));
});

test("a pooled target reports the account that holds the warm prefix", { timeout: 20000 }, async () => {
  await withSession(async ({ registry, session, dir }) => {
    const model = registry.getModel(poolProviderId("ag"), "gemini-pro")!;
    const runner = session._extensionRunner;
    const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
    for (const _ of [1, 2]) {
      const message = await registry.completeSimple(model, { messages });
      await runner.emit({ type: "message_end", message });
    }
    const status = await routerText(session, "status", dir);
    // The account is the cache owner, so warmth is reported per account.
    assert.match(status, /one@x\.com\s+warm 60k/);
    assert.match(status, /two@x\.com\s+–/, "an account never used has no cache evidence");
    assert.match(await routerText(session, "accounts ag", dir), /one@x\.com: ok · warm 60k/);
  }, (seen) => ({
    providers: [{ name: "antigravity", config: fakeProvider("antigravity", ["gemini-pro"], seen, { cache: { promptTokens: 60_000 } }).config }],
    config: {
      pools: { ag: { provider: "antigravity", source: "antigravity-accounts", strategy: "priority" } },
      routes: [{ name: "auto", targets: [{ model: "antigravity/gemini-pro", pool: "ag" }] }],
    },
  }));
});

test("the ledger rides in the virtual model's state, so a branch switch restores that branch's warmth", { timeout: 20000 }, async () => {
  await withSession(async ({ registry, session }) => {
    const virtual = registry.getModel("router", "auto")!;
    const runner = session._extensionRunner;
    const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
    const resolve = async (state?: unknown) =>
      (await (registry as any).resolveModel(virtual, messages, { reason: "user", thinkingLevel: "off", ...(state ? { state } : {}) }));
    const message = await registry.completeSimple(virtual, { messages });
    await runner.emit({ type: "message_end", message });
    const own = await resolve();
    assert.ok(own.state?.entries["primary/main-model"], "the ledger is handed to Pi with the route");
    // A different branch's state is the truth once it is handed back.
    const other = { version: 1, entries: { "other/model": { lastAt: 5, prefixTokens: 900, readTokens: 0, reportsCache: true, misses: 0 } } };
    const adopted = await resolve(other);
    assert.deepEqual(Object.keys(adopted.state.entries), ["other/model"]);
    // A direct request carries no state; it must not discard what we observed.
    const afterDirect = await resolve();
    assert.deepEqual(Object.keys(afterDirect.state.entries), ["other/model"]);
  }, (seen) => ({
    providers: [{ name: "primary", config: fakeProvider("primary", ["main-model"], seen, { cache: { promptTokens: 60_000 } }).config }],
    config: { routes: [{ name: "auto", targets: ["primary/main-model"] }] },
  }));
});

test("a cache route keeps the warm target until a cheaper one repays its cache write", { timeout: 20000 }, async () => {
  const routes = (horizon: number) => ({
    cache: { horizon },
    routes: [
      // Warm the expensive target through a plain route: warmth belongs to the
      // conversation and the model, not to the route that happened to use it.
      { name: "warmup", targets: ["primary/main-model"] },
      { name: "auto", method: "cache", targets: ["primary/main-model", "secondary/backup-model"] },
    ],
  });
  await withSession(async ({ registry, session, dir }) => {
    const runner = session._extensionRunner;
    const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
    const warmup = registry.getModel("router", "warmup")!;
    for (const _ of [1, 2]) {
      const message = await registry.completeSimple(warmup, { messages });
      await runner.emit({ type: "message_end", message });
    }
    const auto = registry.getModel("router", "auto")!;
    const pick = async () => (await (registry as any).resolveModel(auto, messages, { reason: "user", thinkingLevel: "off" })).model.provider;
    assert.equal(await pick(), "primary", "2x dearer is kept while its cache is warm");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "account-router.json"), JSON.stringify(routes(20)));
    await routerText(session, "reload", dir);
    assert.equal(await pick(), "secondary", "over 20 turns the cheap target repays its write");
  }, (seen) => ({
    providers: [
      { name: "primary", config: fakeProvider("primary", ["main-model"], seen, { cache: { promptTokens: 60_000 }, cost: { input: 2, output: 0 } }).config },
      { name: "secondary", config: fakeProvider("secondary", ["backup-model"], seen, { cost: { input: 1, output: 0 } }).config },
    ],
    config: routes(3),
  }));
});

// ── Cache affinity ───────────────────────────────────────────────────────────

const affinityConfig = (ttlMs: number) => ({
  cache: { ttlMs: { "*": ttlMs } },
  pools: { ag: { provider: "antigravity", source: "antigravity-accounts", strategy: "round-robin", cacheAffinity: "warm" } },
  routes: [{ name: "auto", targets: [{ model: "antigravity/gemini-pro", pool: "ag" }] }],
});

test("cacheAffinity warm keeps one account across prompts and rotates once the TTL lapses", { timeout: 20000 }, async () => {
  await withSession(async ({ registry, session, dir, seen }) => {
    const model = registry.getModel(poolProviderId("ag"), "gemini-pro")!;
    const runner = session._extensionRunner;
    const prompt = async (text: string) => {
      await runner.emit({ type: "agent_start" });
      const message = await registry.completeSimple(model, { messages: [{ role: "user", content: [{ type: "text", text }] }] });
      await runner.emit({ type: "message_end", message });
      await runner.emit({ type: "agent_end", messages: [] });
    };
    await prompt("a");
    await prompt("b");
    const tokens = seen.map((entry) => JSON.parse(entry.key).token);
    assert.equal(tokens[0], tokens[1], "the account that wrote the cache keeps it across prompts");
    // A TTL that has already lapsed: the cache no longer holds the account.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "account-router.json"), JSON.stringify(affinityConfig(1)));
    await routerText(session, "reload", dir, registry);
    await prompt("c");
    const after = seen.map((entry) => JSON.parse(entry.key).token);
    assert.notEqual(after[2], after[1], "a cold cache rotates the pool again");
  }, (seen) => ({
    providers: [{ name: "antigravity", config: fakeProvider("antigravity", ["gemini-pro"], seen, { cache: { promptTokens: 60_000 } }).config }],
    config: affinityConfig(300_000),
  }));
});

test("a quota wall still moves the pool at once, affinity or not, and the new account is then kept", { timeout: 20000 }, async () => {
  await withSession(async ({ registry, session, seen }) => {
    const model = registry.getModel(poolProviderId("ag"), "gemini-pro")!;
    const runner = session._extensionRunner;
    const prompt = async (text: string) => {
      await runner.emit({ type: "agent_start" });
      const message = await registry.completeSimple(model, { messages: [{ role: "user", content: [{ type: "text", text }] }] });
      await runner.emit({ type: "message_end", message });
      await runner.emit({ type: "agent_end", messages: [] });
      return message;
    };
    const first = await prompt("a");
    assert.equal(first.stopReason, "error", "the wall is surfaced, not hidden");
    await prompt("b");
    await prompt("c");
    const tokens = seen.map((entry) => JSON.parse(entry.key).token);
    assert.deepEqual(tokens, ["tok-one", "tok-two", "tok-two"], "the wall moved the pool; the working account is then kept");
  }, (seen) => ({
    providers: [{
      name: "antigravity",
      config: fakeProvider("antigravity", ["gemini-pro"], seen, {
        cache: { promptTokens: 60_000 },
        failWith: (key: string) => (key.includes("tok-one") ? "429 rate limit exceeded, please wait 5h" : undefined),
      }).config,
    }],
    config: affinityConfig(300_000),
  }));
});

test("/router status warns about a route policy that re-writes the prompt cache every turn", { timeout: 20000 }, async () => {
  await withSession(async ({ session, dir }) => {
    const status = await routerText(session, "status", dir);
    assert.match(status, /rotates the head every turn; each turn re-writes the prompt cache/);
    assert.match(status, /a price gap under ~5× costs more in cache re-writes than it saves; consider method: "cache"/);
  }, (seen) => ({
    providers: [
      { name: "primary", config: fakeProvider("primary", ["main-model"], seen).config },
      { name: "secondary", config: fakeProvider("secondary", ["backup-model"], seen).config },
    ],
    config: {
      routes: [
        { name: "spin", method: "round-robin", targets: ["primary/main-model", "secondary/backup-model"] },
        { name: "cheap", method: "cheapest", targets: ["primary/main-model", "secondary/backup-model"] },
        { name: "auto", method: "cache", targets: ["primary/main-model", "secondary/backup-model"] },
      ],
    },
  }));
});

test("/router why explains a cache non-switch and a fallback, and forgets another branch's decisions", { timeout: 20000 }, async () => {
  await withSession(async ({ registry, session, dir }) => {
    const runner = session._extensionRunner;
    const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
    const warmup = registry.getModel("router", "warmup")!;
    for (const _ of [1, 2]) {
      const message = await registry.completeSimple(warmup, { messages });
      await runner.emit({ type: "message_end", message });
    }
    const auto = registry.getModel("router", "auto")!;
    await (registry as any).resolveModel(auto, messages, { reason: "user", thinkingLevel: "off" });
    const trace = await routerText(session, "why", dir);
    assert.match(trace, /auto · user · → primary\/main-model · stayed: cache warm/, "the non-switch is explained");
    // A branch switch made other decisions; the trace must not claim them.
    await runner.emit({ type: "session_tree" });
    assert.match(await routerText(session, "why", dir), /No routing decisions yet/);
  }, (seen) => ({
    providers: [
      { name: "primary", config: fakeProvider("primary", ["main-model"], seen, { cache: { promptTokens: 60_000 }, cost: { input: 2, output: 0 } }).config },
      { name: "secondary", config: fakeProvider("secondary", ["backup-model"], seen, { cost: { input: 1, output: 0 } }).config },
    ],
    config: {
      routes: [
        { name: "warmup", targets: ["primary/main-model"] },
        { name: "auto", method: "cache", targets: ["primary/main-model", "secondary/backup-model"] },
      ],
    },
  }));
});

test("/router why names the target that could not serve", { timeout: 20000 }, async () => {
  await withSession(async ({ registry, session, dir }) => {
    const virtual = registry.getModel("router", "auto")!;
    // Routing fails loudly; the trace is what makes the failure explainable.
    await assert.rejects(
      async () => (registry as any).resolveModel(virtual, [{ role: "user", content: [{ type: "text", text: "go" }] }],
        { reason: "user", thinkingLevel: "off" }),
      /provider "nowhere" is not registered/,
    );
    const trace = await routerText(session, "why", dir);
    assert.match(trace, /→ no target/);
    assert.match(trace, /skipped nowhere\/ghost \(provider "nowhere" is not registered/);
  }, (_seen) => ({
    providers: [],
    config: { routes: [{ name: "auto", targets: ["nowhere/ghost"] }] },
  }));
});

test("compaction forgets the cache, because the prefix it described is gone", { timeout: 20000 }, async () => {
  await withSession(async ({ registry, session, dir }) => {
    const virtual = registry.getModel("router", "auto")!;
    const runner = session._extensionRunner;
    const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
    for (const _ of [1, 2]) {
      const message = await registry.completeSimple(virtual, { messages });
      await runner.emit({ type: "message_end", message });
    }
    assert.match(await routerText(session, "status", dir), /warm 60k/);
    await runner.emit({ type: "session_compact" });
    assert.doesNotMatch(await routerText(session, "status", dir), /warm 60k/,
      "a summary is a new prefix, so no entry describes it");
  }, (seen) => ({
    providers: [{ name: "primary", config: fakeProvider("primary", ["main-model"], seen, { cache: { promptTokens: 60_000 } }).config }],
    config: { routes: [{ name: "auto", targets: ["primary/main-model"] }] },
  }));
});

// ── The router right-sidebar panel ───────────────────────────────────────────

test("the router publishes the selected route rather than the first configured route", { timeout: 20000 }, async () => {
  await withSession(async ({ eventBus, session, registry }) => {
    await session.setModel(registry.getModel("router", "auto"));
    const views: any[] = [];
    eventBus.on("web-plugin:view", (payload: any) => {
      if (payload?.pluginId === "router") views.push(payload.view);
    });
    // The panel view is published at session start, so a late attach still sees it.
    eventBus.emit("web-plugin:ui-sync", {});
    const view = views.at(-1);
    assert.equal(view?.type, "graph");
    assert.equal(view?.title, "Routing");
    const route = (view?.nodes ?? []).find((node: any) => node.id === "route");
    assert.ok(route, "the panel has a route node");
    assert.equal(route.label, "router/auto");
    assert.equal(route.status, "done", "a healthy route is done, not blocked");
    assert.match(route.detail ?? "", /primary\/main-model/);
  }, (seen) => ({
    providers: [{ name: "primary", config: fakeProvider("primary", ["main-model"], seen).config }],
    config: { routes: [{ name: "auto", targets: ["primary/main-model"] }] },
  }));
});

test("the panel is a read-only visualization: it has no edit action", { timeout: 20000 }, async () => {
  await withSession(async ({ eventBus, session, registry }) => {
    await session.setModel(registry.getModel("router", "auto"));
    const views: any[] = [];
    eventBus.on("web-plugin:view", (payload: any) => {
      if (payload?.pluginId === "router") views.push(payload.view);
    });
    eventBus.emit("web-plugin:ui-sync", {});
    const view = views.at(-1);
    // A graph view carries no action ids; the panel's only action is reload,
    // and it is declared on the descriptor, not on the view.
    assert.equal(view?.type, "graph");
  }, (seen) => ({
    providers: [{ name: "primary", config: fakeProvider("primary", ["main-model"], seen).config }],
    config: { routes: [{ name: "auto", targets: ["primary/main-model"] }] },
  }));
});

test("each routed request republishes the newly selected target without a config reload", { timeout: 20000 }, async () => {
  await withSession(async ({ eventBus, session, registry }) => {
    const views: any[] = [];
    eventBus.on("web-plugin:view", (payload: any) => {
      if (payload?.pluginId === "router") views.push(payload.view);
    });
    await session.setModel(registry.getModel("router", "auto"));
    await session.prompt("first");
    assert.equal(views.at(-1)?.nodes.find((node: any) => node.status === "active")?.label, "primary/main-model");
    await session.prompt("second");
    assert.equal(views.at(-1)?.nodes.find((node: any) => node.status === "active")?.label, "backup/other");
    assert.equal(views.at(-1)?.nodes.filter((node: any) => node.status === "active").length, 1);
  }, seen => ({
    providers: [
      { name: "primary", config: fakeProvider("primary", ["main-model"], seen).config },
      { name: "backup", config: fakeProvider("backup", ["other"], seen).config },
    ],
    config: { routes: [{ name: "auto", targets: ["primary/main-model", "backup/other"], method: "round-robin", when: "turn" }] },
  }));
});

test("switching model selection republishes only that route, and clears the diagram for a physical model", { timeout: 20000 }, async () => {
  await withSession(async ({ eventBus, session, registry }) => {
    const views: any[] = [];
    eventBus.on("web-plugin:view", (payload: any) => {
      if (payload?.pluginId === "router") views.push(payload.view);
    });
    await session.setModel(registry.getModel("router", "second"));
    assert.equal(views.at(-1)?.nodes[0]?.label, "router/second");
    assert.equal(views.at(-1)?.nodes.some((node: any) => node.label === "router/first"), false);
    await session.setModel(registry.getModel("primary", "main-model"));
    assert.equal(views.at(-1)?.nodes[0]?.label, "Select a route model");
  }, seen => ({
    providers: [{ name: "primary", config: fakeProvider("primary", ["main-model"], seen).config }],
    config: { routes: [
      { name: "first", targets: ["primary/main-model"] },
      { name: "second", targets: ["primary/main-model"] },
    ] },
  }));
});

// ── The web route editor ─────────────────────────────────────────────────────

/** Every view the router published to the web bus, newest last. */
function routerViews(eventBus: any): any[] {
  const views: any[] = [];
  eventBus.on("web-plugin:view", (payload: any) => {
    if (payload?.pluginId === "router-editor") views.push(payload.view);
  });
  return views;
}

test("the web editor lists the routes and creates one through the dialog", { timeout: 20000 }, async () => {
  await withSession(async ({ dir, eventBus }) => {
    const views = routerViews(eventBus);
    const commands: any[] = [];
    eventBus.on("web-plugin:commands", (payload: any) => commands.push(...(payload?.commands ?? [])));

    // The extension announces its page; the shared dialog lists it beside
    // "Models" and "Provider".
    eventBus.emit("web-plugin:ui-sync", {});
    const announced = commands.find((command) => command.name === "router");
    assert.equal(announced?.managesModels, true, "it gets a page in the shared settings dialog");
    assert.equal(announced?.settingsEntry, "Router");
    assert.equal(announced?.settingsPlugin, "router-editor");
    assert.equal(announced?.addsModels, undefined, "the picker's add entry stays the provider editor's");

    // Opening the page shows the table.
    eventBus.emit("web-plugin:web-command", { name: "router", args: "" });
    const list = views.at(-1);
    assert.equal(list?.id, "router-editor:list");
    assert.equal(list?.items?.[0]?.label, "router/auto");

    // A new route: the form, then the picker, then a save that writes the file.
    eventBus.emit("web-plugin:action-request", { pluginId: "router-editor", actionId: "router-open" });
    const form = views.at(-1);
    assert.equal(form?.id, "router-editor:form:new");
    assert.equal(form?.fields?.find((field: any) => field.name === "name")?.value, "route-1");

    eventBus.emit("web-plugin:action-request", {
      pluginId: "router-editor", actionId: "router-targets",
      values: { name: "fast", file: "project", method: "cache", when: "quota" },
    });
    const picker = views.at(-1);
    assert.equal(picker?.id, "router-editor:targets:new");

    eventBus.emit("web-plugin:action-request", {
      pluginId: "router-editor", actionId: "router-toggle",
      values: { model: "primary/main-model" },
    });
    assert.equal(views.at(-1)?.items?.find((item: any) => item.label === "primary/main-model")?.selected, true);

    eventBus.emit("web-plugin:action-request", { pluginId: "router-editor", actionId: "router-back" });
    eventBus.emit("web-plugin:action-request", {
      pluginId: "router-editor", actionId: "router-save",
      values: { name: "fast", method: "cache", when: "quota" },
    });

    const saved = JSON.parse(await readFile(join(dir, ".pi", "account-router.json"), "utf8"));
    // A target with no pool or thinking level is written in the short form the
    // hand-written files use, so the editor does not churn a config.
    assert.deepEqual(saved.routes, [{
      name: "fast",
      targets: ["primary/main-model"],
      method: "cache",
      when: "quota",
    }]);
    assert.match(views.at(-1)?.lines?.join("\n") ?? "", /Saved router\/fast/);
    assert.equal(views.at(-1)?.id, "router-editor:list", "a save lands back on the table");

    // The new route is registered as a virtual model immediately.
    assert.ok(views.at(-1)?.items?.some((item: any) => item.label === "router/fast"));
  }, (seen) => ({
    providers: [{ name: "primary", config: fakeProvider("primary", ["main-model"], seen).config }],
    config: { routes: [{ name: "auto", targets: ["primary/main-model"] }] },
  }));
});

test("the web editor deletes only after the confirmation screen", { timeout: 20000 }, async () => {
  await withSession(async ({ dir, eventBus }) => {
    const views = routerViews(eventBus);
    eventBus.emit("web-plugin:web-command", { name: "router", args: "" });
    eventBus.emit("web-plugin:action-request", {
      pluginId: "router-editor", actionId: "router-open", values: { route: "auto" },
    });
    assert.equal(views.at(-1)?.id, "router-editor:form:auto");

    eventBus.emit("web-plugin:action-request", { pluginId: "router-editor", actionId: "router-delete" });
    assert.equal(views.at(-1)?.title, "Delete router/auto?");
    // The route was read from the global file, so that is the one it is
    // removed from — the editor rewrites a route where it found it.
    const globalFile = join(dir, "account-router.json");
    let file = JSON.parse(await readFile(globalFile, "utf8"));
    assert.equal(file.routes.length, 1, "asking is not deleting");

    eventBus.emit("web-plugin:action-request", { pluginId: "router-editor", actionId: "router-delete-confirm" });
    file = JSON.parse(await readFile(globalFile, "utf8"));
    assert.deepEqual(file.routes, []);
    assert.match(views.at(-1)?.lines?.join("\n") ?? "", /Removed router\/auto/);
  }, (seen) => ({
    providers: [{ name: "primary", config: fakeProvider("primary", ["main-model"], seen).config }],
    config: { routes: [{ name: "auto", targets: ["primary/main-model"] }] },
  }));
});

test("the web editor refuses a name that is taken without writing", { timeout: 20000 }, async () => {
  await withSession(async ({ dir, eventBus }) => {
    const views = routerViews(eventBus);
    eventBus.emit("web-plugin:web-command", { name: "router", args: "" });
    eventBus.emit("web-plugin:action-request", { pluginId: "router-editor", actionId: "router-open" });
    eventBus.emit("web-plugin:action-request", {
      pluginId: "router-editor", actionId: "router-targets",
      values: { name: "auto", file: "project", method: "priority", when: "turn" },
    });
    eventBus.emit("web-plugin:action-request", {
      pluginId: "router-editor", actionId: "router-toggle", values: { model: "primary/main-model" },
    });
    // Done returns to the form with the pick, which is where Save lives.
    eventBus.emit("web-plugin:action-request", { pluginId: "router-editor", actionId: "router-back" });
    assert.equal(views.at(-1)?.id, "router-editor:form:new", "Done returns to the route");
    eventBus.emit("web-plugin:action-request", {
      pluginId: "router-editor", actionId: "router-save",
      values: { name: "auto", method: "priority", when: "turn" },
    });
    assert.equal(views.at(-1)?.id, "router-editor:form:new", "the refusal stays on the form");
    assert.match(views.at(-1)?.lines?.join("\n") ?? "", /already exists/);
    const file = JSON.parse(await readFile(join(dir, "account-router.json"), "utf8"));
    assert.equal(file.routes.length, 1, "nothing was written");
  }, (seen) => ({
    providers: [{ name: "primary", config: fakeProvider("primary", ["main-model"], seen).config }],
    config: { routes: [{ name: "auto", targets: ["primary/main-model"] }] },
  }));
});

test("closing the web editor publishes a closed view so the pane returns to the picker", { timeout: 20000 }, async () => {
  await withSession(async ({ eventBus }) => {
    const views = routerViews(eventBus);
    eventBus.emit("web-plugin:web-command", { name: "router", args: "" });
    assert.equal(views.at(-1)?.open, true, "the pane renders an open view");
    eventBus.emit("web-plugin:action-request", { pluginId: "router-editor", actionId: "router-back" });
    assert.equal(views.at(-1)?.open, false);
  }, (seen) => ({
    providers: [{ name: "primary", config: fakeProvider("primary", ["main-model"], seen).config }],
    config: { routes: [{ name: "auto", targets: ["primary/main-model"] }] },
  }));
});

test("the web picker filters a large catalogue without losing a tick", { timeout: 20000 }, async () => {
  await withSession(async ({ eventBus }) => {
    const views = routerViews(eventBus);
    eventBus.emit("web-plugin:web-command", { name: "router", args: "" });
    eventBus.emit("web-plugin:action-request", { pluginId: "router-editor", actionId: "router-open" });
    eventBus.emit("web-plugin:action-request", {
      pluginId: "router-editor", actionId: "router-targets",
      values: { name: "filtered", file: "project", method: "cache", when: "turn" },
    });
    const all = views.at(-1)?.items?.length ?? 0;
    assert.ok(all > 0, "the catalogue is listed");

    eventBus.emit("web-plugin:action-request", {
      pluginId: "router-editor", actionId: "router-toggle", values: { model: "primary/main-model" },
    });
    eventBus.emit("web-plugin:action-request", {
      pluginId: "router-editor", actionId: "router-filter", values: { filter: "main" },
    });
    const filtered = views.at(-1);
    assert.ok((filtered?.items?.length ?? 0) < all, "the filter narrows the list");
    assert.equal(filtered?.items?.find((item: any) => item.label === "primary/main-model")?.selected, true,
      "a ticked model stays ticked and listed");
    assert.match(filtered?.lines?.join("\n") ?? "", /1 match "main"/);
  }, (seen) => ({
    providers: [
      { name: "primary", config: fakeProvider("primary", ["main-model"], seen).config },
      { name: "backup", config: fakeProvider("backup", ["other-model"], seen).config },
    ],
    config: { routes: [{ name: "auto", targets: ["primary/main-model"] }] },
  }));
});
