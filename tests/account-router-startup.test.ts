import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionServices, resolveModelScopeWithDiagnostics, SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import accountRouter from "../extensions/account-router.ts";
import antigravityAccounts from "../extensions/antigravity-accounts.ts";

const model = (id: string, api = "openai-completions") => ({
  id, name: id, api, baseUrl: "http://127.0.0.1:1/v1", reasoning: false,
  input: ["text"], contextWindow: 100_000, maxTokens: 2_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-router-startup-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try { await run(dir); }
  finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

async function startup(dir: string, factories: ExtensionFactory[], enabledModels: string[], cwd = dir) {
  const services = await createAgentSessionServices({
    cwd, agentDir: dir,
    settingsManager: SettingsManager.inMemory({ enabledModels, cacheWarming: "off" }),
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: factories,
    },
  });
  assert.deepEqual(services.diagnostics, []);
  // This is the CLI startup boundary: no AgentSession or session_start exists yet.
  const resolved = await resolveModelScopeWithDiagnostics(enabledModels, services.modelRuntime);
  assert.deepEqual(resolved.diagnostics, [], "saved scopes must not lose router models at startup");
  assert.deepEqual(resolved.scopedModels.map(({ model: m }) => `${m.provider}/${m.id}`), enabledModels);
  return services;
}

test("saved pool and route scopes resolve before session_start, even with a later source extension", async () => fixture(async dir => {
  await writeFile(join(dir, "account-router.json"), JSON.stringify({
    pools: { shared: { provider: "scripted", accounts: [{ id: "one", apiKey: "test-key" }] } },
    routes: [{ name: "auto", targets: [{ model: "scripted/chat", pool: "shared" }] }],
  }));
  await startup(dir, [accountRouter, pi => pi.registerProvider("scripted", {
    apiKey: "test-key", models: [model("chat")] as never,
  })], ["pool:shared/chat", "router/auto"]);
}));

test("startup pools mirror models.json and keep separate providers for different APIs", async () => fixture(async dir => {
  await writeFile(join(dir, "models.json"), JSON.stringify({ providers: {
    local: { apiKey: "local", models: [model("chat"), model("responses", "openai-responses")] },
  } }));
  await writeFile(join(dir, "account-router.json"), JSON.stringify({ pools: {
    shared: { provider: "local", accounts: [{ id: "one", apiKey: "test-key" }] },
  } }));
  await startup(dir, [accountRouter], [
    "pool:shared#openai-completions/chat", "pool:shared#openai-responses/responses",
  ]);
}));

test("startup uses the loader project cwd, not the process cwd, for pool overrides", async () => fixture(async dir => {
  const cwd = join(dir, "project");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(dir, "account-router.json"), JSON.stringify({ pools: {
    shared: { provider: "missing", accounts: [{ id: "one", apiKey: "test-key" }] },
  } }));
  await writeFile(join(cwd, ".pi", "account-router.json"), JSON.stringify({ pools: {
    shared: { provider: "local", accounts: [{ id: "one", apiKey: "test-key" }] },
  } }));
  await writeFile(join(dir, "models.json"), JSON.stringify({ providers: {
    local: { apiKey: "local", models: [model("chat")] },
  } }));
  await startup(dir, [accountRouter], ["pool:shared/chat"], cwd);
}));

test("Antigravity account-family pools are selectable in saved startup scopes", async () => fixture(async dir => {
  await writeFile(join(dir, "antigravity-accounts.json"), JSON.stringify({ version: 1, accounts: {
    "one@example.test": { accountId: "one@example.test", access: "test-token", refresh: "test-refresh",
      expires: Date.now() + 3_600_000, projectId: "test-project" },
  } }));
  await writeFile(join(dir, "account-router.json"), JSON.stringify({ pools: {
    ag: { provider: "antigravity", source: "antigravity-accounts" },
  } }));
  const id = "gemini-3.8-flash";
  await startup(dir, [antigravityAccounts, accountRouter], [`pool:ag/${id}`, `antigravity-1/${id}`]);
}));
